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
  logError?: (details: StripeErrorLog) => void;
}

export type StripeSafeErrorCode =
  | "stripe_authentication_failed"
  | "stripe_invalid_request"
  | "stripe_rate_limited"
  | "stripe_unavailable";

export interface StripeErrorLog {
  code: StripeSafeErrorCode;
  status?: number;
  stripe_code?: string;
  request_id?: string;
  detail: string;
}

export class StripeApiError extends Error {
  readonly code: StripeSafeErrorCode;

  constructor(code: StripeSafeErrorCode, message: string) {
    super(message);
    this.name = "StripeApiError";
    this.code = code;
  }
}

function safeErrorForStatus(status: number): { code: StripeSafeErrorCode; message: string } {
  if (status === 401 || status === 403) {
    return { code: "stripe_authentication_failed", message: "Stripe authentication failed" };
  }
  if (status === 429) return { code: "stripe_rate_limited", message: "Stripe is temporarily rate limited" };
  if (status >= 500) return { code: "stripe_unavailable", message: "Stripe is temporarily unavailable" };
  return { code: "stripe_invalid_request", message: "Stripe rejected the request" };
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
  private readonly logError: (details: StripeErrorLog) => void;

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
    this.logError = options.logError ?? ((details) => console.error("[stripe] request failed", details));
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

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body: method === "GET" ? undefined : encoded.toString(),
      });
    } catch (error) {
      this.logError({
        code: "stripe_unavailable",
        detail: error instanceof Error ? error.message : String(error),
      });
      throw new StripeApiError("stripe_unavailable", "Stripe is temporarily unavailable");
    }

    let payload: T & { error?: { message?: string; code?: string } };
    try {
      payload = (await response.json()) as typeof payload;
    } catch (error) {
      this.logError({
        code: "stripe_unavailable",
        status: response.status,
        request_id: response.headers.get("request-id") ?? undefined,
        detail: error instanceof Error ? error.message : "Stripe returned an invalid response",
      });
      throw new StripeApiError("stripe_unavailable", "Stripe returned an invalid response");
    }
    if (!response.ok) {
      const safe = safeErrorForStatus(response.status);
      this.logError({
        code: safe.code,
        status: response.status,
        stripe_code: payload.error?.code,
        request_id: response.headers.get("request-id") ?? undefined,
        detail: payload.error?.message ?? `Stripe request failed with status ${response.status}`,
      });
      throw new StripeApiError(safe.code, safe.message);
    }
    return payload;
  }
}

let defaultClient: StripeClient | undefined;

export function getStripeClient(): StripeClient {
  defaultClient ??= new StripeClient();
  return defaultClient;
}
