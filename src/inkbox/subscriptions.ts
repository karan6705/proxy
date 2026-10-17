// Inkbox delivers webhooks per identity. This keeps Proxy's subscriptions pointed at the current public URL:
//   proxy-agent      text.received -> /inkbox/text, imessage.received -> /inkbox/imessage
//   each task inbox  message.received -> /inkbox/inbound
// A tunnel URL changes on restart, so syncing replaces our old subscriptions instead of adding to them.
import type { InkboxSdk } from "./sdk.js";

export const INBOUND_PATHS = ["/inkbox/inbound", "/inkbox/text", "/inkbox/imessage"] as const;

export interface SyncOptions {
  /** Public base URL of the server, e.g. https://hissing-silver.tunnel.mcp-use.run (no trailing path). */
  baseUrl: string;
  /** Sent back as `Authorization: Bearer <token>` on every delivery; the server checks INKBOX_WEBHOOK_TOKEN. */
  token: string;
  proxyHandle?: string;
  /** Handles of task inboxes that should deliver email to /inkbox/inbound. */
  taskHandles: string[];
}

export interface SyncReport {
  handle: string;
  path: string;
  events: string[];
  action: "created" | "replaced";
}

const pathOf = (url: string): string => {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
};

async function replaceOurs(inkbox: InkboxSdk, identity: InkboxSdk, want: { path: string; events: string[] }[], opts: SyncOptions): Promise<SyncReport[]> {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const existing = await inkbox.webhooks.subscriptions.list({ agentIdentityId: identity.id, scope: "identity" });
  const mine = ((existing.items ?? existing) as { id: string; url: string }[]).filter((s) => (INBOUND_PATHS as readonly string[]).includes(pathOf(s.url)));
  const removed = new Set<string>();
  for (const sub of mine) {
    await inkbox.webhooks.subscriptions.delete(sub.id, { scope: "identity" });
    removed.add(pathOf(sub.url));
  }
  const report: SyncReport[] = [];
  for (const w of want) {
    await inkbox.webhooks.subscriptions.create({ agentIdentityId: identity.id, url: `${base}${w.path}`, eventTypes: w.events, authToken: opts.token });
    report.push({ handle: identity.agentHandle ?? identity.handle, path: w.path, events: w.events, action: removed.has(w.path) ? "replaced" : "created" });
  }
  return report;
}

export async function syncSubscriptions(inkbox: InkboxSdk, opts: SyncOptions): Promise<SyncReport[]> {
  const report: SyncReport[] = [];
  const proxy = await inkbox.getIdentity(opts.proxyHandle ?? "proxy-agent");
  report.push(
    ...(await replaceOurs(inkbox, proxy, [
      { path: "/inkbox/text", events: ["text.received"] },
      { path: "/inkbox/imessage", events: ["imessage.received"] },
    ], opts)),
  );
  for (const handle of opts.taskHandles) {
    report.push(...(await replaceOurs(inkbox, await inkbox.getIdentity(handle), [{ path: "/inkbox/inbound", events: ["message.received"] }], opts)));
  }
  return report;
}

/** For one new task inbox, when the server has a public URL configured. Never throws: a missed subscription is logged. */
export async function subscribeTaskInbox(inkbox: InkboxSdk, handle: string, env: NodeJS.ProcessEnv, log: (line: string) => void): Promise<boolean> {
  const baseUrl = env.INKBOX_PUBLIC_URL?.trim();
  const token = env.INKBOX_WEBHOOK_TOKEN?.trim();
  if (!baseUrl || !token) return false;
  try {
    await replaceOurs(inkbox, await inkbox.getIdentity(handle), [{ path: "/inkbox/inbound", events: ["message.received"] }], { baseUrl, token, taskHandles: [] });
    return true;
  } catch (err) {
    log(`could not subscribe ${handle} to inbound email: ${(err as Error).message}`);
    return false;
  }
}
