// Webhook signature check. Inkbox signs every delivery; INKBOX_WEBHOOK_SECRET is the identity's signing key.
import { loadSdk } from "./sdk.js";

export type WebhookVerifier = (rawBody: string, headers: Record<string, string>) => Promise<boolean>;

export function createVerifier(env: NodeJS.ProcessEnv = process.env): WebhookVerifier {
  const secret = env.INKBOX_WEBHOOK_SECRET?.trim();
  // Unsigned deliveries are accepted only in dry-run, where nothing real can be sent or charged.
  if (!secret) return async () => env.INKBOX_DRY_RUN === "1";
  return async (rawBody, headers) => {
    const { verifyWebhook } = await loadSdk();
    try {
      return Boolean(verifyWebhook({ payload: rawBody, headers, secret }));
    } catch {
      return false;
    }
  };
}
