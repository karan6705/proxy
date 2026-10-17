import { DEMO_TASK_EMAIL, DEMO_TASK_ID, demoMismatches } from "../tools/stubs.js";
import type { Action, LogIntentOutput, ReviewOutput, ToolResult, UndoOutput } from "../types.js";
import type { ToolClient } from "./mcp-client.js";
import type { DemoControl } from "./scripted.js";
import type { ConfirmationEnvelope } from "./stub-merchants.js";

export interface OfflineDemoState {
  confirmations: ConfirmationEnvelope[];
  host_actions: Action[];
  ended_tasks: string[];
}

export function createOfflineToolClient(): ToolClient & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async callTool<T>(name: string): Promise<T> {
      calls.push(name);
      if (name === "log_intent") {
        return { ok: true, task_id: DEMO_TASK_ID, task_email: DEMO_TASK_EMAIL } satisfies ToolResult<LogIntentOutput> as T;
      }
      if (name === "review") {
        return {
          ok: true,
          status: "chain_open",
          mismatches: demoMismatches,
          fixable_now: [],
          chain_ids: ["chain_demo"],
          evidence_seen: { emails: 1, stripe_events: 3, actions: 1 },
        } satisfies ToolResult<ReviewOutput> as T;
      }
      if (name === "undo") {
        return { ok: true, accepted: [], requires_human: [], chain_id: null } satisfies ToolResult<UndoOutput> as T;
      }
      throw new Error(`Offline tool ${name} is not implemented`);
    },
    async close() {},
  };
}

export function createOfflineDemoControl(): DemoControl & { readonly state: OfflineDemoState } {
  const state: OfflineDemoState = { confirmations: [], host_actions: [], ended_tasks: [] };
  return {
    state,
    async deliver(envelope) {
      state.confirmations.push(envelope);
    },
    async endSession(taskId) {
      state.ended_tasks.push(taskId);
    },
    async reset() {
      state.confirmations.length = 0;
      state.host_actions.length = 0;
      state.ended_tasks.length = 0;
    },
    async sendHostArrival(action) {
      state.host_actions.push(action);
    },
  };
}
