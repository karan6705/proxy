// npm run check-env: one read-only call per service. Prints only OK, MISSING, FAILED or SKIPPED.
// Never prints key values or response bodies. A missing key is reported, never thrown.

type Status = "OK" | "MISSING" | "FAILED" | "SKIPPED";

interface Check {
  name: string;
  run: () => Promise<Status>;
}

const TIMEOUT_MS = 10_000;

function env(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v.trim() === "" ? undefined : v.trim();
}

/** OK on a 2xx. Network errors, timeouts and non-2xx are FAILED. The body is never read out. */
async function probe(url: string, init: RequestInit): Promise<Status> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    await res.body?.cancel();
    return res.ok ? "OK" : "FAILED";
  } catch {
    return "FAILED";
  }
}

const checks: Check[] = [
  {
    name: "STRIPE_SECRET_KEY",
    run: async () => {
      const key = env("STRIPE_SECRET_KEY");
      if (!key) return "MISSING";
      // Test mode only: refuse to even call Stripe with a live or restricted key.
      if (!key.startsWith("sk_test_")) return "FAILED";
      return probe("https://api.stripe.com/v1/balance", { headers: { Authorization: `Bearer ${key}` } });
    },
  },
  {
    name: "STRIPE_WEBHOOK_SECRET",
    // No API can check a signing secret, so only its format is checked.
    run: async () => {
      const secret = env("STRIPE_WEBHOOK_SECRET");
      if (!secret) return "MISSING";
      return secret.startsWith("whsec_") ? "OK" : "FAILED";
    },
  },
  {
    name: "ANTHROPIC_API_KEY",
    run: async () => {
      const key = env("ANTHROPIC_API_KEY");
      if (!key) return "MISSING";
      return probe("https://api.anthropic.com/v1/models?limit=1", {
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
      });
    },
  },
  {
    name: "INKBOX_API_KEY",
    run: async () => {
      const key = env("INKBOX_API_KEY");
      if (!key) return "MISSING";
      return probe("https://inkbox.ai/api/v1/identities", { headers: { "X-API-Key": key } });
    },
  },
  {
    name: "SUPABASE_URL",
    run: async () => {
      const url = env("SUPABASE_URL");
      if (!url) return "MISSING";
      try {
        new URL(url);
        return "OK";
      } catch {
        return "FAILED";
      }
    },
  },
  {
    name: "SUPABASE_SERVICE_ROLE_KEY",
    run: async () => {
      const key = env("SUPABASE_SERVICE_ROLE_KEY");
      if (!key) return "MISSING";
      const url = env("SUPABASE_URL");
      if (!url) return "SKIPPED";
      return probe(`${url.replace(/\/$/, "")}/rest/v1/`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
    },
  },
  {
    name: "MCP_URL",
    // initialize is read-only: it only asks the server to describe itself.
    run: async () => {
      const url = env("MCP_URL");
      if (!url) return "MISSING";
      return probe(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "check-env", version: "1" } },
        }),
      });
    },
  },
  {
    name: "PROXY_DEMO_ROUTES",
    // Optional flag, not a service: unset means off.
    run: async () => {
      const v = env("PROXY_DEMO_ROUTES");
      if (v === undefined) return "SKIPPED";
      return v === "1" || v === "0" ? "OK" : "FAILED";
    },
  },
];

const results = await Promise.all(
  checks.map(async (c) => {
    try {
      return [c.name, await c.run()] as const;
    } catch {
      return [c.name, "FAILED" as Status] as const;
    }
  }),
);

const width = Math.max(...results.map(([name]) => name.length));
for (const [name, status] of results) console.log(`${name.padEnd(width)}  ${status}`);
process.exitCode = results.some(([, s]) => s === "FAILED" || s === "MISSING") ? 1 : 0;
