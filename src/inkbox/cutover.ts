// Pure helpers for the post-cutover live check (cutover-check.ts).

export interface DeliveryRow {
  eventType: string;
  url: string;
  responseStatus: number | null;
  createdAt: Date | string;
  errorDetail?: string | null;
}

/** The newest delivery of one of `eventTypes`, made after `since`, to a URL under `baseUrl`. */
export function findDelivery(rows: DeliveryRow[], opts: { since: number; baseUrl: string; eventTypes: string[] }): DeliveryRow | null {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const hits = rows
    .filter((r) => opts.eventTypes.includes(r.eventType) && r.url.startsWith(`${base}/`) && Date.parse(String(r.createdAt)) >= opts.since)
    .sort((a, b) => Date.parse(String(b.createdAt)) - Date.parse(String(a.createdAt)));
  return hits[0] ?? null;
}

export const isOk = (status: number | null | undefined): boolean => typeof status === "number" && status >= 200 && status < 300;

/** Whether every expected path has a subscription under `baseUrl` with a token set. Returns the problems found. */
export function subscriptionProblems(
  subs: { handle: string; url: string; has_token: boolean }[],
  baseUrl: string,
  expectedPaths: string[],
): string[] {
  const base = baseUrl.replace(/\/+$/, "");
  const problems: string[] = [];
  for (const path of expectedPaths) {
    const mine = subs.filter((s) => s.url.endsWith(path));
    if (!mine.length) problems.push(`no subscription for ${path}`);
    for (const s of mine) {
      if (!s.url.startsWith(`${base}/`)) problems.push(`${s.handle} ${path} still points at ${s.url.replace(path, "")}`);
      if (!s.has_token) problems.push(`${s.handle} ${path} has no bearer token`);
    }
  }
  return problems;
}
