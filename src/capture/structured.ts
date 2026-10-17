// Reads schema.org confirmation markup: JSON-LD blocks first, then microdata. No network, no LLM.
import type { ActionCategory, Cents, DateRange } from "../types.js";
import type { Extraction } from "./types.js";

type Json = Record<string, unknown>;

const SCRIPT = /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
const KNOWN = ["FlightReservation", "LodgingReservation", "TaxiReservation", "Order", "Invoice"];

const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => {
  if (typeof v === "string") return v.trim() || undefined;
  if (typeof v === "number") return String(v);
  if (isObj(v)) return str(v.name) ?? str(v["@value"]);
  return undefined;
};
const typeOf = (o: Json): string | undefined => {
  const t = o["@type"];
  const first = Array.isArray(t) ? t.find((x) => typeof x === "string") : t;
  return typeof first === "string" ? first.replace(/^.*[/#]/, "") : undefined;
};

function* walk(v: unknown): Generator<Json> {
  if (Array.isArray(v)) for (const x of v) yield* walk(x);
  else if (isObj(v)) {
    yield v;
    if (v["@graph"]) yield* walk(v["@graph"]);
  }
}

/** "412.00", "$1,240.50", 412 -> cents. Null when it is not a number. */
export function toCents(v: unknown): Cents | null {
  const s = typeof v === "number" ? String(v) : typeof v === "string" ? v.replace(/[^0-9.\-]/g, "") : "";
  if (!s || Number.isNaN(Number(s))) return null;
  return Math.round(Number(s) * 100);
}

/** The calendar date as written ("2026-11-03T08:00:00-05:00" -> "2026-11-03"); no timezone conversion. */
export function toDate(v: unknown): string | undefined {
  const s = str(v);
  return s?.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
}

function range(start: unknown, end?: unknown): DateRange | undefined {
  const s = toDate(start);
  if (!s) return undefined;
  const e = toDate(end);
  return e && e !== s ? { start: s, end: e } : { start: s };
}

function nights(r?: DateRange): string {
  if (!r?.end) return "";
  const n = Math.round((Date.parse(r.end) - Date.parse(r.start)) / 86_400_000);
  return n > 0 ? `, ${n} night${n === 1 ? "" : "s"}` : "";
}

const pretty = (d?: DateRange) => (d ? (d.end ? `${d.start} to ${d.end}` : d.start) : "");

function price(o: Json): Cents | null {
  const spec = isObj(o.priceSpecification) ? o.priceSpecification : undefined;
  const offer = Array.isArray(o.acceptedOffer) ? o.acceptedOffer[0] : o.acceptedOffer;
  return (
    toCents(o.totalPrice) ??
    toCents(o.totalPaymentDue && isObj(o.totalPaymentDue) ? o.totalPaymentDue.price : undefined) ??
    toCents(o.price) ??
    toCents(spec?.price) ??
    (isObj(offer) ? toCents(offer.price) ?? toCents(isObj(offer.priceSpecification) ? offer.priceSpecification.price : undefined) : null)
  );
}

function fromNode(o: Json): Extraction | null {
  const type = typeOf(o);
  if (!type || !KNOWN.includes(type)) return null;
  const ref = str(o.reservationNumber) ?? str(o.orderNumber) ?? str(o.confirmationNumber) ?? str(o.confirmationNumber);
  const amount = price(o);
  if (!ref || amount === null) return null;
  const target = isObj(o.reservationFor) ? o.reservationFor : {};

  let category: ActionCategory;
  let summary: string;
  let merchant_name: string | null = null;
  let dates: DateRange | undefined;

  if (type === "FlightReservation") {
    category = "flight";
    const dep = isObj(target.departureAirport) ? str(target.departureAirport.iataCode) : undefined;
    const arr = isObj(target.arrivalAirport) ? str(target.arrivalAirport.iataCode) : undefined;
    dates = range(target.departureTime);
    const airline = isObj(target.airline) ? target.airline : {};
    merchant_name = str(airline.name) ?? null;
    summary = `Flight ${str(target.flightNumber) ?? ""} ${dep ?? "?"} to ${arr ?? "?"} on ${pretty(dates)}`.replace(/\s+/g, " ");
  } else if (type === "LodgingReservation") {
    category = "hotel";
    dates = range(o.checkinTime ?? o.checkinDate, o.checkoutTime ?? o.checkoutDate);
    merchant_name = str(target.name) ?? null;
    const room = str(o.lodgingUnitDescription);
    summary = `${merchant_name ?? "Hotel"}${room ? `, ${room}` : ""}, ${pretty(dates)}${nights(dates)}`;
  } else if (type === "TaxiReservation") {
    category = "transfer";
    dates = range(o.pickupTime);
    const provider = isObj(target.provider) ? target.provider : {};
    merchant_name = str(provider.name) ?? null;
    const from = isObj(o.pickupLocation) ? str(o.pickupLocation.name) : undefined;
    const to = isObj(o.dropoffLocation) ? str(o.dropoffLocation.name) : undefined;
    summary = `Transfer ${from ?? "?"} to ${to ?? "?"} on ${pretty(dates)}`;
  } else {
    // Order / Invoice: a store purchase, or a SaaS plan when the item looks like a subscription.
    const items = [o.orderedItem, o.acceptedOffer, o.referencesOrder].flat().filter(isObj);
    const names = items.map((i) => str(isObj(i.itemOffered) ? i.itemOffered : i) ?? str(i.name)).filter(Boolean);
    const term = str(o.billingPeriod) ?? str(o.billingDuration) ?? items.map((i) => str(i.billingDuration) ?? str(i.eligibleDuration)).find(Boolean);
    const blob = `${names.join(" ")} ${term ?? ""} ${str(o.description) ?? ""}`;
    category = /subscri|plan|seat|annual|monthly|saas|licen[cs]e/i.test(blob) ? "saas" : "store";
    merchant_name = str(o.seller) ?? str(o.merchant) ?? str(o.provider) ?? str(o.broker) ?? null;
    dates = range(o.orderDate);
    const termText = term ? ` (${/^P1Y|annual|year/i.test(term) ? "annual" : /^P1M|month/i.test(term) ? "monthly" : term})` : "";
    summary = `${names.join(", ") || "Order"}${termText}`;
    if (category === "store") dates = undefined;
  }

  return { category, merchant_name, summary: summary.trim(), amount, ...(dates ? { dates } : {}), ref };
}

export function parseJsonLd(html: string): Extraction | null {
  for (const m of html.matchAll(SCRIPT)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(m[1].trim());
    } catch {
      continue;
    }
    for (const node of walk(parsed)) {
      const found = fromNode(node);
      if (found) return found;
    }
  }
  return null;
}

// --- Microdata: a flat read of itemprop values under an itemtype we know -------------------------------------

const decode = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

function microdataProps(html: string): Map<string, string> {
  const props = new Map<string, string>();
  const tag = /<([a-z0-9]+)\b([^>]*\bitemprop\s*=\s*["']([^"']+)["'][^>]*)>([^<]*)/gi;
  for (const m of html.matchAll(tag)) {
    const attrs = m[2];
    const attr = (n: string) => attrs.match(new RegExp(`\\b${n}\\s*=\\s*["']([^"']*)["']`, "i"))?.[1];
    const value = attr("content") ?? attr("datetime") ?? attr("href") ?? m[4];
    if (value?.trim() && !props.has(m[3])) props.set(m[3], decode(value.trim()));
  }
  return props;
}

export function parseMicrodata(html: string): Extraction | null {
  const type = html.match(/itemtype\s*=\s*["']https?:\/\/schema\.org\/(FlightReservation|LodgingReservation|TaxiReservation|Order)["']/i)?.[1];
  if (!type) return null;
  const p = microdataProps(html);
  const node: Json = {
    "@type": type,
    reservationNumber: p.get("reservationNumber"),
    orderNumber: p.get("orderNumber"),
    totalPrice: p.get("totalPrice") ?? p.get("price"),
    checkinTime: p.get("checkinTime") ?? p.get("checkinDate"),
    checkoutTime: p.get("checkoutTime") ?? p.get("checkoutDate"),
    pickupTime: p.get("pickupTime"),
    orderDate: p.get("orderDate"),
    lodgingUnitDescription: p.get("lodgingUnitDescription"),
    billingDuration: p.get("billingDuration"),
    seller: p.get("seller"),
    reservationFor: {
      name: p.get("name"),
      flightNumber: p.get("flightNumber"),
      departureTime: p.get("departureTime"),
      departureAirport: { iataCode: p.get("departureAirport") },
      arrivalAirport: { iataCode: p.get("arrivalAirport") },
      airline: { name: p.get("airline") },
      provider: { name: p.get("provider") },
    },
    pickupLocation: { name: p.get("pickupLocation") },
    dropoffLocation: { name: p.get("dropoffLocation") },
    orderedItem: p.get("orderedItem") ? { name: p.get("orderedItem") } : undefined,
  };
  return fromNode(node);
}

/** JSON-LD first, then microdata. */
export function parseStructured(html: string): { extraction: Extraction; source: "jsonld" | "microdata" } | null {
  const ld = parseJsonLd(html);
  if (ld) return { extraction: ld, source: "jsonld" };
  const micro = parseMicrodata(html);
  return micro ? { extraction: micro, source: "microdata" } : null;
}
