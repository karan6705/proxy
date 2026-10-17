export type StripeParam = string | number | boolean | null | undefined;

export interface StripeRequestOptions {
  idempotencyKey?: string;
}

export interface StripeRequester {
  request<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    params?: Record<string, StripeParam>,
    options?: StripeRequestOptions,
  ): Promise<T>;
}

export interface StripeClientOptions {
  secretKey?: string;
  apiBase?: string;
  fetch?: typeof globalThis.fetch;
}

export class StripeApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly requestId?: string;

  constructor(
    message: string,
    status: number,
    code?: string,
    requestId?: string,
  ) {
    super(message);
    this.name = "StripeApiError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

function encodeParams(params: Record<string, StripeParam>): URLSearchParams {
  const encoded = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) encoded.set(key, String(value));
  }
  return encoded;
}

export class StripeClient implements StripeRequester {
  private readonly secretKey: string;
  private readonly apiBase: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: StripeClientOptions = {}) {
    const secretKey = options.secretKey ?? process.env.STRIPE_SECRET_KEY;
    if (!secretKey?.startsWith("sk_test_")) {
      throw new Error("STRIPE_SECRET_KEY must be set to a Stripe test-mode key beginning with sk_test_");
    }
    if (!options.fetch && typeof globalThis.fetch !== "function") {
      throw new Error("A fetch implementation is required for Stripe requests");
    }

    this.secretKey = secretKey;
    this.apiBase = (options.apiBase ?? "https://api.stripe.com").replace(/\/$/, "");
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async request<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    params: Record<string, StripeParam> = {},
    options: StripeRequestOptions = {},
  ): Promise<T> {
    const encoded = encodeParams(params);
    const url = new URL(path.startsWith("/") ? `${this.apiBase}${path}` : `${this.apiBase}/${path}`);
    if (method === "GET") url.search = encoded.toString();

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.secretKey}`,
    };
    if (method !== "GET") headers["Content-Type"] = "application/x-www-form-urlencoded";
    if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;

    const response = await this.fetchImpl(url, {
      method,
      headers,
      body: method === "GET" ? undefined : encoded.toString(),
    });
    const payload = (await response.json()) as T & {
      error?: { message?: string; code?: string };
    };
    if (!response.ok) {
      throw new StripeApiError(
        payload.error?.message ?? `Stripe request failed with status ${response.status}`,
        response.status,
        payload.error?.code,
        response.headers.get("request-id") ?? undefined,
      );
    }
    return payload;
  }
}

let defaultClient: StripeClient | undefined;

export function getStripeClient(): StripeClient {
  defaultClient ??= new StripeClient();
  return defaultClient;
}
