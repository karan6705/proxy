// Point Inkbox webhooks at the server's current public URL (run again whenever the tunnel URL changes):
//   npx tsx --env-file=.env src/inkbox/subscribe-cli.ts https://<public-host> [task-demo other-task-handle ...]
// Creates INKBOX_WEBHOOK_TOKEN on the first run and saves it to .env and ~/inkbox-webhook-token.env (never printed).
import { randomBytes } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { createClient } from "./sdk.js";
import { syncSubscriptions } from "./subscriptions.js";

const [baseUrl, ...handles] = process.argv.slice(2);
if (!baseUrl || !/^https:\/\//.test(baseUrl)) {
  console.error("usage: subscribe-cli.ts https://<public-host> [task inbox handles...]   (default: task-demo)");
  process.exit(1);
}
let token = process.env.INKBOX_WEBHOOK_TOKEN?.trim();
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
const report = await syncSubscriptions(await createClient(), { baseUrl, token, taskHandles: handles.length ? handles : ["task-demo"] });
console.table(report.map((r) => ({ identity: r.handle, path: r.path, events: r.events.join(","), action: r.action })));
