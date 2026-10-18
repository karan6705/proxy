import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    exclude: ["**/node_modules/**"],
    // The demo's pacing (src/orchestrator/runtime.ts) is off in tests.
    env: { DEMO_PACE_MS: "0" },
  },
});
