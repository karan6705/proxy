import { pathToFileURL } from "node:url";
import { DEFAULT_MCP_URL, DEMO_PREFERENCES, DEMO_START } from "./scripted.js";

export interface ResetDemoOptions {
  mcpUrl?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
}

export function assertStripeTestMode(env: NodeJS.ProcessEnv = process.env): void {
  const key = env.STRIPE_SECRET_KEY;
  if (key && !key.startsWith("sk_test_")) {
    throw new Error("Demo reset is disabled unless STRIPE_SECRET_KEY is empty or a Stripe test-mode key");
  }
}

export async function resetDemo(options: ResetDemoOptions = {}): Promise<void> {
  const env = options.env ?? process.env;
  assertStripeTestMode(env);
  const mcpUrl = options.mcpUrl ?? env.MCP_URL ?? DEFAULT_MCP_URL;
  const url = new URL(mcpUrl);
  url.pathname = "/demo/reset";
  url.search = "";
  url.hash = "";
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      clock: DEMO_START,
      preferences: DEMO_PREFERENCES,
    }),
  });
  if (!response.ok) throw new Error(`Demo reset failed (${response.status}): ${await response.text()}`);
}

async function main(): Promise<void> {
  await resetDemo();
  console.log("PASS reset");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
