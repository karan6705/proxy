// Proxy's Inkbox identity: task addresses, text, iMessage, calls, email and A2A.
// INKBOX_DRY_RUN=1 logs what would be sent and sends nothing.
import { makeEvent, DEMO_EVENT_CONTEXT, type EventContext } from "../db/events.js";
import type { Clock, EventKind, Inkbox, OutboundEmail, ProxyProtocolMessage, Store, TaskId } from "../types.js";
import { createClient, loadSdk, type InkboxSdk } from "./sdk.js";

export interface InkboxClientOptions {
  /** Handle of Proxy's own identity, e.g. "proxy-agent"; "proxy" is reserved by Inkbox. Created on first use if missing. */
  handle?: string;
  dryRun?: boolean;
  store?: Store;
  clock?: Clock;
  eventContext?: () => EventContext;
  log?: (line: string) => void;
  /** Injected in tests; defaults to a real client built from INKBOX_API_KEY. */
  sdk?: () => Promise<InkboxSdk>;
  /** Domain used for task addresses in dry-run. */
  dryRunDomain?: string;
}

/** Inkbox handles are lowercase letters, digits and hyphens: task_demo -> task-demo. */
export const handleForTask = (task_id: TaskId): string => task_id.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

const last4 = (n: string) => n.replace(/\D/g, "").slice(-4);

export function createInkbox(opts: InkboxClientOptions = {}): Inkbox {
  const dryRun = opts.dryRun ?? process.env.INKBOX_DRY_RUN === "1";
  const handle = opts.handle ?? process.env.INKBOX_PROXY_HANDLE ?? "proxy-agent";
  const log = opts.log ?? ((l) => console.log(`[inkbox] ${l}`));
  const now = () => opts.clock?.now() ?? new Date().toISOString();
  const ctx = () => (opts.eventContext ?? (() => DEMO_EVENT_CONTEXT))();
  const getSdk = opts.sdk ?? (() => createClient());
  let sdkP: Promise<InkboxSdk> | undefined;
  const sdk = () => (sdkP ??= getSdk());

  let proxyP: Promise<InkboxSdk> | undefined;
  const proxyIdentity = () =>
    (proxyP ??= (async () => {
      const client = await sdk();
      try {
        return await client.getIdentity(handle);
      } catch {
        return client.createIdentity(handle, { displayName: "Proxy", imessageEnabled: true });
      }
    })());

  const record = async (kind: EventKind, outcome: string, ids: { chain_id?: string; action_id?: string; task_id?: string } = {}) => {
    await opts.store?.logEvent(makeEvent(ctx(), now(), { kind, outcome, ...ids }));
  };

  let a2aP: Promise<{ asProxy: InkboxSdk; identity: InkboxSdk }> | undefined;
  let counter = 0;
  const fakeId = (p: string) => `dry_${p}_${++counter}`;

  return {
    async createTaskAddress(task_id) {
      const local = handleForTask(task_id);
      if (dryRun) {
        const task_email = `${task_id}@${opts.dryRunDomain ?? "tasks.proxy.example"}`;
        log(`create task address ${task_email}`);
        return { task_email };
      }
      const client = await sdk();
      try {
        const existing = await client.getIdentity(local);
        return { task_email: existing.emailAddress as string };
      } catch {
        const created = await client.createIdentity(local, { displayName: `Proxy task ${task_id}` });
        return { task_email: created.emailAddress as string };
      }
    },

    async sendText(channel, to, body) {
      const kind: EventKind = channel === "imessage" ? "imessage_out" : "sms_out";
      if (dryRun) {
        log(`${channel} to ***${last4(to)}: ${body}`);
        await record(kind, "dry_run");
        return { message_id: fakeId(channel) };
      }
      try {
        const id = await proxyIdentity();
        const sent = channel === "imessage" ? await id.sendIMessage({ to, text: body }) : await id.sendText({ to, text: body });
        await record(kind, "sent");
        return { message_id: String(sent.id) };
      } catch (err) {
        await record(kind, `failed:${(err as Error).name}`);
        throw err;
      }
    },

    async placeCall(to, script) {
      if (dryRun) {
        log(`call ***${last4(to)}: ${script}`);
        await record("call_out", "dry_run");
        return { call_id: fakeId("call") };
      }
      try {
        const id = await proxyIdentity();
        const call = await id.placeCall({ toNumber: to, mode: "hosted_agent", reason: script });
        await record("call_out", "placed");
        return { call_id: String(call.id ?? call.call?.id ?? "") };
      } catch (err) {
        await record("call_out", `failed:${(err as Error).name}`);
        throw err;
      }
    },

    async sendEmail(email: OutboundEmail) {
      // JSON attachments travel inline so the same evidence reaches support desks that strip attachments.
      const json = (email.attachments ?? []).map((a) => `\n\n--- ${a.filename} ---\n${JSON.stringify(a.json, null, 2)}`).join("");
      if (dryRun) {
        log(`email to ${email.to}: ${email.subject}`);
        await record("email_out", "dry_run");
        return { message_id: fakeId("mail"), thread_id: email.thread_id ?? fakeId("thread") };
      }
      try {
        const id = await proxyIdentity();
        const sent = await id.sendEmail({ to: [email.to], subject: email.subject, bodyText: email.body + json });
        await record("email_out", "sent");
        return { message_id: String(sent.id), thread_id: String(sent.threadId ?? email.thread_id ?? sent.id) };
      } catch (err) {
        await record("email_out", `failed:${(err as Error).name}`);
        throw err;
      }
    },

    async sendProtocolMessage(to_identity, message: ProxyProtocolMessage) {
      const ids = { chain_id: message.chain_id, action_id: message.action_id };
      const payload = JSON.stringify(message);
      if (dryRun) {
        log(`a2a to ${to_identity}: ${message.type}`);
        await record("a2a", `dry_run:${message.type}`, ids);
        return { via: "a2a" as const };
      }
      try {
        const via = await sendA2A(to_identity, payload);
        await record("a2a", `a2a:${message.type}`, ids);
        return { via };
      } catch (a2aErr) {
        // Same JSON by email when the merchant has no A2A endpoint or the call fails.
        const id = await proxyIdentity();
        const peer = await (await sdk()).getIdentity(to_identity);
        await id.sendEmail({ to: [peer.emailAddress], subject: `[proxy:${message.type}] ${message.negotiation_id}`, bodyText: payload });
        await record("a2a", `email_fallback:${message.type}:${(a2aErr as Error).name}`, ids);
        return { via: "email" as const };
      }
    },
  };

  /** A2A needs the sender's own agent-scoped key, minted once and kept in memory only. */
  async function sendA2A(to_identity: string, payload: string): Promise<"a2a"> {
    a2aP ??= (async () => {
      const admin = await sdk();
      const me = await proxyIdentity();
      const { Inkbox } = await loadSdk();
      const apiKey = process.env.INKBOX_PROXY_API_KEY || (await admin.apiKeys.create({ label: "proxy-a2a", scopedIdentityId: me.id })).apiKey;
      const asProxy = await new Inkbox({ apiKey }).ready();
      return { asProxy, identity: await asProxy.getIdentity(handle) };
    })();
    const { asProxy, identity } = await a2aP.catch((e) => {
      a2aP = undefined;
      throw e;
    });
    const dir = await asProxy.a2a.organizationDirectory({ q: to_identity });
    const peer = dir.items.find((i: { cardUrl: string }) => i.cardUrl.includes(`/${to_identity}/`));
    if (!peer) throw new Error(`${to_identity} is not in the A2A directory`);
    const client = await identity.a2aClient();
    await client.send(await client.fetchCard(peer.cardUrl), { text: payload });
    return "a2a";
  }
}
