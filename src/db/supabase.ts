// Supabase-backed Store over PostgREST with plain fetch. Server side only: needs the service role key.
import type { Action, Chain, EventRow, EvidenceSeen, Intent, Lesson, Step, Store } from "../types.js";

export interface SupabaseConfig {
  url: string;
  serviceRoleKey: string;
  fetchImpl?: typeof fetch;
}

type Row = Record<string, unknown>;

const iso = (v: unknown): string => new Date(v as string).toISOString();
const isoOrNull = (v: unknown): string | null => (v == null ? null : iso(v));

export function createSupabaseStore(config: SupabaseConfig): Store {
  const base = `${config.url.replace(/\/$/, "")}/rest/v1`;
  const doFetch = config.fetchImpl ?? fetch;
  const headers = {
    apikey: config.serviceRoleKey,
    Authorization: `Bearer ${config.serviceRoleKey}`,
    "Content-Type": "application/json",
  };

  async function call(path: string, init: RequestInit & { prefer?: string } = {}): Promise<Response> {
    const { prefer, ...rest } = init;
    const res = await doFetch(`${base}/${path}`, {
      ...rest,
      headers: { ...headers, ...(prefer ? { Prefer: prefer } : {}) },
    });
    if (!res.ok) {
      // Never include the key; the PostgREST error body is safe to surface.
      throw new Error(`Supabase ${init.method ?? "GET"} ${path.split("?")[0]} failed: ${res.status} ${await res.text()}`);
    }
    return res;
  }
  const select = async (path: string): Promise<Row[]> => (await call(path)).json() as Promise<Row[]>;
  const upsert = (table: string, row: Row, onConflict: string) =>
    call(`${table}?on_conflict=${onConflict}`, {
      method: "POST",
      body: JSON.stringify(row),
      prefer: "resolution=merge-duplicates,return=minimal",
    });
  const count = async (table: string, filter: string): Promise<number> => {
    const res = await call(`${table}?select=*&${filter}`, { method: "HEAD", prefer: "count=exact" });
    const total = res.headers.get("content-range")?.split("/")[1];
    return total && total !== "*" ? Number(total) : 0;
  };
  const eq = (v: string) => `eq.${encodeURIComponent(v)}`;

  const toIntent = (r: Row): Intent => ({
    task_id: r.task_id as string,
    task_email: r.task_email as string,
    goal: r.goal as string,
    constraints: r.constraints as Intent["constraints"],
    preferences: r.preferences as Intent["preferences"],
    created_at: iso(r.created_at),
  });
  const toAction = (r: Row): Action => ({
    action_id: r.action_id as string,
    task_id: r.task_id as string,
    merchant: r.merchant as string,
    category: r.category as Action["category"],
    summary: r.summary as string,
    amount: Number(r.amount),
    ...(r.dates ? { dates: r.dates as Action["dates"] } : {}),
    ref: r.ref as string,
    source: r.source as Action["source"],
    received_at: iso(r.received_at),
    state: r.state as Action["state"],
  });
  const toStep = (r: Row): Step => ({
    chain_id: r.chain_id as string,
    action_id: r.action_id as string,
    route: r.route as Step["route"],
    protocol_state: (r.protocol_state as Step["protocol_state"]) ?? null,
    round: Number(r.round),
    message: r.message as string,
    outcome: r.outcome as Step["outcome"],
    stripe_ref: (r.stripe_ref as string | null) ?? null,
    at: iso(r.at),
  });
  const toChain = (r: Row, steps: Step[]): Chain => ({
    chain_id: r.chain_id as string,
    task_id: r.task_id as string,
    root_action_id: r.root_action_id as string,
    action_ids: r.action_ids as string[],
    money_at_risk: Number(r.money_at_risk),
    window_ends_at: isoOrNull(r.window_ends_at),
    state: r.state as Chain["state"],
    alerts: r.alerts as Chain["alerts"],
    plan: r.plan as Chain["plan"],
    steps,
  });
  const stepsFor = async (chain_id: string) =>
    (await select(`steps?chain_id=${eq(chain_id)}&order=id.asc`)).map(toStep);

  return {
    async putIntent(intent, idempotency_key) {
      const existing = await this.getIntentByIdempotencyKey(idempotency_key);
      if (existing) return existing;
      await call("intents", {
        method: "POST",
        body: JSON.stringify({ ...intent, idempotency_key }),
        prefer: "return=minimal",
      });
      return intent;
    },
    async getIntent(task_id) {
      const [r] = await select(`intents?task_id=${eq(task_id)}`);
      return r ? toIntent(r) : null;
    },
    async getIntentByIdempotencyKey(key) {
      const [r] = await select(`intents?idempotency_key=${eq(key)}`);
      return r ? toIntent(r) : null;
    },
    async listActions(task_id) {
      return (await select(`actions?task_id=${eq(task_id)}&order=received_at.asc`)).map(toAction);
    },
    async getAction(action_id) {
      const [r] = await select(`actions?action_id=${eq(action_id)}`);
      return r ? toAction(r) : null;
    },
    async upsertAction(action) {
      await upsert("actions", { ...action, dates: action.dates ?? null }, "action_id");
      return action;
    },
    async getChain(chain_id) {
      const [r] = await select(`chains?chain_id=${eq(chain_id)}`);
      return r ? toChain(r, await stepsFor(chain_id)) : null;
    },
    async listChains(task_id) {
      const rows = await select(`chains?${task_id ? `task_id=${eq(task_id)}&` : ""}order=chain_id.asc`);
      return Promise.all(rows.map(async (r) => toChain(r, await stepsFor(r.chain_id as string))));
    },
    async upsertChain(chain) {
      const { steps, ...row } = chain;
      await upsert("chains", row, "chain_id");
      return { ...chain, steps };
    },
    async appendStep(step) {
      await call("steps", { method: "POST", body: JSON.stringify(step), prefer: "return=minimal" });
    },
    async listLessons(): Promise<Lesson[]> {
      return (await select("lessons?order=created_at.asc")).map((r) => ({
        mistake_code: r.mistake_code as string,
        what_happened: r.what_happened as string,
        lesson: r.lesson as string,
        created_at: iso(r.created_at),
      }));
    },
    async addLesson(lesson) {
      await upsert("lessons", { ...lesson }, "mistake_code");
    },
    async countEvidence(task_id): Promise<EvidenceSeen> {
      const [emails, stripe_events, actions] = await Promise.all([
        count("events", `task_id=${eq(task_id)}&kind=eq.email_in`),
        count("events", `task_id=${eq(task_id)}&kind=eq.stripe_event`),
        count("actions", `task_id=${eq(task_id)}`),
      ]);
      return { emails, stripe_events, actions };
    },
    async logEvent(row: EventRow) {
      // Insert only. The table's trigger also rejects updates and deletes.
      await call("events", { method: "POST", body: JSON.stringify(row), prefer: "return=minimal" });
    },
  };
}
