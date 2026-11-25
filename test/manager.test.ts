import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RelayError } from "../src/errors.js";
import { AntigravityProvider } from "../src/providers/antigravity/provider.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { TaskManager } from "../src/tasks/manager.js";
import { TaskStore } from "../src/tasks/store.js";
import type { GitVerification, ReadOnlyVerification } from "../src/tasks/types.js";
import { isProcessAlive } from "../src/util/process.js";
import {
  cleanupAll,
  git,
  harness,
  makeRepo,
  request,
  silentLogger,
  tempDir,
  testConfig,
  waitUntil,
} from "./helpers.js";

afterEach(cleanupAll);

async function codeOf(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
    return undefined;
  } catch (error) {
    return error instanceof RelayError ? error.code : `OTHER: ${String(error)}`;
  }
}

describe("modifying tasks in a worktree", () => {
  it("runs the agent on its own branch, leaves the original checkout alone and verifies the report", async () => {
    const repo = makeRepo();
    const { manager, store } = await harness();
    const started = await manager.delegate(request({ workingDirectory: repo, branch: "flow/feature/007-fake-change" }));

    expect(started.workspace).not.toBe(repo);
    expect(git(started.workspace, "branch", "--show-current")).toBe("flow/feature/007-fake-change");

    const done = await manager.waitFor(started.id, 20);
    expect(done.status).toBe("completed");
    expect(done.report?.summary).toBe("Did the fake work.");
    expect(done.conversationId).toBeTruthy();

    const v = done.verification as GitVerification;
    expect(v.kind).toBe("git");
    expect(v.branch).toBe("flow/feature/007-fake-change");
    expect(v.commits).toHaveLength(1);
    expect(v.commits[0]?.subject).toBe("feat: add fake change 1");
    expect(v.committedFiles).toEqual([{ status: "A", path: "relay-fake-1.txt" }]);
    expect(v.uncommitted).toEqual([]);
    expect(v.pushed).toBe(false);
    expect(v.mismatches).toEqual([]);
    expect(v.originalCheckoutChanges).toEqual([]);

    // The original checkout is untouched: still on main, no new file
    expect(git(repo, "branch", "--show-current")).toBe("main");
    expect(existsSync(path.join(repo, "relay-fake-1.txt"))).toBe(false);

    // The run's policy denies destructive git and was given to the agent as a session setting
    const settings = JSON.parse(readFileSync(path.join(store.paths(started.id).dir, "agent-settings.json"), "utf8"));
    expect(settings.enableTerminalSandbox).toBe(true);
    expect(settings.permissions.deny).toContain("command(git push --force)");
    expect(settings.permissions.deny).toContain("command(git push)");
    expect(settings.permissions.deny).toContain("command(gh pr merge)");
  });

  it("flags a report that does not match the repository", async () => {
    const repo = makeRepo();
    const { manager } = await harness();
    const task = await manager.delegate(
      request({ workingDirectory: repo, task: "Do something and report it wrongly. [[fake:liar]]" }),
    );
    const done = await manager.waitFor(task.id, 20);
    const v = done.verification as GitVerification;
    expect(v.mismatches.join("\n")).toMatch(/deadbeefcafe1234/);
    expect(v.mismatches.join("\n")).toMatch(/pushed/);
    expect(v.mismatches.join("\n")).toMatch(/nowhere\.txt/);
  });

  it("refuses work outside git, existing and protected branches, and dirty in-place trees", async () => {
    const repo = makeRepo();
    const { manager } = await harness();
    git(repo, "branch", "taken");
    expect(await codeOf(() => manager.delegate(request({ workingDirectory: tempDir() })))).toBe("NOT_A_GIT_REPOSITORY");
    expect(await codeOf(() => manager.delegate(request({ workingDirectory: repo, branch: "taken" })))).toBe(
      "BRANCH_EXISTS",
    );
    expect(await codeOf(() => manager.delegate(request({ workingDirectory: repo, branch: "main" })))).toBe(
      "BRANCH_PROTECTED",
    );
    writeFileSync(path.join(repo, "wip.txt"), "uncommitted");
    expect(
      await codeOf(() =>
        manager.delegate(request({ workingDirectory: repo, isolation: "in_place", branch: "relay/x" })),
      ),
    ).toBe("DIRTY_WORKING_TREE");
    expect(await codeOf(() => manager.delegate(request({ workingDirectory: repo, task: "too short" })))).toBe(
      "INVALID_INPUT",
    );
    expect(await codeOf(() => manager.delegate(request({ workingDirectory: repo, openPullRequest: true })))).toBe(
      "INVALID_INPUT",
    );
  });

  it("works in place on a new branch when the tree is clean", async () => {
    const repo = makeRepo();
    const { manager } = await harness();
    const task = await manager.delegate(
      request({ workingDirectory: repo, isolation: "in_place", branch: "relay/in-place" }),
    );
    expect(task.workspace).toBe(repo);
    const done = await manager.waitFor(task.id, 20);
    expect(done.status).toBe("completed");
    expect(git(repo, "branch", "--show-current")).toBe("relay/in-place");
    expect((done.verification as GitVerification).commits).toHaveLength(1);
  });
});

describe("read-only tasks", () => {
  it("run in an empty scratch directory with the repository mounted read-only", async () => {
    const repo = makeRepo();
    const reference = makeRepo("reference");
    const { manager, store } = await harness();
    const task = await manager.delegate(
      request({
        workingDirectory: repo,
        mode: "read_only",
        referenceDirectories: [reference],
        task: "Analyse the repository and describe its layout. [[fake:analyze]]",
      }),
    );
    expect(task.workspace).toBe(store.paths(task.id).scratch);
    const done = await manager.waitFor(task.id, 20);
    expect(done.status).toBe("completed");
    expect(done.report?.findings).toContain(`cwd=${store.paths(task.id).scratch}`);
    expect((done.verification as ReadOnlyVerification).changedPaths).toEqual([]);

    const settings = JSON.parse(readFileSync(path.join(store.paths(task.id).dir, "agent-settings.json"), "utf8"));
    expect(settings.toolPermission).toBe("proceed-in-sandbox");
    expect(settings.permissions.allow).toContain(`read_file(${repo})`);
    expect(settings.permissions.deny).toContain(`write_file(${repo})`);
    expect(settings.permissions.deny).toContain(`write_file(${reference})`);
  });

  it("report any change the repository went through while they ran", async () => {
    // The real sandbox mounts the repository read-only; the fake agent writes anyway, to test the after-check
    const repo = makeRepo();
    const { manager } = await harness();
    const task = await manager.delegate(
      request({
        workingDirectory: repo,
        mode: "read_only",
        task: "Look around the repository please. [[fake:write-repo]]",
      }),
    );
    const v = (await manager.waitFor(task.id, 20)).verification as ReadOnlyVerification;
    expect(v.changedPaths).toEqual(["sneaky.txt"]);
    expect(v.note).toMatch(/changed while the task ran/);
  });

  it("accept directories that are not git repositories", async () => {
    const dir = tempDir();
    const { manager } = await harness();
    const task = await manager.delegate(
      request({ workingDirectory: dir, mode: "read_only", task: "Analyse this folder of notes. [[fake:analyze]]" }),
    );
    const done = await manager.waitFor(task.id, 20);
    expect(done.status).toBe("completed");
    expect((done.verification as ReadOnlyVerification).checked).toBe(false);
  });

  it("refuse branch and push options", async () => {
    const { manager } = await harness();
    expect(
      await codeOf(() => manager.delegate(request({ workingDirectory: makeRepo(), mode: "read_only", push: true }))),
    ).toBe("INVALID_INPUT");
  });
});

describe("models", () => {
  it("rejects an effort the model does not support and an alias the account lacks", async () => {
    const repo = makeRepo();
    const { manager } = await harness();
    expect(
      await codeOf(() => manager.delegate(request({ workingDirectory: repo, model: "carbon", effort: "xhigh" }))),
    ).toBe("EFFORT_UNSUPPORTED");
    const noCarbon = await harness(testConfig());
    process.env.FAKE_AGY_NO_CARBON = "1";
    try {
      expect(
        await codeOf(() =>
          noCarbon.manager.delegate(request({ workingDirectory: repo, model: "carbon", effort: "high" })),
        ),
      ).toBe("MODEL_UNAVAILABLE");
    } finally {
      delete process.env.FAKE_AGY_NO_CARBON;
    }
  });

  it("passes the exact variant id for the requested effort to the CLI", async () => {
    const record = tempDir();
    process.env.FAKE_AGY_RECORD_DIR = record;
    try {
      const { manager } = await harness();
      const task = await manager.delegate(request({ workingDirectory: makeRepo(), model: "carbon", effort: "high" }));
      await manager.waitFor(task.id, 20);
      const runs = readdirSync(record).map(
        (f) => JSON.parse(readFileSync(path.join(record, f), "utf8")) as { args: string[]; env: { claude: string[] } },
      );
      const args = runs[0]?.args ?? [];
      expect(args[args.indexOf("--model") + 1]).toBe("gemini-4-carbon-high");
      expect(args).toEqual(
        expect.arrayContaining([
          "--output-format",
          "stream-json",
          "--sandbox",
          "--disable-slash-commands",
          "--mode",
          "accept-edits",
        ]),
      );
      expect(args[args.indexOf("--print-timeout") + 1]).toBe("60m");
      expect(runs[0]?.env.claude).toEqual([]);
    } finally {
      delete process.env.FAKE_AGY_RECORD_DIR;
    }
  });
});

describe("outcomes", () => {
  it.each([
    ["fail", "failed", /quota exhausted/],
    ["timeout", "timed_out", /print timeout/],
    ["waiting", "awaiting_input", undefined],
  ] as const)("maps a %s run to %s", async (scenario, status, error) => {
    const { manager } = await harness();
    const task = await manager.delegate(
      request({ workingDirectory: makeRepo(), task: `Do the thing that ends badly. [[fake:${scenario}]]` }),
    );
    const done = await manager.waitFor(task.id, 20);
    expect(done.status).toBe(status);
    if (error) expect(done.outcome?.error).toMatch(error);
  });

  it("continues the conversation when a turn ends at a command headless mode had to deny", async () => {
    const record = tempDir();
    process.env.FAKE_AGY_RECORD_DIR = record;
    try {
      const { manager } = await harness();
      const task = await manager.delegate(
        request({
          workingDirectory: makeRepo(),
          mode: "read_only",
          task: "Look at something that needs a denied command. [[fake:autodeny]]",
        }),
      );
      const done = await manager.waitFor(task.id, 20);
      expect(done.status).toBe("completed");
      expect(done.report?.summary).toBe("Finished after the continuation.");
      expect(done.continuations).toBe(1);
      expect(done.warnings.join(" ")).toMatch(/resumed the conversation/);
      const runs = readdirSync(record).map(
        (f) => (JSON.parse(readFileSync(path.join(record, f), "utf8")) as { args: string[] }).args,
      );
      const resumed = runs.find((args) => args.includes("--conversation"));
      expect(resumed?.[resumed.indexOf("--conversation") + 1]).toBe(done.conversationId);
      expect(resumed?.[resumed.indexOf("-p") + 1]).toMatch(/^Relay Bridge: your last turn ended/);
    } finally {
      delete process.env.FAKE_AGY_RECORD_DIR;
    }
  });

  it("fails after two continuations that end at a denied command again", async () => {
    process.env.FAKE_AGY_ALWAYS_DENY = "1";
    try {
      const { manager } = await harness();
      const task = await manager.delegate(
        request({
          workingDirectory: makeRepo(),
          mode: "read_only",
          task: "Keep needing a denied command. [[fake:autodeny]]",
        }),
      );
      const done = await manager.waitFor(task.id, 30);
      expect(done.status).toBe("failed");
      expect(done.continuations).toBe(2);
      expect(done.outcome?.error).toMatch(/policy does not allow/);
    } finally {
      delete process.env.FAKE_AGY_ALWAYS_DENY;
    }
  });

  it("asks for the report when a turn ends without one", async () => {
    const { manager } = await harness();
    const task = await manager.delegate(
      request({ workingDirectory: makeRepo(), task: "Do it but forget the report. [[fake:noreport]]" }),
    );
    const done = await manager.waitFor(task.id, 20);
    expect(done.status).toBe("completed");
    expect(done.report?.summary).toBe("Finished after the continuation.");
    expect(done.continuations).toBe(1);
    expect(done.warnings.join(" ")).toMatch(/ended without its report/);
  });

  it("keeps a free-text answer when the agent never reports", async () => {
    process.env.FAKE_AGY_ALWAYS_NOREPORT = "1";
    try {
      const { manager } = await harness();
      const task = await manager.delegate(
        request({ workingDirectory: makeRepo(), task: "Never write the report at all. [[fake:noreport]]" }),
      );
      const done = await manager.waitFor(task.id, 30);
      expect(done.status).toBe("completed");
      expect(done.continuations).toBe(2);
      expect(done.report).toBeUndefined();
      expect(done.outcome?.response).toContain("trust me");
      expect(done.warnings.join(" ")).toMatch(/without a structured report/);
    } finally {
      delete process.env.FAKE_AGY_ALWAYS_NOREPORT;
    }
  });

  it("records permission denials and redacts secrets from the record and the log", async () => {
    const { manager, store } = await harness();
    const denied = await manager.waitFor(
      (
        await manager.delegate(
          request({ workingDirectory: makeRepo(), task: "Try something forbidden here. [[fake:denied]]" }),
        )
      ).id,
      20,
    );
    expect(denied.progress.permissionDenials[0]).toMatch(/git push --force/);

    const secret = await manager.waitFor(
      (
        await manager.delegate(
          request({ workingDirectory: makeRepo(), task: "Leak a token by accident. [[fake:secret]]" }),
        )
      ).id,
      20,
    );
    const raw =
      readFileSync(store.paths(secret.id).record, "utf8") + readFileSync(store.paths(secret.id).events, "utf8");
    expect(raw).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(raw).toContain("[REDACTED GITHUB TOKEN]");
  });
});

describe("concurrency, cancellation and timeouts", () => {
  it("runs at most the configured number of tasks at once and queues the rest", async () => {
    const { manager } = await harness(testConfig({ RELAY_BRIDGE_MAX_CONCURRENCY: "2" }));
    const repo = makeRepo();
    const tasks = [];
    for (let i = 0; i < 3; i++) {
      tasks.push(
        await manager.delegate(
          request({ workingDirectory: repo, task: `Sleep for a moment, task ${i}. [[fake:sleep:1]]` }),
        ),
      );
    }
    expect(tasks.map((t) => t.status)).toEqual(["running", "running", "queued"]);
    const done = await Promise.all(tasks.map((t) => manager.waitFor(t.id, 20)));
    expect(done.map((t) => t.status)).toEqual(["completed", "completed", "completed"]);
    expect(new Set(done.map((t) => t.workspace)).size).toBe(3);
  });

  it("cancels a running task and its process group", async () => {
    const { manager } = await harness();
    const task = await manager.delegate(
      request({ workingDirectory: makeRepo(), task: "Sleep for a long time please. [[fake:sleep:30]]" }),
    );
    const pid = task.process?.pid;
    expect(pid).toBeDefined();
    const cancelled = await manager.cancel(task.id);
    expect(cancelled.status).toBe("cancelled");
    expect(isProcessAlive(pid!)).toBe(false);
    expect(await codeOf(() => manager.cancel(task.id))).toBe("TASK_ALREADY_FINISHED");
  });

  it("terminates an agent that ignores the interrupt", async () => {
    const { manager } = await harness();
    const task = await manager.delegate(
      request({ workingDirectory: makeRepo(), task: "Sleep and ignore interrupts. [[fake:stubborn:30]]" }),
    );
    const cancelled = await manager.cancel(task.id);
    expect(cancelled.status).toBe("cancelled");
    expect(isProcessAlive(task.process!.pid)).toBe(false);
  });

  it("cancels a queued task without starting it", async () => {
    const { manager } = await harness(testConfig({ RELAY_BRIDGE_MAX_CONCURRENCY: "1" }));
    const repo = makeRepo();
    const first = await manager.delegate(
      request({ workingDirectory: repo, task: "Occupy the only slot for a while. [[fake:sleep:2]]" }),
    );
    const second = await manager.delegate(
      request({ workingDirectory: repo, task: "Wait in the queue for the slot. [[fake:sleep:1]]" }),
    );
    expect(second.status).toBe("queued");
    expect((await manager.cancel(second.id)).status).toBe("cancelled");
    expect((await manager.waitFor(first.id, 20)).status).toBe("completed");
    expect((await manager.get(second.id)).process).toBeUndefined();
  });
});

describe("restarts and several instances", () => {
  it("lets another instance adopt a running task when its supervisor stops", async () => {
    const config = testConfig();
    const a = await harness(config);
    const task = await a.manager.delegate(
      request({ workingDirectory: makeRepo(), task: "Sleep a little and finish. [[fake:sleep:2]]" }),
    );
    await a.manager.stop();

    // A new server process over the same state directory (another Claude Code session, or a restart)
    const store = new TaskStore(config.tasksDir);
    const b = new TaskManager(
      config,
      store,
      new ProviderRegistry().register(new AntigravityProvider(config)),
      silentLogger,
    );
    await b.start();
    try {
      const done = await b.waitFor(task.id, 20);
      expect(done.status).toBe("completed");
      expect(done.report?.summary).toBe("Slept 2s.");
    } finally {
      await b.stop();
    }
  });

  it("finishes a task whose agent exited while no instance was running", async () => {
    const config = testConfig();
    const a = await harness(config);
    const task = await a.manager.delegate(
      request({ workingDirectory: makeRepo(), task: "Finish quickly while nobody watches. [[fake:sleep:1]]" }),
    );
    await a.manager.stop();
    await waitUntil(() => !isProcessAlive(task.process!.pid), 10_000, "the agent to exit");

    const b = await harness(config);
    const done = await b.manager.waitFor(task.id, 10);
    expect(done.status).toBe("completed");
  });
});

describe("revisions and clean-up", () => {
  it("continues on the same branch and worktree, resuming the conversation", async () => {
    const record = tempDir();
    const { manager } = await harness();
    const first = await manager.waitFor((await manager.delegate(request({ workingDirectory: makeRepo() }))).id, 20);
    expect(
      await codeOf(() =>
        manager.revise({
          taskId: "rb-20260101-aaaaaa",
          instructions: "Change it.",
          model: undefined,
          effort: undefined,
          continueConversation: true,
          push: undefined,
          openPullRequest: undefined,
          timeoutMinutes: undefined,
        }),
      ),
    ).toBe("TASK_NOT_FOUND");

    process.env.FAKE_AGY_RECORD_DIR = record;
    try {
      const revision = await manager.revise({
        taskId: first.id,
        instructions: "Add one more change on top. [[fake:commit]]",
        model: undefined,
        effort: "high",
        continueConversation: true,
        push: undefined,
        openPullRequest: undefined,
        timeoutMinutes: undefined,
      });
      expect(revision.workspace).toBe(first.workspace);
      expect(revision.revisionOf).toBe(first.id);
      const done = await manager.waitFor(revision.id, 20);
      expect(done.status).toBe("completed");
      const v = done.verification as GitVerification;
      expect(v.commits).toHaveLength(2);
      const args = (JSON.parse(readFileSync(path.join(record, readdirSync(record)[0]!), "utf8")) as { args: string[] })
        .args;
      expect(args[args.indexOf("--conversation") + 1]).toBe(first.conversationId);
      expect(args[args.indexOf("--model") + 1]).toBe("gemini-4-neon-high");
    } finally {
      delete process.env.FAKE_AGY_RECORD_DIR;
    }
  });

  it("starts a fresh conversation with the previous context when resuming fails", async () => {
    const { manager, store } = await harness();
    const first = await manager.waitFor(
      (
        await manager.delegate(
          request({
            workingDirectory: makeRepo(),
            task: "Make a change in a forgetful conversation. [[fake:commit]] [[fake:conv:missing]]",
          }),
        )
      ).id,
      20,
    );
    expect(first.conversationId).toMatch(/^missing-/);
    const revision = await manager.revise({
      taskId: first.id,
      instructions: "Add another change now. [[fake:commit]]",
      model: undefined,
      effort: undefined,
      continueConversation: true,
      push: undefined,
      openPullRequest: undefined,
      timeoutMinutes: undefined,
    });
    const done = await manager.waitFor(revision.id, 20);
    expect(done.status).toBe("completed");
    expect(done.warnings.join(" ")).toMatch(/could not be resumed/);
    expect(readFileSync(store.paths(revision.id).brief, "utf8")).toContain("### Previous report");
  });

  it("removes a clean worktree but keeps the branch, and refuses a dirty one", async () => {
    const repo = makeRepo();
    const { manager } = await harness();
    const done = await manager.waitFor(
      (await manager.delegate(request({ workingDirectory: repo, branch: "relay/cleanup" }))).id,
      20,
    );
    writeFileSync(path.join(done.workspace, "scratch.txt"), "left behind");
    expect(await codeOf(() => manager.removeWorktree(done.id))).toBe("WORKTREE_NOT_CLEAN");
    expect(existsSync(done.workspace)).toBe(true);

    rmSync(path.join(done.workspace, "scratch.txt"));
    const removed = await manager.removeWorktree(done.id);
    expect(removed.branchKept).toBe("relay/cleanup");
    expect(existsSync(done.workspace)).toBe(false);
    expect(git(repo, "branch", "--list", "relay/cleanup")).toContain("relay/cleanup");
  });
});
