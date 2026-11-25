import { defineConfig } from "vitest/config";

// Integration tests run the real `agy` CLI with the signed-in account: they use model quota, need network and
// take minutes. They never run in CI. npm run test:integration (sets RELAY_BRIDGE_INTEGRATION=1).
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.integration.test.ts"],
    testTimeout: 15 * 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
