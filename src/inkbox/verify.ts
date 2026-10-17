// Webhook authentication. Inkbox sends two things with every delivery, and either one is enough:
//   - a bearer token we set on the subscription (INKBOX_WEBHOOK_TOKEN). One token covers every identity, which
//     matters because each task gets its own identity and each identity has its own signing key.
//   - a signature made with an identity's signing key (INKBOX_WEBHOOK_SECRET, one or more keys separated by commas).
import { timingSafeEqual } from "node:crypto";
import { loadSdk } from "./sdk.js";

export type WebhookVerifier = (rawBody: string, headers: Record<string, string>) => Promise<boolean>;

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function createVerifier(env: NodeJS.ProcessEnv = process.env): WebhookVerifier {
  const secrets = (env.INKBOX_WEBHOOK_SECRET ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const token = env.INKBOX_WEBHOOK_TOKEN?.trim();
  // Unsigned deliveries are accepted only in dry-run, where nothing real can be sent or charged.
  if (!secrets.length && !token) return async () => env.INKBOX_DRY_RUN === "1";
  return async (rawBody, headers) => {
    if (token) {
      const bearer = (headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      if (bearer && sameToken(bearer, token)) return true;
    }
    if (!secrets.length) return false;
    const { verifyWebhook } = await loadSdk();
    for (const secret of secrets) {
      try {
        if (verifyWebhook({ payload: rawBody, headers, secret })) return true;
      } catch {
        // try the next key
      }
    }
    return false;
  };
}
