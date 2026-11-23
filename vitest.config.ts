import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // *.integration.test.ts talk to the real Antigravity CLI and the signed-in account: npm run test:integration
    exclude: [...configDefaults.exclude, "test/**/*.integration.test.ts", ".claude/**"],
    testTimeout: 20_000,
    // The tests start real child processes (fake agents, git): a shared machine must not run all files at once
    maxWorkers: 4,
  },
});
