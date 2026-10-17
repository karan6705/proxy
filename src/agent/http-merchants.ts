import type { BookingRequest, BookingResult, Timestamp } from "../types.js";

export interface DemoBookingMerchants {
  book(request: BookingRequest): Promise<BookingResult>;
  releaseConfirmation(ref: string, receivedAt: Timestamp): Promise<void>;
}

interface ConfirmationRef {
  merchant_id: string;
  ref: string;
}

function endpoint(mcpUrl: string, path: string): URL {
  const url = new URL(mcpUrl);
  url.pathname = path;
  url.search = "";
  url.hash = "";
  return url;
}

async function post<T>(url: URL, body: unknown, fetchImpl: typeof fetch): Promise<T> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`POST ${url.pathname} failed (${response.status})`);
  return response.json() as Promise<T>;
}

export function createHttpMerchants(mcpUrl: string, fetchImpl: typeof fetch = fetch): DemoBookingMerchants {
  const refs = new Map<string, ConfirmationRef>();
  return {
    async book(request) {
      const result = await post<BookingResult>(
        endpoint(mcpUrl, `/merchants/${encodeURIComponent(request.merchant_id)}/book`),
        { ...request, defer_confirmation: request.merchant_id === "hotel" },
        fetchImpl,
      );
      refs.set(result.ref, { merchant_id: request.merchant_id, ref: result.ref });
      return result;
    },
    async releaseConfirmation(ref, _receivedAt) {
      const booking = refs.get(ref);
      if (!booking) throw new Error(`No HTTP merchant booking ${ref}`);
      await post(
        endpoint(mcpUrl, `/merchants/${encodeURIComponent(booking.merchant_id)}/confirm`),
        { ref: booking.ref },
        fetchImpl,
      );
    },
  };
}
