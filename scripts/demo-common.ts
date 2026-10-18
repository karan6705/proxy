// Shared bits for the demo scripts. Never prints a value from the environment, only names.

export function baseUrl(mcpUrl: string): string {
  return new URL(mcpUrl).origin;
}

export async function waitForHealth(origin: string, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const res = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

export function printUrls(origin: string, mode: string): void {
  console.log(`
Open these for the recording (${mode}):
  Show page       ${origin}/web/show   (npm run demo:show lists the story and presenter URLs)
  Stage page      ${origin}/web/stage
  Widget          ${origin}/mcp/inspector?autoConnect=${origin}/mcp   (Tools > get_chain, with the chain_id from list_chains)
  Demo page       ${origin}/web
  Scoreboard      ${origin}/scoreboard
  Stripe (test)   https://dashboard.stripe.com/test/payments
`);
}
