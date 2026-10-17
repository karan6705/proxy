import { pathToFileURL } from "node:url";
import type { SimulatedClock } from "../types.js";
import { connectToolClient, type ToolClient } from "./mcp-client.js";
import { createHttpMerchants } from "./http-merchants.js";
import { createOfflineDemoControl, createOfflineToolClient } from "./offline.js";
import { createDemoPayments, createMockAgentPayments, type AgentPayments } from "./payments.js";
import { resetDemo } from "./reset.js";
import {
  createDemoClock,
  createHttpDemoControl,
  DEFAULT_MCP_URL,
  runScriptedDemo,
  SCRIPTED_DEMO_STEPS,
  type DemoControl,
  type ScriptedStepResult,
} from "./scripted.js";

export const DEMO_TIME_LIMIT_MS = 3 * 60_000;

export interface RehearsalResult {
  passed: boolean;
  total_ms: number;
  steps: Array<ScriptedStepResult | { step: "reset" | "connect"; status: "PASS" | "FAIL"; duration_ms: number; error?: string }>;
}

export interface RehearsalOptions {
  offline?: boolean;
  mcpUrl?: string;
  client?: ToolClient;
  control?: DemoControl;
  payments?: AgentPayments;
  clock?: SimulatedClock;
  reset?: () => Promise<void>;
  connect?: () => Promise<ToolClient>;
  now?: () => number;
  write?: (line: string) => void;
}

type SetupStep = RehearsalResult["steps"][number];

export async function runRehearsal(options: RehearsalOptions = {}): Promise<RehearsalResult> {
  const offline = options.offline ?? false;
  const mcpUrl = options.mcpUrl ?? process.env.MCP_URL ?? DEFAULT_MCP_URL;
  const now = options.now ?? (() => performance.now());
  const write = options.write ?? console.log;
  const control = options.control ?? (offline ? createOfflineDemoControl() : createHttpDemoControl(mcpUrl));
  const steps: SetupStep[] = [];
  const totalStarted = now();
  let client = options.client;

  function report(result: SetupStep): void {
    steps.push(result);
    const detail = result.error ? ` — ${result.error}` : "";
    write(`${result.status} ${result.step} ${Math.round(result.duration_ms)}ms${detail}`);
  }

  async function setupStep(name: "reset" | "connect", run: () => Promise<void>): Promise<void> {
    const started = now();
    try {
      await run();
      report({ step: name, status: "PASS", duration_ms: Math.max(0, now() - started) });
    } catch (error) {
      report({
        step: name,
        status: "FAIL",
        duration_ms: Math.max(0, now() - started),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  let failure: unknown;
  try {
    await setupStep("reset", async () => {
      if (options.reset) await options.reset();
      else if (offline) await control.reset();
      else await resetDemo({ mcpUrl });
    });
    await setupStep("connect", async () => {
      client ??= options.connect ? await options.connect() : offline ? createOfflineToolClient() : await connectToolClient(mcpUrl);
    });
    await runScriptedDemo({
      client: client!,
      payments: options.payments ?? (offline ? createMockAgentPayments() : createDemoPayments()),
      ...(offline ? {} : { merchants: createHttpMerchants(mcpUrl) }),
      clock: options.clock ?? createDemoClock(),
      control,
      onStep: report,
      now,
    });
  } catch (error) {
    failure = error;
  } finally {
    await client?.close().catch(() => undefined);
  }

  const reported = new Set(steps.map((item) => item.step));
  for (const step of ["reset", "connect", ...SCRIPTED_DEMO_STEPS] as const) {
    if (!reported.has(step)) report({ step, status: "FAIL", duration_ms: 0, error: "not run" });
  }
  const totalMs = Math.max(0, now() - totalStarted);
  const passed = failure === undefined && steps.every((item) => item.status === "PASS") && totalMs <= DEMO_TIME_LIMIT_MS;
  write(`${passed ? "PASS" : "FAIL"} total ${Math.round(totalMs)}ms / ${DEMO_TIME_LIMIT_MS}ms`);
  return { passed, total_ms: totalMs, steps };
}

async function main(): Promise<void> {
  const result = await runRehearsal({ offline: process.argv.slice(2).includes("--offline") });
  if (!result.passed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
