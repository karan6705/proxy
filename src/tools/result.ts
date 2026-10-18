// Turns a typed tool result into an MCP CallToolResult. Errors follow the error contract
// and set isError so clients skip outputSchema validation.
import type { z } from "zod";
import type { ErrorCode, NextAction, ToolError } from "../types.js";

export interface ToolErrorLog {
  tool: string;
  detail: string;
}

export interface HandlerOptions {
  toolName?: string;
  logError?: (entry: ToolErrorLog) => void;
}

/**
 * `text` is a plain-English answer, sent first so clients that ignore structuredContent (and MCP App views)
 * still get it; the JSON follows as a second block for machine readers.
 */
export function ok<T extends object>(data: T, text?: string) {
  const structuredContent = { ok: true as const, ...data };
  const json = JSON.stringify(structuredContent);
  return {
    content: text ? [{ type: "text" as const, text }, { type: "text" as const, text: json }] : [{ type: "text" as const, text: json }],
    structuredContent,
  };
}

export function fail(code: ErrorCode, message: string, retryable: boolean, next_action: NextAction) {
  const structuredContent: ToolError = { ok: false, code, message, retryable, next_action };
  const plain = `Error (${code}): ${message} ${retryable ? "You can retry." : "Don't retry the same call."} Next: ${next_action.replace(/_/g, " ")}.`;
  return {
    content: [{ type: "text" as const, text: plain }, { type: "text" as const, text: JSON.stringify(structuredContent) }],
    structuredContent,
    isError: true as const,
  };
}

/**
 * Advertises the schema's JSON Schema to clients but lets every input through, so the SDK's
 * plain-text validation error never fires. Handlers validate with `parse` and return the error contract.
 */
export function advertise<S extends z.ZodType>(schema: S): S {
  const std = schema["~standard"];
  return { "~standard": { ...std, validate: (value: unknown) => ({ value }) } } as unknown as S;
}

/**
 * Wraps a tool handler: validates input against `schema` and turns thrown exceptions into the
 * error contract, so every failure an agent sees has code, retryable and next_action.
 */
function redactSecrets(detail: string): string {
  let safe = detail;
  for (const [name, value] of Object.entries(process.env)) {
    if (value && value.length >= 8 && /(?:KEY|SECRET|TOKEN)$/i.test(name)) safe = safe.split(value).join("[REDACTED]");
  }
  return safe;
}

function safeThrownError(error: unknown): ReturnType<typeof fail> {
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  if (code === "stripe_rate_limited" || code === "stripe_unavailable") {
    return fail("upstream_unavailable", "The payment service is temporarily unavailable. Retry shortly.", true, "retry");
  }
  if (code === "stripe_authentication_failed" || code === "stripe_invalid_request") {
    return fail("internal", "The payment service could not complete the request. Don't retry: tell the human the refund step failed, and call get_chain later to see what Stripe shows.", false, "stop");
  }
  return fail("internal", "The tool could not complete the request. Don't retry in a loop: tell the human Proxy hit an error, and give them the task_id or chain_id.", false, "stop");
}

export function handler<S extends z.ZodType, R>(
  schema: S,
  fn: (input: z.output<S>) => Promise<R> | R,
  options: HandlerOptions = {},
) {
  return async (raw: unknown): Promise<R | ReturnType<typeof fail>> => {
    const r = schema.safeParse(raw);
    if (!r.success) {
      const detail = r.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
      return fail("invalid_input", `Invalid arguments: ${detail}. Fix them using the tool's input schema and call again.`, false, "fix_now");
    }
    try {
      return await fn(r.data);
    } catch (e) {
      const detail = redactSecrets(e instanceof Error ? (e.stack ?? e.message) : String(e));
      (options.logError ?? ((entry) => console.error("[tool] handler failed", entry)))({
        tool: options.toolName ?? "unknown",
        detail,
      });
      return safeThrownError(e);
    }
  };
}
