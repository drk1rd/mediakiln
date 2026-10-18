import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/unit/**/*.test.ts", "test/integration/**/*.test.ts"],
    globalSetup: ["test/helpers/globalSetup.ts"],
    testTimeout: 120_000,
    hookTimeout: 300_000,
  },
});
