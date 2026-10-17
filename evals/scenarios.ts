// The scenarios. The expected results are written by hand from the scenario's story, not copied from the logic's
// output. Start small and add: this is the first five of the ~30 in docs/04-architecture.md.

import { CORRECT_BOOKINGS, DEMO_INTENT, WRONG_BOOKINGS } from "./demo-fixtures.js";
import type { Scenario } from "./scenario.js";
import type { SimBooking } from "./sim.js";

/** When Proxy checks the demo chain: 3h 40m before the flight's 24-hour window closes. */
const DEMO_NOW = "2026-10-18T05:25:00.000Z";

const MISREAD_NOV_3 = {
  goal: DEMO_INTENT.goal,
  constraints: { ...DEMO_INTENT.constraints, dates: { start: "2026-11-03", end: "2026-11-06" } },
};

/** The same trip for Nov 13, booked on Oct 17 like the wrong one, so nothing is wrong. */
const CORRECT_TRIP_OCT_17: SimBooking[] = WRONG_BOOKINGS.map((booking, index) => ({
  ...booking,
  dates: CORRECT_BOOKINGS[index].dates,
  item: CORRECT_BOOKINGS[index].item,
}));

export const SCENARIOS: Scenario[] = [
  {
    id: "S01",
    title: "Wrong date, four-action chain (the demo)",
    group: "wrong date",
    intent: DEMO_INTENT,
    agent_belief: MISREAD_NOV_3,
    assumption: "The agent misread the conference date as Nov 3, so checking its own bookings against what it believes finds nothing.",
    bookings: WRONG_BOOKINGS,
    now: DEMO_NOW,
    human_reply: "UNDO ALL",
    expect: {
      mismatches: [
        { action: "flight", field: "dates" },
        { action: "hotel", field: "dates" },
        { action: "transfer", field: "dates" },
        { action: "host_email", field: "dates" },
      ],
      chains: [{ actions: ["flight", "hotel", "transfer", "host_email"], root: "flight", money_at_risk: 124000 }],
      alert: true,
      // Flight by the 24-hour rule ($412), hotel negotiated to 85% of $640 = $544, transfer by email ($188), host corrected.
      outcomes: { flight: "refund_agreed", hotel: "refund_agreed", transfer: "refund_agreed", host_email: "corrected" },
      agreed_refund_total: 41200 + 54400 + 18800,
    },
  },
  {
    id: "S02",
    title: "Wrong date, flight only, the human keeps it",
    group: "wrong date",
    intent: DEMO_INTENT,
    agent_belief: MISREAD_NOV_3,
    assumption: "The agent misread the conference date as Nov 3.",
    bookings: [WRONG_BOOKINGS[0]],
    now: DEMO_NOW,
    human_reply: "KEEP",
    expect: {
      mismatches: [{ action: "flight", field: "dates" }],
      chains: [{ actions: ["flight"], root: "flight", money_at_risk: 41200 }],
      alert: true,
      outcomes: { flight: "kept" },
      agreed_refund_total: 0,
    },
  },
  {
    id: "S13",
    title: "Flight booked twice after a timeout",
    group: "duplicate",
    intent: DEMO_INTENT,
    assumption: "The first booking call timed out from the agent's side but went through. The agent retried, and only knows about the retry.",
    bookings: [
      { id: "flight", merchant_id: "airline", item: "SFO-JFK", dates: { start: "2026-11-13" }, amount: 41200, booked_at: "2026-10-17T09:00:00.000Z" },
      { id: "flight_retry", merchant_id: "airline", item: "SFO-JFK", dates: { start: "2026-11-13" }, amount: 41200, booked_at: "2026-10-17T09:05:00.000Z" },
    ],
    unseen_by_agent: ["flight"],
    now: "2026-10-17T12:00:00.000Z",
    human_reply: "UNDO ALL",
    expect: {
      // The second booking is the duplicate. The original stays.
      mismatches: [{ action: "flight_retry", field: "duplicate" }],
      chains: [{ actions: ["flight_retry"], root: "flight_retry", money_at_risk: 41200 }],
      alert: true,
      outcomes: { flight_retry: "refund_agreed" },
      agreed_refund_total: 41200,
    },
  },
  {
    id: "S27",
    title: "Correct trip: nothing is wrong",
    group: "correct task",
    intent: DEMO_INTENT,
    assumption: "The agent understood the task and booked it correctly. Every confirmation arrives straight away.",
    bookings: CORRECT_TRIP_OCT_17.map(({ confirm_at: _late, ...booking }) => booking),
    now: DEMO_NOW,
    human_reply: null,
    expect: { mismatches: [], chains: [], alert: false, agreed_refund_total: 0 },
  },
  {
    id: "S28",
    title: "Correct trip, hotel confirmation arrives late: no false alarm",
    group: "correct task",
    intent: DEMO_INTENT,
    assumption: "The agent understood the task and booked it correctly. The hotel's email arrives after the agent has left.",
    bookings: CORRECT_TRIP_OCT_17,
    now: DEMO_NOW,
    human_reply: null,
    expect: { mismatches: [], chains: [], alert: false, agreed_refund_total: 0 },
  },
];
