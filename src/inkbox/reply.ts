// Turns a human's text into an intent. Strict on purpose: "undo all except the hotel" is NOT undo_all.

export type ParsedReply =
  | { kind: "undo_all" }
  /** `picks` is set when the numbers came in the same message ("PICK 1 3"). */
  | { kind: "pick"; picks?: number[] }
  | { kind: "keep" }
  /** Bare numbers, the answer to the PICK list. */
  | { kind: "numbers"; picks: number[] }
  | { kind: "yes" }
  | { kind: "no" }
  /** STOP and its synonyms: freezes all undo activity until the human replies again. */
  | { kind: "stop" }
  /** START, UNSTOP, HELP: the carrier answers these; never forwarded or answered. */
  | { kind: "carrier" }
  | { kind: "unknown" };

const normalize = (body: string) =>
  body
    .normalize("NFKC")
    .toUpperCase()
    .replace(/[^A-Z0-9, ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

function numbersOf(s: string): number[] | null {
  // "1 3", "1,3", "1, 3", "1 AND 3"
  const cleaned = s.replace(/\bAND\b/g, " ").replace(/,/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned || !/^\d+( \d+)*$/.test(cleaned)) return null;
  const nums = [...new Set(cleaned.split(" ").map(Number))];
  return nums.every((n) => n >= 1 && n <= 99) ? nums : null;
}

export function parseReply(body: string): ParsedReply {
  const s = normalize(body);
  if (/^(UNDO ?ALL|UNDO EVERYTHING|UNDO)$/.test(s)) return { kind: "undo_all" };
  if (/^(KEEP|KEEP IT|KEEP ALL)$/.test(s)) return { kind: "keep" };
  if (s === "PICK") return { kind: "pick" };
  const picked = s.match(/^PICK (.+)$/);
  if (picked) {
    const picks = numbersOf(picked[1]);
    return picks ? { kind: "pick", picks } : { kind: "unknown" };
  }
  if (/^(STOP|STOPALL|UNSUBSCRIBE|CANCEL|END|QUIT)$/.test(s)) return { kind: "stop" };
  if (/^(START|UNSTOP|HELP)$/.test(s)) return { kind: "carrier" };
  if (/^(YES|Y|ACCEPT|OK|OKAY)$/.test(s)) return { kind: "yes" };
  if (/^(NO|N|DECLINE|PUSH BACK)$/.test(s)) return { kind: "no" };
  const nums = numbersOf(s);
  if (nums) return { kind: "numbers", picks: nums };
  return { kind: "unknown" };
}
