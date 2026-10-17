import type { EventRow } from "../types.js";

/** The agreed run labels for rows. Evals override these per scenario; demo runs use these fixed values. */
export type EventContext = Pick<EventRow, "run_id" | "arm" | "scenario_id" | "layer">;

export const DEMO_EVENT_CONTEXT: EventContext = {
  run_id: "demo",
  arm: "proxy",
  scenario_id: "demo",
  layer: "scripted",
};

export function makeEvent(
  ctx: EventContext,
  timestamp: string,
  row: Pick<EventRow, "kind"> & Partial<Omit<EventRow, "kind" | keyof EventContext | "timestamp">>,
): EventRow {
  return {
    ...ctx,
    tool_name: null,
    task_id: null,
    chain_id: null,
    action_id: null,
    outcome: null,
    tokens_in: null,
    tokens_out: null,
    ...row,
    timestamp,
  };
}
