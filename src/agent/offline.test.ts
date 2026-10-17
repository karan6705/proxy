import { afterEach, describe, expect, it, vi } from "vitest";
import { createOfflineDemoControl, createOfflineToolClient } from "./offline.js";
import { createMockAgentPayments } from "./payments.js";
import { createDemoClock, parseScriptedArgs, runScriptedDemo } from "./scripted.js";

afterEach(() => vi.unstubAllGlobals());

describe("scripted offline mode", () => {
  it("recognizes --offline before or after the command", () => {
    expect(parseScriptedArgs(["--offline"])).toEqual({ command: "run", offline: true });
    expect(parseScriptedArgs(["reset", "--offline"])).toEqual({ command: "reset", offline: true });
  });

  it("completes with mock payments and stub merchants without network calls", async () => {
    const network = vi.fn(async () => {
      throw new Error("network must not be used offline");
    });
    vi.stubGlobal("fetch", network);
    const client = createOfflineToolClient();
    const control = createOfflineDemoControl();
    const payments = createMockAgentPayments();

    const result = await runScriptedDemo({
      client,
      control,
      payments,
      clock: createDemoClock(),
      logger: { log: vi.fn() },
    });

    expect(result.task_id).toBe("task_demo");
    expect(client.calls).toEqual(["log_intent", "review"]);
    expect(payments.charges.size).toBe(3);
    expect(control.state.host_actions).toHaveLength(1);
    expect(control.state.ended_tasks).toEqual(["task_demo"]);
    expect(control.state.confirmations).toHaveLength(3);
    expect(network).not.toHaveBeenCalled();
  });
});
