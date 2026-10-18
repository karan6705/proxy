// The mock merchants (airline, hotel, transfer, the host who gets corrections, a SaaS vendor, a store and Northwind Market) and the HTTP routes
// Karan mounts in server.ts.
// createMerchants() implements the Merchants interface from types.ts; merchantRoutes() exposes it as RouteHandlers.

import type {
  BookingResult,
  Cents,
  Clock,
  DateRange,
  MerchantAgent,
  MerchantId,
  MerchantInfo,
  Merchants,
  ProxyProtocolMessage,
  RouteHandler,
  RouteResponse,
  SelfServeCancelResult,
  Timestamp,
} from "../types.js";
import { createAirline } from "./airline.js";
import type { BookInput, CarrierScan, MerchantDeps, MerchantModule, ReturnsPortal, SupportEmail, SupportReply } from "./deps.js";
import { createHost } from "./host.js";
import { createNorthwind } from "./northwind.js";
import { createSaas } from "./saas.js";
import { createStore } from "./store.js";
import type { AddressMode } from "./identities.js";
import { type HotelAgentOptions, createHotel } from "./hotel.js";
import { MerchantError, type MerchantErrorKind, type MerchantOrder, OrderBook } from "./orders.js";
import { createTransfer } from "./transfer.js";

export type {
  CarrierScan,
  MerchantDeps,
  MerchantEmail,
  ReturnFieldId,
  ReturnForm,
  ReturnFormField,
  ReturnLabel,
  ReturnReceipt,
  ReturnSubmit,
  ReturnsPortal,
  SupportEmail,
  SupportReply,
} from "./deps.js";
export { NORTHWIND_CATALOG, NORTHWIND_INFO, RETURN_LABEL_DAYS } from "./northwind.js";
export { qrMatrix, qrSvgPath } from "./qr.js";
export type { HotelAgentOptions, HotelBehavior } from "./hotel.js";
export { colorEnabled, formatLine, formatSpeaker, narrateExchange, narrateFromProxy, narrateSupport, narrateToProxy, oneLine } from "./narrate.js";
export type { ExchangeOptions } from "./narrate.js";
export { MerchantError } from "./orders.js";
export type { MerchantOrder } from "./orders.js";
export { createFakeDeps } from "./fakes.js";
export { createInkboxDeliver } from "./inkbox-deliver.js";
export type { InkboxDeliverOptions, InkboxLike } from "./inkbox-deliver.js";
export {
  IdentityKeys,
  MERCHANT_IDENTITIES,
  addressFor,
  addressMode,
  identityFor,
  loadIdentityKeys,
} from "./identities.js";
export type { AddressMode, KeyStatus, MerchantIdentity } from "./identities.js";
export type { FakeCharge, FakeDeps } from "./fakes.js";

export interface MerchantsImpl extends Merchants {
  /** Same as Merchants.book, plus `defer_confirmation` to send the confirmation email later. */
  book(request: BookInput): Promise<BookingResult>;
  /** Sends the confirmation for a booking made with defer_confirmation. Returns false if already sent. */
  sendConfirmation(merchant_id: MerchantId, ref: string): Promise<boolean>;
  /** An email to the merchant's support desk. Only merchants with a desk and no agent handle these. */
  supportEmail(merchant_id: MerchantId, email: SupportEmail, now: Timestamp): Promise<SupportReply>;
  hasSupportDesk(merchant_id: MerchantId): boolean;
  getOrder(ref: string): MerchantOrder | null;
  /** The merchant's web return form, when it takes returns that way (Northwind Market). */
  returnPortal(merchant_id: MerchantId): ReturnsPortal | null;
  /** What the merchant charges for an item, or null when it does not sell it. */
  quote(merchant_id: MerchantId, item: string): Cents | null;
  /** True for a merchant simulated only in this process (Northwind Market): never reached through Inkbox. */
  inProcess(merchant_id: MerchantId): boolean;
  /** Calls `listener` whenever the simulated carrier scans a returned package. */
  onCarrierScan(listener: (scan: CarrierScan) => void): void;
}

export interface CreateMerchantsOptions {
  hotel?: HotelAgentOptions;
  /**
   * "test" (the default) uses the .example addresses, as every test and default run does. "real" uses the real
   * @inkboxmail.com addresses, for end-to-end runs only. addressMode() reads MERCHANT_ADDRESS_MODE.
   */
  addresses?: AddressMode;
  /**
   * The simulated carrier that scans returned packages. `scan_delay_ms` is how long after a return label it scans
   * (leave it out for never: tests call nothing and wait for nothing). `advance` moves a simulated clock a day.
   */
  carrier?: { scan_delay_ms: number; advance?: (ms: number) => void };
}

export function createMerchants(deps: MerchantDeps, options: CreateMerchantsOptions = {}): MerchantsImpl {
  const ctx = { deps, orders: new OrderBook() };
  const mode = options.addresses ?? "test";
  const scanListeners: Array<(scan: CarrierScan) => void> = [];
  const modules: MerchantModule[] = [
    createAirline(ctx, mode),
    createHotel(ctx, options.hotel, mode),
    createTransfer(ctx, mode),
    createHost(ctx),
    createSaas(ctx),
    createStore(ctx),
    createNorthwind(ctx, {
      ...(options.carrier ? { scan_delay_ms: options.carrier.scan_delay_ms, advance: options.carrier.advance } : {}),
      onScan: (scan) => scanListeners.forEach((listener) => listener(scan)),
    }),
  ];
  const byId = new Map(modules.map((module) => [module.info.merchant_id, module]));

  const need = (merchant_id: MerchantId): MerchantModule => {
    const module = byId.get(merchant_id);
    if (!module) {
      throw new MerchantError("not_found", `Unknown merchant: ${merchant_id}`);
    }
    return module;
  };

  return {
    list: (): MerchantInfo[] => modules.map((module) => module.info),
    get: (merchant_id) => byId.get(merchant_id)?.info ?? null,
    book: (request) => need(request.merchant_id).book(request),
    selfServeCancel: (merchant_id, ref, now) => need(merchant_id).selfServeCancel(ref, now),
    agent: (merchant_id): MerchantAgent | null => byId.get(merchant_id)?.agent ?? null,
    sendConfirmation: (merchant_id, ref) => need(merchant_id).sendConfirmation(ref),
    supportEmail: async (merchant_id, email, now) => {
      const module = need(merchant_id);
      if (!module.handleSupportEmail) {
        throw new MerchantError("invalid_input", `${merchant_id} has no support desk`);
      }
      return module.handleSupportEmail(email, now);
    },
    hasSupportDesk: (merchant_id) => Boolean(byId.get(merchant_id)?.handleSupportEmail),
    getOrder: (ref) => ctx.orders.get(ref),
    inProcess: (merchant_id) => byId.get(merchant_id)?.in_process === true,
    returnPortal: (merchant_id) => byId.get(merchant_id)?.returns ?? null,
    quote: (merchant_id, item) => byId.get(merchant_id)?.quote?.(item) ?? null,
    onCarrierScan: (listener) => {
      scanListeners.push(listener);
    },
  };
}

// ---------------------------------------------------------------------------
// HTTP routes
// ---------------------------------------------------------------------------

const STATUS: Record<MerchantErrorKind, number> = {
  invalid_input: 400,
  not_found: 404,
  conflict: 409,
  upstream_unavailable: 502,
};

const PROXY_MESSAGE_TYPES: ReadonlySet<string> = new Set(["request_reversal", "accept_counter", "push_back", "ask_human"]);

function json(status: number, body: object): RouteResponse {
  return { status, headers: { "content-type": "application/json" }, body };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(rawBody: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(rawBody.trim() === "" ? "{}" : rawBody);
    return isRecord(value) ? value : null;
  } catch {
    // Not JSON: the caller answers 400.
    return null;
  }
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

async function guarded(path: string, run: () => Promise<RouteResponse>): Promise<RouteResponse> {
  try {
    return await run();
  } catch (cause) {
    if (cause instanceof MerchantError) {
      return json(STATUS[cause.kind], { error: cause.kind, message: cause.message });
    }
    console.error("merchant route failed", { path, message: cause instanceof Error ? cause.message : String(cause) });
    return json(500, { error: "internal", message: "Unexpected error" });
  }
}

function toBookInput(merchant_id: MerchantId, body: Record<string, unknown>, fallbackBookedAt: Timestamp): BookInput {
  const dates = body.dates;
  const range: DateRange | undefined = isRecord(dates)
    ? { start: asString(dates.start), ...(typeof dates.end === "string" ? { end: dates.end } : {}) }
    : undefined;
  return {
    merchant_id,
    task_id: asString(body.task_id),
    task_email: asString(body.task_email),
    item: asString(body.item),
    dates: range,
    amount: typeof body.amount === "number" ? body.amount : Number.NaN,
    booked_at: typeof body.booked_at === "string" ? body.booked_at : fallbackBookedAt,
    defer_confirmation: body.defer_confirmation === true,
  };
}

/**
 * Routes for every merchant, all under /merchants/. `clock` supplies "now" (the simulated clock in evals).
 *   GET  /merchants                       list merchants
 *   POST /merchants/<id>/book             book (charges Stripe, emails the confirmation to the task address)
 *   POST /merchants/<id>/confirm          send a deferred confirmation   { ref }
 *   POST /merchants/<id>/cancel           self-serve cancel              { ref }
 *   POST /merchants/<id>/agent            merchants with an agent: answer one Proxy protocol message
 *   POST /merchants/<id>/support          merchants with a support desk: an email to support  { from, subject, body }
 */
export function merchantRoutes(merchants: MerchantsImpl, deps: MerchantDeps, clock: Clock): RouteHandler[] {
  const routes: RouteHandler[] = [
    {
      method: "GET",
      path: "/merchants",
      handle: async () => json(200, { merchants: merchants.list() }),
    },
  ];

  for (const info of merchants.list()) {
    const base = `/merchants/${info.merchant_id}`;
    const withBody = (path: string, run: (body: Record<string, unknown>) => Promise<RouteResponse>): RouteHandler["handle"] =>
      (req) =>
        guarded(path, async () => {
          const body = parseJson(req.rawBody);
          return body ? run(body) : json(400, { error: "invalid_input", message: "Body must be a JSON object" });
        });

    routes.push({
      method: "POST",
      path: `${base}/book`,
      handle: withBody(`${base}/book`, async (body) => {
        const result = await merchants.book(toBookInput(info.merchant_id, body, clock.now()));
        return json(200, result);
      }),
    });

    routes.push({
      method: "POST",
      path: `${base}/confirm`,
      handle: withBody(`${base}/confirm`, async (body) => {
        const sent = await merchants.sendConfirmation(info.merchant_id, asString(body.ref));
        return json(200, { sent });
      }),
    });

    routes.push({
      method: "POST",
      path: `${base}/cancel`,
      handle: withBody(`${base}/cancel`, async (body) => {
        const result: SelfServeCancelResult = await merchants.selfServeCancel(info.merchant_id, asString(body.ref), clock.now());
        return json(200, result);
      }),
    });

    if (info.has_agent) {
      routes.push({
        method: "POST",
        path: `${base}/agent`,
        handle: withBody(`${base}/agent`, async (body) => {
          const wellFormed =
            PROXY_MESSAGE_TYPES.has(asString(body.type)) &&
            typeof body.negotiation_id === "string" &&
            typeof body.round === "number" &&
            (body.type !== "request_reversal" || (isRecord(body.order) && typeof body.order.ref === "string"));
          if (!wellFormed) {
            return json(400, { error: "invalid_input", message: "Body must be a Reversal Protocol message from Proxy" });
          }
          const agent = merchants.agent(info.merchant_id);
          if (!agent) {
            return json(404, { error: "not_found", message: `${info.merchant_id} has no agent` });
          }
          return json(200, await agent.respond(body as unknown as ProxyProtocolMessage, clock.now()));
        }),
      });
    }

    if (merchants.hasSupportDesk(info.merchant_id)) {
      routes.push({
        method: "POST",
        path: `${base}/support`,
        handle: withBody(`${base}/support`, async (body) => {
          const email: SupportEmail = { from: asString(body.from), subject: asString(body.subject), body: asString(body.body) };
          if (!email.from.includes("@")) {
            return json(400, { error: "invalid_input", message: "from must be an email address" });
          }
          const reply = await merchants.supportEmail(info.merchant_id, email, clock.now());
          try {
            await deps.deliver({ ...reply.reply, identity: info.merchant_id });
          } catch (cause) {
            throw new MerchantError("upstream_unavailable", `Could not deliver the support reply: ${cause instanceof Error ? cause.message : String(cause)}`);
          }
          return json(200, {
            approved: reply.approved,
            ref: reply.ref,
            refund_amount: reply.refund_amount,
            reply_subject: reply.reply.subject,
            reply_body: reply.reply.body,
          });
        }),
      });
    }
  }

  return routes;
}
