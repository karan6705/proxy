import { describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "../db/index.js";
import type { HumanChannel } from "../inkbox/human.js";
import { createWebRoutes } from "./routes.js";
import { SHOW_HTML } from "./show.js";

const HUMAN = "+15555550100";
const route = (routes: ReturnType<typeof createWebRoutes>, method: string, path: string) => routes.find((r) => r.method === method && r.path === path)!;
const req = (rawBody = "", query: Record<string, string> = {}) => ({ method: "POST" as const, path: "", headers: {}, query, rawBody });

describe("/web/show", () => {
  it("serves the page, and its script parses", async () => {
    const routes = createWebRoutes({ store: createMemoryStore(), clock: { mode: "real", now: () => "2026-10-25T14:00:00.000Z", nowMs: () => 0 } as never });
    const res = await route(routes, "GET", "/web/show").handle(req());
    expect(res.status).toBe(200);
    expect(res.body).toBe(SHOW_HTML);
    const script = SHOW_HTML.split("<script>")[1]!.split("</script>")[0]!;
    expect(() => new Function(script)).not.toThrow();
    // Feed text is untrusted: the page writes it with textContent only.
    expect(script).not.toMatch(/innerHTML/);
  });

  it("a choice reply answers an intent question with 1 or 2, like a text", async () => {
    const handleInbound = vi.fn(async () => ({ status: "replied", reason: "intent_answered" }));
    const routes = createWebRoutes({ store: createMemoryStore(), clock: {} as never, channel: { handleInbound } as unknown as HumanChannel, humanNumber: HUMAN, controls: true });
    const reply = route(routes, "POST", "/web/reply");
    expect((await reply.handle(req(JSON.stringify({ kind: "choice", choice: 1 })))).status).toBe(200);
    expect(handleInbound).toHaveBeenCalledWith({ from: HUMAN, body: "1", via: "sms" });
    expect((await reply.handle(req(JSON.stringify({ kind: "choice", choice: 10 })))).status).toBe(400);
    expect((await reply.handle(req(JSON.stringify({ kind: "keep_pushing" })))).status).toBe(200);
    expect(handleInbound).toHaveBeenLastCalledWith({ from: HUMAN, body: "KEEP PUSHING", via: "sms" });
  });
});
