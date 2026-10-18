// Verifies the deployed cloud judge copy over plain HTTP. It makes no Inkbox, Stripe, Supabase or Anthropic calls.
//   npx tsx src/inkbox/cloud-verify.ts https://bold-zero-0m4lf.run.mcp-use.com [--commit <sha>] [--health <path>] [--no-demo]
// 1 the status path (default /health) names the new commit and PROXY_MODE=cloud   2 tools/list has seven tools, including try_proxy_demo
// 3 list_chains shows sandbox_example   4 try_proxy_demo finishes at $1,144 of $1,240   5 the Inkbox webhook routes are 404
// 6 timing. --no-demo skips step 4 (it runs the sandbox, which changes the sandbox's in-memory state).
const args = process.argv.slice(2);
const base = args.find((a) => /^https:\/\//.test(a))?.replace(/\/+$/, "");
if (!base) {
  console.error("usage: cloud-verify.ts https://<host> [--commit <sha>] [--no-demo]");
  process.exit(1);
}
const flagValue = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1]?.trim() : undefined;
};
const wantCommit = flagValue("--commit");
// Manufact's gateway answers /health itself, so our own status may have to live on another path.
const healthPath = flagValue("--health") ?? "/health";
const runDemo = !args.includes("--no-demo");
let failed = 0;
const line = (ok: boolean | null, name: string, detail = "") => {
  if (ok === false) failed += 1;
  console.log(`${ok === null ? "SKIP" : ok ? "PASS" : "FAIL"}  ${name}${detail ? `: ${detail}` : ""}`);
};

type Rpc = { result?: Record<string, unknown>; error?: { message?: string } };
let id = 0;
async function rpc(method: string, params: unknown = {}): Promise<{ body: Rpc; ms: number }> {
  const started = Date.now();
  const r = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await r.text();
  return { body: JSON.parse(text.match(/^data: (.*)$/m)?.[1] ?? text), ms: Date.now() - started };
}
const textOf = (r: Rpc): string => JSON.stringify(r.result ?? r.error ?? {});

// 1. Our status endpoint. On Manufact the gateway answers /health with its own {"status":"healthy"}, so ours may need another path.
try {
  const r = await fetch(`${base}${healthPath}`, { signal: AbortSignal.timeout(20_000) });
  const raw = await r.text();
  const flat = raw.toLowerCase();
  const mode = /"(?:proxy_)?mode"\s*:\s*"cloud"/.test(flat) || /proxy_mode["':\s=]+cloud/.test(flat);
  const sha = raw.match(/"(?:commit|sha|git_sha|version_sha)"\s*:\s*"([0-9a-f]{7,40})"/i)?.[1];
  const gateway = healthPath === "/health" && /"status":\s*"healthy"/.test(raw);
  line(r.ok && mode, `${healthPath} reports PROXY_MODE=cloud`, mode ? "" : gateway ? `this is the Manufact gateway's own answer, not our server's; serve ours on another path and pass --health <path> (${raw.slice(0, 70)})` : `body was ${raw.slice(0, 120)}`);
  if (wantCommit) line(!!sha && (sha.startsWith(wantCommit) || wantCommit.startsWith(sha)), `${healthPath} reports commit ${wantCommit}`, sha ? `it says ${sha}` : `no commit field in ${healthPath}`);
  else line(null, `${healthPath} commit`, sha ? `reports ${sha} (pass --commit to check it)` : "no commit field found");
} catch (e) {
  line(false, healthPath, (e as Error).message);
}

// 2. Tools.
let names: string[] = [];
try {
  const { body, ms } = await rpc("tools/list");
  names = ((body.result?.tools as { name: string }[]) ?? []).map((t) => t.name);
  line(names.length === 7 && names.includes("try_proxy_demo"), "tools/list shows seven tools including try_proxy_demo", `${names.length}: ${names.join(", ")} (${ms} ms)`);
} catch (e) {
  line(false, "tools/list", (e as Error).message);
}

// 3. The seeded example.
try {
  const { body } = await rpc("tools/call", { name: "list_chains", arguments: {} });
  line(textOf(body).includes("sandbox_example"), "list_chains shows sandbox_example", textOf(body).slice(0, 140));
} catch (e) {
  line(false, "list_chains", (e as Error).message);
}

// 4. The end-to-end sandbox demo.
if (!runDemo) line(null, "try_proxy_demo", "--no-demo");
else if (!names.includes("try_proxy_demo")) line(false, "try_proxy_demo finishes at $1,144 of $1,240", "the tool does not exist on this server");
else {
  try {
    const { body, ms } = await rpc("tools/call", { name: "try_proxy_demo", arguments: {} });
    const out = textOf(body);
    const ok = /1,?144/.test(out) && /1,?240/.test(out);
    line(ok, "try_proxy_demo finishes at $1,144 of $1,240", `${ok ? "" : out.slice(0, 200)} (${(ms / 1000).toFixed(1)} s)`);
  } catch (e) {
    line(false, "try_proxy_demo", (e as Error).message);
  }
}

// 5. The Inkbox webhooks must not exist on the cloud copy.
for (const path of ["/inkbox/inbound", "/inkbox/text", "/inkbox/imessage"]) {
  try {
    const r = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ event_type: "noop" }), signal: AbortSignal.timeout(20_000) });
    line(r.status === 404, `POST ${path} is 404`, String(r.status));
  } catch (e) {
    line(false, `POST ${path}`, (e as Error).message);
  }
}

// 6. Timing: the first request of this run, then three warm ones.
try {
  const times: number[] = [];
  for (let i = 0; i < 4; i += 1) times.push((await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "cloud-verify", version: "1" } })).ms);
  console.log(`INFO  initialize timing: ${times.join(" ms, ")} ms`);
} catch {
  /* timing is informational */
}
console.log(failed ? `\n${failed} check(s) FAILED.` : "\nAll checks passed.");
process.exit(failed ? 1 : 0);
