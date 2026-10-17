import type { ActionCategory, Cents, DateRange, Timestamp } from "../types.js";

/** One inbound email, already decoded. `html` carries the schema.org markup when the sender included it. */
export interface InboundEmail {
  /** RFC 5322 Message-ID when known; used to ignore a redelivered webhook. */
  message_id: string;
  from: string;
  to: string[];
  subject: string;
  text: string;
  html?: string;
  received_at?: Timestamp;
}

/** What extraction found, before it becomes an Action. */
export interface Extraction {
  category: ActionCategory;
  /** Name of the business, used to pick the merchant id when the sender is unknown. */
  merchant_name: string | null;
  summary: string;
  amount: Cents;
  dates?: DateRange;
  ref: string;
}

export type ExtractionSource = "jsonld" | "microdata" | "llm";

export interface Extracted {
  extraction: Extraction;
  source: ExtractionSource;
  /** 1 for structured markup. The LLM reports its own. Kept here because Action has no confidence field. */
  confidence: number;
}

/** Fallback for emails with no usable markup. Gets untrusted text and returns null when it finds nothing. */
export type LlmExtractor = (email: InboundEmail) => Promise<{ extraction: Extraction; confidence: number } | null>;
