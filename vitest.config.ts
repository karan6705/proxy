import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    exclude: [
      "**/node_modules/**",
      // Temporary: still written for node:test. Remove this line once it is converted to Vitest.
      "src/stripe/stripe.test.ts",
    ],
  },
});
