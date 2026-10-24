import "reflect-metadata";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import * as Sentry from "@sentry/node";
import { createApp } from "../src/app";
import { Dependencies } from "../src/orders";
import { IdempotencyStore } from "../src/idempotency";
import { initTelemetry } from "../src/telemetry";

test("reserva antes dos awaits, 409 único no Sentry, replay e contrato sem chave", async () => {
  const envelopes: string[] = [];
  const collector = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    envelopes.push(Buffer.concat(chunks).toString());
    res.writeHead(200).end("{}");
  });
  await new Promise<void>((resolve) =>
    collector.listen(0, "127.0.0.1", resolve),
  );
  process.env.SENTRY_DSN = `http://public@127.0.0.1:${(collector.address() as AddressInfo).port}/1`;
  process.env.SENTRY_RELEASE = "a".repeat(40);
  process.env.DEMO_SCENARIO = "CHK-003";
  initTelemetry();
  const app = await createApp();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  let calls = 0;
  const dependencies = app.get(Dependencies);
  dependencies.customer = async (id) => {
    calls++;
    started();
    await pending;
    return { id, address: null };
  };
  dependencies.product = async (id) => ({
    id,
    priceCents: 4000,
    currency: "BRL",
    available: true,
  });
  const input = {
    customerId: "never-publish-customer",
    fulfillment: "pickup",
    items: [{ productId: "product-standard", quantity: 2 }],
  };
  try {
    await app.listen(0, "127.0.0.1");
    const url = `${await app.getUrl()}/orders`;
    const post = (key?: string, body = input) =>
      fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Client-Release": "b".repeat(40),
          ...(key === undefined ? {} : { "Idempotency-Key": key }),
        },
        body: JSON.stringify(body),
      });
    const first = post("never-publish-key");
    await entered;
    const duplicates = await Promise.all([
      post("never-publish-key"),
      post("never-publish-key"),
    ]);
    for (const response of duplicates) {
      assert.equal(response.status, 409);
      assert.equal((await response.json()).error.code, "CHECKOUT_IN_PROGRESS");
    }
    assert.equal(calls, 1);
    const conflict = await post("never-publish-key", {
      ...input,
      items: [{ productId: "product-standard", quantity: 3 }],
    });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).error.code, "IDEMPOTENCY_CONFLICT");
    release();
    const response = await first;
    assert.equal(response.status, 201);
    const order = await response.json();
    assert.equal(order.totalCents, 8000);
    assert.equal(order.deliveryAddress, null);
    assert.deepEqual(await (await post("never-publish-key")).json(), order);
    assert.equal(calls, 1);
    const without = await (await post()).json();
    assert.notEqual(without.id, order.id);
    assert.notEqual((await (await post()).json()).id, without.id);
    assert.equal((await post("invalid key")).status, 422);
    assert.equal(await Sentry.flush(3000), true);
    const events = envelopes
      .flatMap((envelope) =>
        envelope
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line)),
      )
      .filter((item) => item.exception);
    assert.equal(events.length, 1);
    const event = events[0];
    assert.equal(event.exception.values[0].type, "CheckoutInProgressError");
    assert.equal(event.tags.error_code, "CHECKOUT_IN_PROGRESS");
    assert.equal(event.tags.client_release, "b".repeat(40));
    assert.equal(event.tags.service, "bbdw-checkout");
    assert.equal(event.request, undefined);
    assert.equal(event.user, undefined);
    assert.ok(!JSON.stringify(event).includes("never-publish"));
    const cors = await fetch(url, {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:3000",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "idempotency-key,x-client-release",
      },
    });
    assert.match(
      cors.headers.get("Access-Control-Allow-Headers")!,
      /Idempotency-Key/i,
    );
  } finally {
    release();
    await app.close();
    await Sentry.close(2000);
    collector.closeAllConnections();
    await new Promise<void>((resolve) => collector.close(() => resolve()));
    delete process.env.SENTRY_DSN;
  }
});

test("limite e dez minutos de retenção; falhas liberam a mesma chave", async () => {
  let now = 0;
  const store = new IdempotencyStore<string>(() => now, 1);
  const run = (key: string, operation: () => Promise<string>) =>
    store.run(key, "same-content", "request", undefined, operation);
  await assert.rejects(
    run("first", async () => {
      throw new Error("dependency failed");
    }),
  );
  assert.equal(await run("first", async () => "order-1"), "order-1");
  await assert.rejects(
    run("second", async () => "order-2"),
    /instantes/,
  );
  now = 599999;
  assert.equal(await run("first", async () => "wrong"), "order-1");
  now = 600000;
  assert.equal(await run("second", async () => "order-2"), "order-2");
});

test("atraso de ensaio ocorre depois da reserva, sem duplicar a operação", async () => {
  process.env.CHECKOUT_DEMO_DELAY_MS = "50";
  const store = new IdempotencyStore<number>();
  let calls = 0;
  try {
    const first = store.run(
      "key",
      "input",
      "first",
      undefined,
      async () => ++calls,
    );
    assert.equal(calls, 0);
    await assert.rejects(
      store.run("key", "input", "second", undefined, async () => ++calls),
      /processamento/,
    );
    assert.equal(await first, 1);
    assert.equal(calls, 1);
  } finally {
    delete process.env.CHECKOUT_DEMO_DELAY_MS;
  }
});
