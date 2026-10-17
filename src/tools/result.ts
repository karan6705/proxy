// Turns a typed tool result into an MCP CallToolResult. Errors follow the error contract
// and set isError so clients skip outputSchema validation.
import type { z } from "zod";
import type { ErrorCode, NextAction, ToolError } from "../types.js";

export function ok<T extends object>(data: T) {
  const structuredContent = { ok: true as const, ...data };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

export function fail(code: ErrorCode, message: string, retryable: boolean, next_action: NextAction) {
  const structuredContent: ToolError = { ok: false, code, message, retryable, next_action };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
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
export function handler<S extends z.ZodType, R>(schema: S, fn: (input: z.output<S>) => Promise<R> | R) {
  return async (raw: unknown): Promise<R | ReturnType<typeof fail>> => {
    const r = schema.safeParse(raw);
    if (!r.success) {
      const detail = r.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
      return fail("invalid_input", `Invalid arguments: ${detail}`, false, "fix_now");
    }
    try {
      return await fn(r.data);
    } catch (e) {
      return fail("internal", e instanceof Error ? e.message : String(e), true, "retry");
    }
  };
}
