import { describe, expect, it } from "vitest";
import { findDelivery, isOk, subscriptionProblems } from "./cutover.js";
import { INBOUND_PATHS, listSubscriptions, syncSubscriptions } from "./subscriptions.js";

interface Sub { id: string; url: string; eventTypes: string[]; authToken: string | null; hasAuthToken: boolean; status: string }

function fakeInkbox(initial: Record<string, Sub[]>) {
  const subs: Record<string, Sub[]> = JSON.parse(JSON.stringify(initial));
  const calls: string[] = [];
  let n = 0;
  const ids: Record<string, string> = { "proxy-agent": "id-proxy", "task-demo": "id-task", "airline": "id-air" };
  const handleOf = (id: string) => Object.keys(ids).find((h) => ids[h] === id)!;
  return {
    subs,
    calls,
    async listIdentities() { return Object.keys(ids).map((h) => ({ agentHandle: h })); },
    async getIdentity(handle: string) { return { id: ids[handle], agentHandle: handle }; },
    webhooks: {
      subscriptions: {
        async list(o: { agentIdentityId: string }) { return { items: subs[handleOf(o.agentIdentityId)] ?? [] }; },
        async delete(id: string) { calls.push(`delete ${id}`); for (const h of Object.keys(subs)) subs[h] = subs[h].filter((s) => s.id !== id); },
        async create(o: { agentIdentityId: string; url: string; eventTypes: string[]; authToken: string }) {
          calls.push(`create ${o.url}`);
          (subs[handleOf(o.agentIdentityId)] ??= []).push({ id: `new${++n}`, url: o.url, eventTypes: o.eventTypes, authToken: o.authToken, hasAuthToken: true, status: "active" });
        },
      },
    },
  };
}

const old = (id: string, path: string, events: string[]): Sub => ({ id, url: `https://old.tunnel.example${path}`, eventTypes: events, authToken: "t", hasAuthToken: true, status: "active" });
const start = () => fakeInkbox({
  "proxy-agent": [old("s1", "/inkbox/text", ["text.received"]), old("s2", "/inkbox/imessage", ["imessage.received"]), { ...old("keep", "/something/else", ["message.sent"]) }],
  "task-demo": [old("s3", "/inkbox/inbound", ["message.received"])],
});

describe("syncSubscriptions", () => {
  it("replaces our old subscriptions with ones on the new URL, and leaves other subscriptions alone", async () => {
    const ink = start();
    const report = await syncSubscriptions(ink as never, { baseUrl: "https://new.run.mcp-use.com/", token: "tok", taskHandles: ["task-demo"] });
    expect(report.map((r) => [r.handle, r.url, r.action])).toEqual([
      ["proxy-agent", "https://new.run.mcp-use.com/inkbox/text", "replaced"],
      ["proxy-agent", "https://new.run.mcp-use.com/inkbox/imessage", "replaced"],
      ["task-demo", "https://new.run.mcp-use.com/inkbox/inbound", "replaced"],
    ]);
    expect(ink.subs["proxy-agent"].map((s) => s.url).sort()).toEqual(["https://new.run.mcp-use.com/inkbox/imessage", "https://new.run.mcp-use.com/inkbox/text", "https://old.tunnel.example/something/else"]);
  });

  it("a dry run reports the same changes and makes none", async () => {
    const ink = start();
    const report = await syncSubscriptions(ink as never, { baseUrl: "https://new.run.mcp-use.com", token: "tok", taskHandles: ["task-demo"], dryRun: true });
    expect(report.every((r) => r.action === "would replace")).toBe(true);
    expect(ink.calls).toEqual([]);
    expect(ink.subs["task-demo"][0].url).toBe("https://old.tunnel.example/inkbox/inbound");
  });

  it("a rollback is the same command pointed back at the old URL", async () => {
    const ink = start();
    await syncSubscriptions(ink as never, { baseUrl: "https://new.run.mcp-use.com", token: "tok", taskHandles: ["task-demo"] });
    await syncSubscriptions(ink as never, { baseUrl: "https://old.tunnel.example", token: "tok", taskHandles: ["task-demo"] });
    const mine = (await listSubscriptions(ink as never)).map((s) => s.url).sort();
    expect(mine).toEqual(["https://old.tunnel.example/inkbox/imessage", "https://old.tunnel.example/inkbox/inbound", "https://old.tunnel.example/inkbox/text"]);
  });
});

describe("listSubscriptions", () => {
  it("lists only our inbound paths, says whether a token is set, and never returns it", async () => {
    const rows = await listSubscriptions(start() as never);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.has_token)).toBe(true);
    expect(JSON.stringify(rows)).not.toContain('"authToken"');
    expect(rows.map((r) => r.url).every((u) => INBOUND_PATHS.some((p) => u.endsWith(p)))).toBe(true);
  });
});

describe("cutover helpers", () => {
  const rows = [
    { eventType: "imessage.received", url: "https://new.run.mcp-use.com/inkbox/imessage", responseStatus: 200, createdAt: "2026-10-18T01:00:10.000Z" },
    { eventType: "imessage.received", url: "https://old.tunnel.example/inkbox/imessage", responseStatus: 200, createdAt: "2026-10-18T01:00:20.000Z" },
    { eventType: "imessage.received", url: "https://new.run.mcp-use.com/inkbox/imessage", responseStatus: 401, createdAt: "2026-10-18T00:00:00.000Z" },
  ];
  const since = Date.parse("2026-10-18T01:00:00.000Z");

  it("finds the delivery to the deployed URL made after the alert, not older ones or other hosts", () => {
    const d = findDelivery(rows, { since, baseUrl: "https://new.run.mcp-use.com/", eventTypes: ["imessage.received"] });
    expect(d?.url).toBe("https://new.run.mcp-use.com/inkbox/imessage");
    expect(isOk(d?.responseStatus)).toBe(true);
    expect(findDelivery(rows, { since, baseUrl: "https://nowhere.example", eventTypes: ["imessage.received"] })).toBeNull();
  });

  it("treats only 2xx as success", () => {
    expect([200, 204].map(isOk)).toEqual([true, true]);
    expect([401, 500, null, undefined].map(isOk)).toEqual([false, false, false, false]);
  });

  it("names every subscription still on the old URL or missing a token", () => {
    const subs = [
      { handle: "proxy-agent", url: "https://new.run.mcp-use.com/inkbox/text", has_token: true },
      { handle: "proxy-agent", url: "https://old.tunnel.example/inkbox/imessage", has_token: true },
      { handle: "task-demo", url: "https://new.run.mcp-use.com/inkbox/inbound", has_token: false },
    ];
    expect(subscriptionProblems(subs, "https://new.run.mcp-use.com", [...INBOUND_PATHS])).toEqual([
      "task-demo /inkbox/inbound has no bearer token",
      "proxy-agent /inkbox/imessage still points at https://old.tunnel.example",
    ]);
    expect(subscriptionProblems([], "https://x.example", ["/inkbox/text"])).toEqual(["no subscription for /inkbox/text"]);
  });
});
