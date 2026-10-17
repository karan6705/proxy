// Cross-check against the demo fixtures in fixtures/demo (read only): capture must turn each merchant email into the
// Action the fixture's actions.json says it is. Layer 1 evals skip capture, so this is where the two meet.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseStructured } from "./index.js";

const dir = (set: string) => new URL(`../../fixtures/demo/${set}/`, import.meta.url);
const actions = (set: string): { ref: string; category: string; amount: number; dates?: unknown }[] =>
  JSON.parse(readFileSync(new URL("actions.json", dir(set)), "utf8"));

describe.each(["wrong", "correct"])("demo fixtures: %s trip", (set) => {
  it.each(["flight", "hotel", "transfer"])("%s email parses to the fixture's Action", (name) => {
    const html = readFileSync(new URL(`emails/${name}.html`, dir(set)), "utf8");
    const got = parseStructured(html);
    expect(got?.source).toBe("jsonld");
    const want = actions(set).find((a) => a.ref === got?.extraction.ref);
    expect(want).toBeDefined();
    expect(got!.extraction).toMatchObject({ category: want!.category, amount: want!.amount, ref: want!.ref, dates: want!.dates });
  });

  it("the host email carries no markup, so capture cannot turn it into an Action by itself", () => {
    const html = readFileSync(new URL("emails/host_email.html", dir(set)), "utf8");
    expect(parseStructured(html)).toBeNull();
  });
});
