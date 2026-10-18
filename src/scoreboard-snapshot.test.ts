import { describe, expect, it } from "vitest";
import { renderLatestScoreboard } from "../evals/scoreboard.js";
import { SCOREBOARD_HTML } from "./scoreboard-snapshot.js";

describe("the scoreboard a deployed build serves", () => {
  it("matches the newest committed results (run npm run scoreboard:snapshot after new results)", () => {
    expect(SCOREBOARD_HTML).toBe(renderLatestScoreboard());
  });
  it("has numbers, not the empty state", () => {
    expect(SCOREBOARD_HTML).not.toContain("No Layer 1 results yet");
    expect(SCOREBOARD_HTML).not.toContain("No Layer 2 results yet");
  });
});
