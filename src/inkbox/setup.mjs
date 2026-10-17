// Creates Proxy's Inkbox identities (idempotent) and registers the one human number allowed to reply.
// Run: node --env-file=.env src/inkbox/setup.mjs        (set HUMAN_PHONE=+1... to register the human number)
// Needs @inkbox/sdk. Prints handles and addresses only, never the key.
import { Inkbox, PhoneRuleAction, PhoneRuleMatchType } from "@inkbox/sdk";

const inkbox = await new Inkbox({ apiKey: process.env.INKBOX_API_KEY }).ready();
const WANT = [
  { handle: "proxy-agent", displayName: "Proxy", imessageEnabled: true, phone: true },
  { handle: "hotel-agent", displayName: "Harborview Hotel agent (demo mock)", a2a: true },
  { handle: "airline", displayName: "Skyline Demo Air agent (demo mock)", a2a: true },
  { handle: "transfer-support", displayName: "Metro Transfer support (demo mock)" },
];

const out = [];
for (const w of WANT) {
  let identity;
  try {
    identity = await inkbox.getIdentity(w.handle);
  } catch {
    identity = await inkbox.createIdentity(w.handle, { displayName: w.displayName, ...(w.imessageEnabled ? { imessageEnabled: true } : {}) });
  }
  if (w.phone && !identity.phoneNumber) await identity.provisionPhoneNumber();
  if (w.a2a) await identity.a2aEnable();
  await identity.refresh?.();
  out.push({ handle: w.handle, email: identity.emailAddress, phone: identity.phoneNumber?.number ?? null });

  if (w.handle === "proxy-agent" && process.env.HUMAN_PHONE) {
    // Only the human's number may text or call Proxy.
    await identity.update({ phoneInboundFilterMode: "whitelist" });
    await identity.createPhoneContactRule({
      action: PhoneRuleAction.ALLOW,
      matchType: PhoneRuleMatchType.EXACT_NUMBER,
      matchTarget: process.env.HUMAN_PHONE,
      direction: "inbound",
    });
    out.at(-1).human_registered = true;
  }
}
console.table(out);
