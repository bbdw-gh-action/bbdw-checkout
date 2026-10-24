import { Inject, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { ApiError } from "./http";
import { IdempotencyStore } from "./idempotency";

type Address = { postalCode: string; street: string; city: string };
type Customer = { id: string; address: Address | null };
type Product = {
  id: string;
  priceCents: number;
  currency: string;
  available: boolean;
};
type OrderInput = {
  customerId: string;
  fulfillment: "pickup" | "delivery";
  items: { productId: string; quantity: number }[];
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function invalid(code: string, message: string): never {
  throw new ApiError(422, code, message);
}
function validate(input: unknown): OrderInput {
  if (
    !record(input) ||
    typeof input.customerId !== "string" ||
    !input.customerId.trim()
  )
    invalid("CUSTOMER_NOT_FOUND", "Selecione um cliente.");
  if (input.fulfillment !== "pickup" && input.fulfillment !== "delivery")
    invalid("INVALID_FULFILLMENT", "Selecione retirada ou entrega.");
  if (!Array.isArray(input.items) || input.items.length === 0)
    invalid("EMPTY_CART", "Adicione um produto ao carrinho.");
  const seen = new Set<string>();
  for (const item of input.items) {
    if (
      !record(item) ||
      typeof item.productId !== "string" ||
      !item.productId.trim()
    )
      invalid("PRODUCT_NOT_FOUND", "Produto inválido.");
    if (
      typeof item.quantity !== "number" ||
      !Number.isInteger(item.quantity) ||
      item.quantity < 1 ||
      item.quantity > 99
    )
      invalid(
        "INVALID_QUANTITY",
        "A quantidade deve ser um inteiro entre 1 e 99.",
      );
    if (seen.has(item.productId))
      invalid("DUPLICATE_PRODUCT", "Agrupe as quantidades do mesmo produto.");
    seen.add(item.productId);
  }
  return input as OrderInput;
}

@Injectable()
export class Dependencies {
  private async get(
    base: string,
    path: string,
    missing: string,
    requestId: string,
  ): Promise<unknown> {
    try {
      const response = await fetch(`${base}${path}`, {
        signal: AbortSignal.timeout(
          Number(process.env.DEPENDENCY_TIMEOUT_MS ?? 2000),
        ),
        headers: { "X-Request-ID": requestId },
      });
      if (response.status === 404)
        throw new ApiError(422, missing, "Cadastro não encontrado.");
      if (!response.ok)
        throw new Error(`Dependência retornou ${response.status}`);
      return await response.json();
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(
        503,
        "DEPENDENCY_UNAVAILABLE",
        "Serviço temporariamente indisponível.",
      );
    }
  }
  async customer(id: string, requestId: string): Promise<Customer> {
    const value = await this.get(
      process.env.USERS_URL ?? "http://localhost:3001",
      `/users/${encodeURIComponent(id)}`,
      "CUSTOMER_NOT_FOUND",
      requestId,
    );
    if (
      !record(value) ||
      value.id !== id ||
      !(
        value.address === null ||
        (record(value.address) &&
          ["postalCode", "street", "city"].every(
            (key) =>
              typeof value.address === "object" &&
              value.address !== null &&
              typeof (value.address as Record<string, unknown>)[key] ===
                "string",
          ))
      )
    )
      throw new ApiError(
        503,
        "DEPENDENCY_UNAVAILABLE",
        "Resposta inválida do serviço de clientes.",
      );
    return value as Customer;
  }
  async product(id: string, requestId: string): Promise<Product> {
    const value = await this.get(
      process.env.CATALOG_URL ?? "http://localhost:3002",
      `/products/${encodeURIComponent(id)}`,
      "PRODUCT_NOT_FOUND",
      requestId,
    );
    if (
      !record(value) ||
      value.id !== id ||
      typeof value.priceCents !== "number" ||
      !Number.isSafeInteger(value.priceCents) ||
      value.priceCents < 0 ||
      value.currency !== "BRL" ||
      typeof value.available !== "boolean"
    )
      throw new ApiError(
        503,
        "DEPENDENCY_UNAVAILABLE",
        "Resposta inválida do catálogo.",
      );
    return value as Product;
  }
}

@Injectable()
export class OrdersService {
  private readonly attempts = new IdempotencyStore<
    Awaited<ReturnType<OrdersService["perform"]>>
  >();
  constructor(
    @Inject(Dependencies) private readonly dependencies: Dependencies,
  ) {}
  async create(
    raw: unknown,
    requestId: string,
    key?: string,
    clientRelease?: string,
  ) {
    const input = validate(raw);
    const fingerprint = JSON.stringify({
      customerId: input.customerId,
      fulfillment: input.fulfillment,
      items: input.items
        .map(({ productId, quantity }) => ({ productId, quantity }))
        .sort((a, b) => a.productId.localeCompare(b.productId)),
    });
    return this.attempts.run(key, fingerprint, requestId, clientRelease, () =>
      this.perform(input, requestId),
    );
  }
  private async perform(input: OrderInput, requestId: string) {
    const customer = await this.dependencies.customer(
      input.customerId,
      requestId,
    );
    if (input.fulfillment === "delivery" && !customer.address)
      invalid(
        "ADDRESS_REQUIRED",
        "Este cliente não possui endereço para entrega.",
      );
    const items = await Promise.all(
      input.items.map(async (item) => {
        const product = await this.dependencies.product(
          item.productId,
          requestId,
        );
        if (!product.available)
          invalid("PRODUCT_UNAVAILABLE", "Produto indisponível.");
        return {
          productId: item.productId,
          quantity: item.quantity,
          unitPriceCents: product.priceCents,
        };
      }),
    );
    const totalCents = items.reduce(
      (total, item) => total + item.unitPriceCents * item.quantity,
      0,
    );
    if (!Number.isSafeInteger(totalCents))
      throw new ApiError(
        503,
        "DEPENDENCY_UNAVAILABLE",
        "Preço fora do limite suportado.",
      );
    return {
      id: randomUUID(),
      customerId: customer.id,
      fulfillment: input.fulfillment,
      deliveryAddress:
        input.fulfillment === "delivery" ? customer.address : null,
      items,
      totalCents,
      currency: "BRL",
      status: "confirmed",
    };
  }
}
