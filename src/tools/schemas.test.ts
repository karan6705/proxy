import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as schemas from "./schemas.js";

/** Every input parameter, nested ones included, that has no description for the agent to read. */
function undescribed(node: Record<string, unknown>, path: string, out: string[] = []): string[] {
  const props = node.properties as Record<string, Record<string, unknown>> | undefined;
  for (const [key, child] of Object.entries(props ?? {})) {
    if (!child.description) out.push(`${path}.${key}`);
    undescribed(child, `${path}.${key}`, out);
  }
  if (node.items) undescribed(node.items as Record<string, unknown>, `${path}[]`, out);
  return out;
}

describe("tool input schemas", () => {
  it("describe every parameter", () => {
    const inputs = Object.entries(schemas).filter(([name]) => name.endsWith("Input"));
    expect(inputs.length).toBe(7);
    const missing = inputs.flatMap(([name, schema]) => undescribed(z.toJSONSchema(schema as z.ZodType) as Record<string, unknown>, name));
    expect(missing).toEqual([]);
  });
});
