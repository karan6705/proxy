// The intent check from the human's own words, applied to what a live agent logged.
//
// The server's log_intent takes original_request (the human's words). Its deterministic parser (checkIntent, no
// model) reads dates and a budget from it and compares them with the agent's constraints. On a disagreement the
// server texts the human "Your agent understood X. You said Y. Reply 1 for Y or 2 for X." and stores the answer.
//
// Here the same checkIntent runs in process, and the human's answer is SIMULATED as 1: they choose their own words.
// So a catch is only as real as the parser: if it cannot read the request, it says "agrees" and nothing changes.

import type { Intent } from "../../src/types.js";
import { checkIntent } from "../../src/orchestrator/intent-words.js";

export interface IntentCheckOutcome {
  status: "absent" | "agrees" | "disagrees";
  understood?: string;
  said?: string;
  /** What Proxy compares receipts with afterwards: the agent's logged intent, corrected when the human's words disagree. */
  intent: Pick<Intent, "goal" | "constraints"> | null;
}

export function applyIntentCheck(
  logged: Pick<Intent, "goal" | "constraints"> | null,
  originalRequest: string | null | undefined,
  year: number,
): IntentCheckOutcome {
  if (!logged) {
    return { status: "absent", intent: null };
  }
  const check = checkIntent(logged.constraints, originalRequest ?? undefined, year);
  if (check.status !== "disagrees") {
    return { status: check.status, intent: logged };
  }
  const corrected = check.corrected ?? {};
  return {
    status: "disagrees",
    understood: check.understood,
    said: check.said,
    intent: {
      goal: logged.goal,
      constraints: {
        ...logged.constraints,
        ...(corrected.dates ? { dates: corrected.dates } : {}),
        ...(corrected.budget_total !== undefined ? { budget_total: corrected.budget_total } : {}),
      },
    },
  };
}
