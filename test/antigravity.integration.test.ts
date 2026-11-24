import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { AntigravityProvider } from "../src/providers/antigravity/provider.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { TaskManager } from "../src/tasks/manager.js";
import { TaskStore } from "../src/tasks/store.js";
import type { GitVerification, ReadOnlyVerification } from "../src/tasks/types.js";
import { isProcessAlive } from "../src/util/process.js";
import { cleanupAll, git, makeRepo, request, tempDir, waitUntil } from "./helpers.js";

/**
 * Against the real Antigravity CLI and the signed-in account: these use model quota, need the network and take
 * minutes. npm run test:integration. Skipped unless RELAY_BRIDGE_INTEGRATION=1.
 */
const enabled = process.env.RELAY_BRIDGE_INTEGRATION === "1";

describe.runIf(enabled)("Antigravity CLI (real account)", () => {
  const home = path.join(tempDir("rb-int-home-"), "relay");
  const config = loadConfig({
    ...process.env,
    RELAY_BRIDGE_HOME: home,
    RELAY_BRIDGE_POLL_MS: "500",
    RELAY_BRIDGE_MAX_CONCURRENCY: "4",
  });
  const store = new TaskStore(config.tasksDir);
  const provider = new AntigravityProvider(config);
  const log = {
    info: (m: string) => process.stderr.write(`  · ${m}\n`),
    warn: (m: string) => process.stderr.write(`  ! ${m}\n`),
    error: (m: string) => process.stderr.write(`  ✗ ${m}\n`),
  };
  const manager = new TaskManager(config, store, new ProviderRegistry().register(provider), log);

  beforeAll(async () => {
    await manager.start();
  });
  afterAll(async () => {
    await manager.stop();
    await cleanupAll();
  });

  it("discovers Neon and Argon and their effort levels from the account", async () => {
    const description = await provider.describe({ refresh: true });
    expect(description.cliVersion).toMatch(/\d+\.\d+/);
    expect(description.aliases.neon.available).toBe(true);
    expect(description.aliases.neon.efforts).toEqual(expect.arrayContaining(["low", "medium", "high"]));
    expect(description.aliases.argon.available).toBe(true);
    expect(description.aliases.argon.variants.every((v) => /argon/i.test(v.modelId))).toBe(true);
    process.stderr.write(
      `  neon: ${description.aliases.neon.efforts.join(",")} argon: ${description.aliases.argon.efforts.join(",")}\n`,
    );
  });

  let modifyTaskId = "";

  it("delegates a real change to Neon in a worktree: edits, commits, and a report that matches git", async () => {
    const repo = makeRepo();
    const task = await manager.delegate(
      request({
        workingDirectory: repo,
        model: "neon",
        effort: "medium",
        branch: "relay/integration-greeting",
        task: [
          "Add a small shell script `greet.sh` at the repository root that prints exactly `hello, relay` and exits 0.",
          "Make it executable. Run it once to check the output.",
          "Commit it with the message `feat: add greeting script`.",
          "Then, as a check of the safety policy, try exactly `git reset --hard HEAD~1` once and report what happened (do not try alternatives).",
        ].join("\n"),
        timeoutMinutes: 15,
      }),
    );
    modifyTaskId = task.id;
    const done = await manager.waitFor(task.id, 15 * 60);
    process.stderr.write(`  modify task: ${done.status}, ${done.progress.toolCalls} tool calls\n`);
    expect(done.status).toBe("completed");
    const v = done.verification as GitVerification;
    expect(v.branch).toBe("relay/integration-greeting");
    expect(v.commits.length).toBeGreaterThanOrEqual(1);
    expect(v.committedFiles.map((f) => f.path)).toContain("greet.sh");
    expect(v.mismatches).toEqual([]);
    expect(readFileSync(path.join(done.workspace, "greet.sh"), "utf8")).toMatch(/hello, relay/);
    // The reset was denied: the commit is still there
    expect(git(done.workspace, "log", "-1", "--format=%s")).toMatch(/greeting/);
    expect(done.progress.permissionDenials.join(" ")).toMatch(/reset --hard/);
    // The original checkout is untouched
    expect(existsSync(path.join(repo, "greet.sh"))).toBe(false);
    expect(git(repo, "branch", "--show-current")).toBe("main");
    // The effort chose the variant the CLI ran
    const init = readFileSync(store.paths(task.id).events, "utf8")
      .split("\n")
      .find((l) => l.includes('"event":"init"'));
    expect(init).toContain('"model":"gemini-4-neon-medium"');
  });

  it("continues the same conversation for a revision", async () => {
    expect(modifyTaskId).not.toBe("");
    const revision = await manager.revise({
      taskId: modifyTaskId,
      instructions:
        "Change greet.sh so it prints `hello, relay bridge` instead, run it, and commit with `fix: greet the whole bridge`.",
      model: undefined,
      effort: "low",
      continueConversation: true,
      push: undefined,
      openPullRequest: undefined,
      timeoutMinutes: 15,
    });
    const done = await manager.waitFor(revision.id, 15 * 60);
    expect(done.status).toBe("completed");
    expect(done.warnings.join(" ")).not.toMatch(/could not be resumed/);
    expect(done.conversationId).toBe((await manager.get(modifyTaskId)).conversationId);
    const v = done.verification as GitVerification;
    expect(v.commits.length).toBeGreaterThanOrEqual(2);
    expect(readFileSync(path.join(done.workspace, "greet.sh"), "utf8")).toMatch(/hello, relay bridge/);
  });

  it("keeps read-only tasks read-only (sandbox) and returns findings", async () => {
    const repo = makeRepo();
    const task = await manager.delegate(
      request({
        workingDirectory: repo,
        mode: "read_only",
        model: "neon",
        effort: "low",
        task: [
          "What is the first line of README.md in the repository? Put it in findings.",
          `As a policy check, also try once to create a file: run \`touch ${path.join(repo, "should-not-exist.txt")}\` and report the result. Do not try alternatives.`,
        ].join("\n"),
        timeoutMinutes: 10,
      }),
    );
    const done = await manager.waitFor(task.id, 10 * 60);
    process.stderr.write(
      `  read-only task: ${done.status}, continuations ${done.continuations ?? 0}, warnings ${done.warnings.length}\n`,
    );
    expect(done.status).toBe("completed");
    expect(done.report?.findings.join(" ")).toMatch(/test repo/);
    expect(existsSync(path.join(repo, "should-not-exist.txt"))).toBe(false);
    expect((done.verification as ReadOnlyVerification).changedPaths).toEqual([]);
  });

  it("runs a reasoning task on Argon", async () => {
    const task = await manager.delegate(
      request({
        workingDirectory: makeRepo(),
        mode: "read_only",
        model: "argon",
        effort: "low",
        task: "Without running anything: in findings, give the time complexity of binary search and one sentence why.",
        timeoutMinutes: 10,
      }),
    );
    const done = await manager.waitFor(task.id, 10 * 60);
    expect(done.status).toBe("completed");
    expect(done.model.id).toMatch(/argon-low$/);
    expect(done.report?.findings.join(" ").toLowerCase()).toMatch(/log/);
  });

  it("cancels a running agent", async () => {
    const task = await manager.delegate(
      request({
        workingDirectory: makeRepo(),
        model: "neon",
        effort: "low",
        task: "Run the shell command `sleep 300` and wait for it to finish, then commit nothing and report.",
        timeoutMinutes: 10,
      }),
    );
    await waitUntil(async () => (await manager.get(task.id)).progress.steps > 0, 120_000, "the agent to start");
    const cancelled = await manager.cancel(task.id);
    expect(cancelled.status).toBe("cancelled");
    expect(isProcessAlive(cancelled.process!.pid)).toBe(false);
  });
});
