// The rest of the demo after the agent leaves, over HTTP against a running server (PROXY_DEMO_ROUTES=1):
// the one alert, UNDO ALL from the demo page, the hotel negotiated and refunded, the chain finished, and the
// redo for the right dates. Each step reads GET /demo/feed and reports PASS or FAIL.

export const HUMAN_PHASE_STEPS = ["alert", "undo_all", "hotel_refund", "all_done", "redone"] as const;
export type HumanPhaseStep = (typeof HUMAN_PHASE_STEPS)[number];

interface FeedEntry {
  actor: string;
  kind: string;
  text: string;
  data: Record<string, unknown>;
}
interface Feed {
  task_id: string | null;
  chain: { chain_id: string; state: string; total: number; recovered: number } | null;
  entries: FeedEntry[];
}

export interface HumanPhaseOptions {
  mcpUrl: string;
  fetchImpl?: typeof fetch;
  report(step: HumanPhaseStep, status: "PASS" | "FAIL", duration_ms: number, detail?: string): void;
  now?: () => number;
  /** Per step. The hotel step allows for a slow agent and the email follow-up. */
  timeouts?: Partial<Record<HumanPhaseStep, number>>;
}

const DEFAULT_TIMEOUTS: Record<HumanPhaseStep, number> = { alert: 20_000, undo_all: 10_000, hotel_refund: 150_000, all_done: 60_000, redone: 60_000 };

export async function runHumanPhase(options: HumanPhaseOptions): Promise<boolean> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => performance.now());
  const url = (path: string) => new URL(path, options.mcpUrl);
  const feed = async (): Promise<Feed> => (await (await fetchImpl(url("/demo/feed"))).json()) as Feed;
  const waitFor = async <T>(step: HumanPhaseStep, find: (f: Feed) => T | undefined | null | false): Promise<T> => {
    const until = now() + (options.timeouts?.[step] ?? DEFAULT_TIMEOUTS[step]);
    for (;;) {
      const found = find(await feed());
      if (found) return found;
      if (now() > until) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 500));
    }
  };

  let ok = true;
  let skip = false;
  const step = async <T>(name: HumanPhaseStep, run: () => Promise<{ value: T; detail?: string }>): Promise<T | undefined> => {
    if (skip) {
      options.report(name, "FAIL", 0, "not run");
      return undefined;
    }
    const started = now();
    try {
      const { value, detail } = await run();
      options.report(name, "PASS", now() - started, detail);
      return value;
    } catch (e) {
      ok = false;
      skip = true;
      options.report(name, "FAIL", now() - started, e instanceof Error ? e.message : String(e));
      return undefined;
    }
  };

  const chain_id = await step("alert", async () => {
    const alert = await waitFor("alert", (f) => f.entries.find((e) => e.kind === "text_out" && e.data.alert === "chain_opened"));
    const f = await feed();
    if (!f.chain) throw new Error("no chain in the feed");
    return { value: f.chain.chain_id, detail: alert.text };
  });
  await step("undo_all", async () => {
    const res = await fetchImpl(url("/web/reply"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chain_id, kind: "undo_all" }) });
    if (!res.ok) throw new Error(`/web/reply answered ${res.status}`);
    const got = await waitFor("undo_all", (f) => f.entries.find((e) => e.kind === "text_out" && /^Got it/.test(e.text)));
    return { value: true, detail: got.text };
  });
  await step("hotel_refund", async () => {
    const e = await waitFor("hotel_refund", (f) => f.entries.find((x) => x.kind === "stripe_refund" && /Hotel/.test(x.text)));
    const said = (await feed()).entries.filter((x) => x.kind === "protocol_in" || x.kind === "protocol_out").map((x) => x.data.type).join(" > ");
    return { value: true, detail: `${e.text} (${said})` };
  });
  await step("all_done", async () => {
    const e = await waitFor("all_done", (f) => f.entries.find((x) => x.kind === "text_out" && /^(All done|Partly done)/.test(x.text)));
    if (!e.text.startsWith("All done")) throw new Error(e.text);
    return { value: true, detail: e.text };
  });
  await step("redone", async () => {
    const e = await waitFor("redone", (f) => f.chain?.state === "redone" && f.entries.find((x) => x.kind === "text_out" && /^Rebooked/.test(x.text)));
    return { value: true, detail: e.text };
  });
  return ok;
}
