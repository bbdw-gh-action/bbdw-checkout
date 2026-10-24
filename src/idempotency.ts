import { createHash } from "node:crypto";
import { ApiError } from "./http";
import { captureServerError } from "./telemetry";

type Attempt<T> = {
  fingerprint: string;
  requestId: string;
  expires: number;
  pending: boolean;
  reported: boolean;
  result?: T;
};
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

export class CheckoutInProgressError extends ApiError {
  constructor() {
    super(
      409,
      "CHECKOUT_IN_PROGRESS",
      "Esta compra já está em processamento. Aguarde e tente novamente.",
    );
  }
}

// Reserva síncrona por instância. Não oferece garantia entre processos ou reinícios.
export class IdempotencyStore<T> {
  private readonly attempts = new Map<string, Attempt<T>>();
  constructor(
    private readonly now = Date.now,
    private readonly limit = 1000,
  ) {}

  async run(
    key: string | undefined,
    fingerprint: string,
    requestId: string,
    clientRelease: string | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (key === undefined) return operation();
    if (!/^[a-zA-Z0-9._-]{1,128}$/.test(key))
      throw new ApiError(
        422,
        "INVALID_IDEMPOTENCY_KEY",
        "Chave de compra inválida.",
      );
    for (const [id, attempt] of this.attempts) {
      if (!attempt.pending && attempt.expires <= this.now())
        this.attempts.delete(id);
    }
    const previous = this.attempts.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new ApiError(
          409,
          "IDEMPOTENCY_CONFLICT",
          "A chave já identifica outra compra.",
        );
      if (!previous.pending) return previous.result as T;
      const error = new CheckoutInProgressError();
      if (!previous.reported) {
        previous.reported = true;
        captureServerError(error, hash(requestId), {
          error_code: "CHECKOUT_IN_PROGRESS",
          idempotency_key_hash: hash(key),
          first_request_id_hash: hash(previous.requestId),
          client_release:
            clientRelease && /^[a-f0-9]{40}$/.test(clientRelease)
              ? clientRelease
              : "unknown",
        });
      }
      throw error;
    }
    if (this.attempts.size >= this.limit)
      throw new ApiError(
        503,
        "IDEMPOTENCY_CAPACITY",
        "Tente novamente em alguns instantes.",
      );
    const attempt: Attempt<T> = {
      fingerprint,
      requestId,
      expires: Infinity,
      pending: true,
      reported: false,
    };
    this.attempts.set(key, attempt);
    try {
      const delay = Number(process.env.CHECKOUT_DEMO_DELAY_MS ?? 0);
      if (Number.isFinite(delay) && delay > 0)
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(delay, 5000)),
        );
      attempt.result = await operation();
      attempt.pending = false;
      attempt.expires = this.now() + 10 * 60 * 1000;
      return attempt.result;
    } catch (error) {
      this.attempts.delete(key);
      throw error;
    }
  }
}
