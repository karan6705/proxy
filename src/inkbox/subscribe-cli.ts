// Point Inkbox webhooks at the server's current public URL (run again whenever the URL changes):
//   npx tsx --env-file=.env src/inkbox/subscribe-cli.ts https://<public-host> [task-demo other-task-handle ...]
//   ... --dry-run     show what would be replaced or created, change nothing
//   ... --list        show the current subscriptions (identity, events, URL, token set or not; never the token)
// Creates INKBOX_WEBHOOK_TOKEN on the first run and saves it to .env and ~/inkbox-webhook-token.env (never printed).
import { randomBytes } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { createClient } from "./sdk.js";
import { listSubscriptions, syncSubscriptions } from "./subscriptions.js";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const [baseUrl, ...handles] = args.filter((a) => !a.startsWith("--"));

if (flag("--list")) {
  const rows = await listSubscriptions(await createClient());
  console.table(rows.map((r) => ({ identity: r.handle, events: r.events.join(","), url: r.url, token: r.has_token ? "set" : "MISSING", status: r.status })));
  process.exit(0);
}
if (!baseUrl || !/^https:\/\//.test(baseUrl)) {
  console.error("usage: subscribe-cli.ts https://<public-host> [task inbox handles...] [--dry-run]   (default: task-demo)   |   subscribe-cli.ts --list");
  process.exit(1);
}
const dryRun = flag("--dry-run");
let token = process.env.INKBOX_WEBHOOK_TOKEN?.trim();
if (!token && dryRun) {
  console.error("INKBOX_WEBHOOK_TOKEN is not set; a real run would create one.");
  token = "dry-run";
}
if (!token) {
  token = randomBytes(32).toString("hex");
  const envPath = ".env";
  const rest = readFileSync(envPath, "utf8").split("\n").filter((l) => l && !l.startsWith("INKBOX_WEBHOOK_TOKEN=")).join("\n");
  writeFileSync(envPath, `${rest}\nINKBOX_WEBHOOK_TOKEN=${token}\n`);
  const out = `${homedir()}/inkbox-webhook-token.env`;
  writeFileSync(out, `INKBOX_WEBHOOK_TOKEN=${token}\n`);
  chmodSync(out, 0o600);
  console.log(`created INKBOX_WEBHOOK_TOKEN (saved to .env and ${out})`);
}
const report = await syncSubscriptions(await createClient(), { baseUrl, token, taskHandles: handles.length ? handles : ["task-demo"], dryRun });
console.table(report.map((r) => ({ identity: r.handle, events: r.events.join(","), url: r.url, action: r.action })));
if (dryRun) console.log("Dry run: nothing was changed.");
