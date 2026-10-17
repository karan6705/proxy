// Inkbox capability probe. Run: node --env-file=.env src/inkbox/check.mjs (needs @inkbox/sdk). Creates and deletes two throwaway identities.
// Env: INKBOX_API_KEY (required), HUMAN_PHONE (E.164, enables SMS/iMessage/call checks), CHECK_CALL=1 (places a real call).
import { Inkbox } from "@inkbox/sdk";

const results = {};
const record = (name, status, detail) => {
  results[name] = { status, detail };
  console.log(`${status.toUpperCase().padEnd(7)} ${name}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
};
const check = async (name, fn) => {
  try {
    const detail = await fn();
    if (detail && detail.skip) record(name, "skipped", detail.skip);
    else record(name, "ok", detail ?? "");
  } catch (e) {
    record(name, "fail", `${e?.name ?? "Error"}: ${e?.message ?? e}`);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = Date.now().toString(36);
const humanPhone = process.env.HUMAN_PHONE;

if (!process.env.INKBOX_API_KEY) {
  console.error("Set INKBOX_API_KEY first.");
  process.exit(1);
}
const inkbox = await new Inkbox({ apiKey: process.env.INKBOX_API_KEY }).ready();
let a, b;

await check("auth_whoami", async () => (await inkbox.whoami?.()) ?? "client ready");

// 1. Unique address per task: one identity (and mailbox) per task.
await check("unique_address_per_identity", async () => {
  a = await inkbox.createIdentity(`pxchk-a-${run}`, { displayName: "Proxy check A", imessageEnabled: true });
  b = await inkbox.createIdentity(`pxchk-b-${run}`, { displayName: "Proxy check B" });
  return { a: a.emailAddress, b: b.emailAddress };
});

// 2. Email send + receive between the two identities.
await check("email_send_receive", async () => {
  if (!a || !b) return { skip: "identities not created" };
  const subject = `probe ${run}`;
  await a.sendEmail({ to: [b.emailAddress], subject, bodyText: "probe body" });
  for (let i = 0; i < 12; i++) {
    for await (const m of b.iterEmails()) if (m.subject === subject) return { delivered_after_s: i * 5 };
    await sleep(5000);
  }
  throw new Error("not received in 60s");
});

// 3. Plus-address / alias on one inbox (fallback if unique addresses are limited).
await check("plus_address_delivery", async () => {
  if (!a || !b) return { skip: "identities not created" };
  const [local, domain] = b.emailAddress.split("@");
  const subject = `plus probe ${run}`;
  await a.sendEmail({ to: [`${local}+task1@${domain}`], subject, bodyText: "plus probe" });
  for (let i = 0; i < 12; i++) {
    for await (const m of b.iterEmails()) if (m.subject === subject) return { to_seen: m.toAddresses ?? m.to ?? "n/a" };
    await sleep(5000);
  }
  throw new Error("plus-addressed mail not received in 60s");
});

// 4. Inbound email webhook subscription.
await check("webhook_subscription", async () => {
  if (!b) return { skip: "identities not created" };
  const url = process.env.WEBHOOK_URL;
  if (!url) return { skip: "set WEBHOOK_URL to test" };
  const sub = await inkbox.webhooks.subscriptions.create({ scope: "identity", identityHandle: b.agentHandle ?? b.handle, url, eventTypes: ["message.received"] });
  await inkbox.webhooks.subscriptions.delete(sub.id, { scope: "identity" });
  return { id: sub.id };
});

// 5. Phone number + SMS.
await check("phone_provision", async () => {
  if (!a) return { skip: "identity not created" };
  const phone = await a.provisionPhoneNumber();
  return { number: phone.number, smsStatus: phone.smsStatus };
});
await check("sms_send", async () => {
  if (!humanPhone) return { skip: "set HUMAN_PHONE" };
  const t = await a.sendText({ to: humanPhone, text: `Proxy probe ${run}. Reply START then UNDO ALL to test inbound.` });
  return { id: t.id, deliveryStatus: t.deliveryStatus };
});
await check("sms_receive", async () => {
  if (!humanPhone) return { skip: "set HUMAN_PHONE" };
  console.log("  -> reply to the probe text now (waiting 90s)");
  for (let i = 0; i < 18; i++) {
    const inbound = (await a.listTexts({ limit: 10 })).filter((t) => t.remotePhoneNumber === humanPhone && t.direction !== "outbound");
    if (inbound.length) return { text: inbound[0].text };
    await sleep(5000);
  }
  throw new Error("no inbound text in 90s");
});

// 6. iMessage (shared router: human must text 'connect @handle' first).
await check("imessage_router", async () => {
  if (!a) return { skip: "identity not created" };
  const router = await inkbox.imessages.getTriageNumber();
  return { number: router.number, connectCommand: router.connectCommand.replace("my-agent", a.agentHandle ?? "") };
});
await check("imessage_send", async () => {
  if (!a) return { skip: "identity not created" };
  const convos = (await a.listIMessageConversations({ limit: 20 })).filter((c) => c.assignmentStatus === "active");
  if (!convos.length) return { skip: "no connected human yet; text the connect command to the router number" };
  await a.sendIMessage({ conversationId: convos[0].id, text: `Proxy probe ${run}` });
  return { conversation: convos[0].id };
});

// 7. Outbound phone call (opt-in; places a real call).
await check("phone_call", async () => {
  if (!humanPhone || process.env.CHECK_CALL !== "1") return { skip: "set HUMAN_PHONE and CHECK_CALL=1" };
  const call = await a.placeCall({ toNumber: humanPhone, mode: "hosted_agent", reason: "Proxy probe call. Say hello and hang up." });
  return { status: call.status };
});

// 8. A2A between the two identities, using each identity's own agent-scoped key (admin keys are rejected).
let aScoped, bScoped;
await check("a2a_scoped_keys", async () => {
  if (!a || !b) return { skip: "identities not created" };
  const ka = await inkbox.apiKeys.create({ label: `pxchk-a-${run}`, scopedIdentityId: a.id });
  const kb = await inkbox.apiKeys.create({ label: `pxchk-b-${run}`, scopedIdentityId: b.id });
  aScoped = await new Inkbox({ apiKey: ka.apiKey ?? ka.key ?? ka.secret }).ready();
  bScoped = await new Inkbox({ apiKey: kb.apiKey ?? kb.key ?? kb.secret }).ready();
  return { keys: "created", shape: Object.keys(ka).filter((k) => !/key|secret/i.test(k)) };
});
await check("a2a_send", async () => {
  if (!aScoped) return { skip: "scoped keys not created" };
  const aId = await aScoped.getIdentity(a.agentHandle ?? a.handle);
  const bId = await bScoped.getIdentity(b.agentHandle ?? b.handle);
  await bId.a2aSetReceiverEnabled?.(true);
  const dir = await aScoped.a2a.organizationDirectory({ q: b.agentHandle ?? b.handle });
  const item = dir.items[0];
  if (!item) throw new Error("peer not in organization directory");
  const client = await aId.a2aClient();
  const target = await client.fetchCard(item.cardUrl);
  const res = await client.send(target, { text: JSON.stringify({ type: "request_reversal", probe: run }) });
  return { sent: true, card: item.cardUrl, resultKeys: typeof res === "object" ? Object.keys(res) : String(res) };
});
await check("a2a_receive", async () => {
  if (!bScoped) return { skip: "scoped keys not created" };
  const bId = await bScoped.getIdentity(b.agentHandle ?? b.handle);
  for (let i = 0; i < 6; i++) {
    const page = await bId.a2aTasks({ limit: 5 });
    if (page.items?.length) return { tasks: page.items.length, state: page.items[0].state };
    await sleep(5000);
  }
  throw new Error("peer saw no A2A task in 30s");
});

// Cleanup.
for (const id of [a, b]) {
  try { await id?.delete(); } catch (e) { console.log("cleanup failed:", e?.message ?? e); }
}
console.log("\n" + JSON.stringify(results, null, 2));
