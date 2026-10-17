import type { Capture } from "./capture.js";
import type { InboundEmail } from "./types.js";

export { createCapture, MIN_LLM_CONFIDENCE, type Capture, type CaptureDeps, type CaptureResult } from "./capture.js";
export { createAnthropicExtractor, parseLlmAnswer } from "./llm.js";
export { parseStructured, parseJsonLd, parseMicrodata } from "./structured.js";
export { createInboundEmailRoute, type InboundEmailRouteOptions } from "./webhook.js";
export type { Extracted, Extraction, InboundEmail, LlmExtractor } from "./types.js";

/** Shape of a mock merchant's email (src/merchants/deps.ts), without importing that folder. */
interface MerchantLike {
  from: { name: string; address: string };
  to: string;
  subject: string;
  body: string;
  html: string;
}

/** For the mock merchants' `deliver`: straight into capture, same path as a real inbound email. */
export function deliverToCapture(capture: Capture) {
  return async (email: MerchantLike): Promise<void> => {
    const inbound: InboundEmail = {
      message_id: `${email.to}|${email.subject}`,
      from: email.from.address,
      to: [email.to],
      subject: email.subject,
      text: email.body,
      html: email.html,
    };
    await capture.handleEmail(inbound);
  };
}
