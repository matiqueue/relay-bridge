import { describe, expect, it } from "vitest";
import type { Effort, ExecutionMode, ModelAlias } from "../src/providers/types.js";
import { computeStats, formatDuration, formatStatsTable, formatTokens, parseStatsArgs } from "../src/tasks/stats.js";
import { emptyProgress, type TaskRecord, type TaskStatus } from "../src/tasks/types.js";

function makeRecord(overrides: {
  id?: string;
  alias?: string;
  effort?: Effort;
  mode?: ExecutionMode;
  status?: TaskStatus;
  createdAt?: string;
  startedAt?: string;
  finishedAt?: string;
  durationSeconds?: number;
  usage?: { inputTokens: number; outputTokens: number; thinkingTokens: number; totalTokens: number };
}): TaskRecord {
  const createdAt = overrides.createdAt ?? "2026-11-24T12:00:00.000Z";
  const alias = (overrides.alias ?? "neon") as ModelAlias;
  return {
    schemaVersion: 1,
    id: overrides.id ?? "rb-20261124-abc123",
    provider: "antigravity",
    model: { alias, id: `gemini-4-${alias}-medium`, label: `Gemini 4 ${alias}` },
    effort: overrides.effort ?? "medium",
    title: "Synthetic task",
    task: "Synthetic task body for unit tests.",
    mode: overrides.mode ?? "modify",
    isolation: overrides.mode === "read_only" ? "read_only" : "worktree",
    workingDirectory: "/tmp/synthetic-repo",
    workspace: "/tmp/synthetic-workspace",
    referenceDirectories: [],
    git: undefined,
    timeoutMinutes: 60,
    createdAt,
    revisionOf: undefined,
    revisionNumber: 0,
    revisionInstructions: undefined,
    resumeConversationId: undefined,
    snapshotBefore: undefined,
    status: overrides.status ?? "completed",
    updatedAt: createdAt,
    startedAt: overrides.startedAt ?? createdAt,
    finishedAt: overrides.finishedAt,
    ownerPid: undefined,
    process: undefined,
    conversationId: undefined,
    cancelRequested: undefined,
    progress: emptyProgress(),
    outcome:
      overrides.usage !== undefined || overrides.durationSeconds !== undefined
        ? {
            cliStatus: "SUCCESS",
            finishedReason: undefined,
            exitCode: 0,
            signal: null,
            error: undefined,
            response: undefined,
            usage: overrides.usage,
            durationSeconds: overrides.durationSeconds,
          }
        : undefined,
    report: undefined,
    verification: undefined,
    warnings: [],
  };
}

describe("parseStatsArgs", () => {
  it("defaults to all time and table output", () => {
    expect(parseStatsArgs([])).toEqual({
      window: { kind: "all", label: "all time" },
      json: false,
      help: false,
    });
  });

  it("parses time windows and flags", () => {
    expect(parseStatsArgs(["today"])).toMatchObject({ window: { kind: "today", label: "today" } });
    expect(parseStatsArgs(["7d", "--json"])).toEqual({
      window: { kind: "days", count: 7, label: "last 7d" },
      json: true,
      help: false,
    });
    expect(parseStatsArgs(["24h"])).toMatchObject({ window: { kind: "hours", count: 24, label: "last 24h" } });
    expect(parseStatsArgs(["--days", "14"])).toMatchObject({ window: { kind: "days", count: 14, label: "last 14d" } });
    expect(parseStatsArgs(["--days=3"])).toMatchObject({ window: { kind: "days", count: 3, label: "last 3d" } });
    expect(parseStatsArgs(["-h"])).toMatchObject({ help: true });
  });

  it("rejects unknown, duplicate or invalid arguments", () => {
    expect(() => parseStatsArgs(["--bogus"])).toThrow(/Unknown argument/);
    expect(() => parseStatsArgs(["today", "7d"])).toThrow(/Only one time window/);
    expect(() => parseStatsArgs(["--days", "0"])).toThrow(/positive integer/);
    expect(() => parseStatsArgs(["--days"])).toThrow(/Missing value/);
  });
});

describe("computeStats and formatStatsTable", () => {
  it("handles an empty history cleanly", () => {
    const stats = computeStats([], { now: new Date("2026-11-25T12:00:00.000Z") });
    expect(stats.totalTasks).toBe(0);
    expect(stats.models.map((m) => m.alias)).toEqual(["hydrogen", "neon", "carbon"]);
    const table = formatStatsTable(stats, "0.2.0");
    expect(table).toContain("Relay Bridge 0.2.0 — usage (all time)");
    expect(table).toContain("No delegated tasks found");
  });

  it("aggregates active models, retired aliases, tokens, efforts and durations", () => {
    const records = [
      makeRecord({
        id: "rb-20261124-aaa111",
        alias: "neon",
        effort: "high",
        mode: "modify",
        status: "completed",
        durationSeconds: 120,
        usage: { inputTokens: 100_000, outputTokens: 10_000, thinkingTokens: 20_000, totalTokens: 130_000 },
      }),
      makeRecord({
        id: "rb-20261124-bbb222",
        alias: "neon",
        effort: "medium",
        mode: "read_only",
        status: "failed",
        startedAt: "2026-11-24T12:00:00.000Z",
        finishedAt: "2026-11-24T12:01:00.000Z",
        usage: { inputTokens: 50_000, outputTokens: 5_000, thinkingTokens: 15_000, totalTokens: 70_000 },
      }),
      makeRecord({
        id: "rb-20261124-ccc333",
        alias: "carbon",
        effort: "high",
        mode: "read_only",
        status: "completed",
        durationSeconds: 300,
        usage: { inputTokens: 200_000, outputTokens: 20_000, thinkingTokens: 80_000, totalTokens: 300_000 },
      }),
      makeRecord({
        id: "rb-20261120-ddd444",
        alias: "argon",
        effort: "high",
        mode: "modify",
        status: "completed",
        // No usage or durationSeconds: exercises missing-metrics handling
      }),
    ];

    const stats = computeStats(records, { now: new Date("2026-11-25T12:00:00.000Z") });
    expect(stats.totalTasks).toBe(4);
    expect(stats.byStatus.completed).toBe(3);
    expect(stats.byStatus.failed).toBe(1);
    expect(stats.byMode).toEqual({ modify: 2, read_only: 2 });
    expect(stats.tokens).toEqual({
      input: 350_000,
      output: 35_000,
      thinking: 115_000,
      total: 500_000,
      tasksWithUsage: 3,
    });
    expect(stats.durationSeconds).toEqual({ total: 480, average: 160, tasksWithDuration: 3 });

    const byAlias = Object.fromEntries(stats.models.map((m) => [m.alias, m]));
    expect(byAlias.hydrogen).toMatchObject({ tasks: 0, taskSharePct: 0, retired: false });
    expect(byAlias.neon).toMatchObject({
      tasks: 2,
      taskSharePct: 50,
      completed: 1,
      failed: 1,
      tokens: 200_000,
      tokenSharePct: 40,
      avgDurationSeconds: 90,
      retired: false,
    });
    expect(byAlias.carbon).toMatchObject({
      tasks: 1,
      taskSharePct: 25,
      tokens: 300_000,
      tokenSharePct: 60,
      avgDurationSeconds: 300,
      retired: false,
    });
    expect(byAlias.argon).toMatchObject({
      tasks: 1,
      taskSharePct: 25,
      retired: true,
      avgDurationSeconds: undefined,
    });

    const table = formatStatsTable(stats, "0.2.0");
    expect(table).toContain("argon (retired)");
    expect(table).toContain("50.0%");
    expect(table).toContain("500.0k total");
    expect(table).toContain("3 completed · 1 failed");
    expect(table).not.toContain("/tmp/synthetic-repo");
    expect(table).not.toContain("Synthetic task");
  });

  it("filters tasks by time window", () => {
    const now = new Date("2026-11-25T15:00:00.000Z");
    const records = [
      makeRecord({ id: "rb-20261125-aaa111", createdAt: "2026-11-25T14:00:00.000Z" }),
      makeRecord({ id: "rb-20261123-bbb222", createdAt: "2026-11-23T12:00:00.000Z" }),
      makeRecord({ id: "rb-20261101-ccc333", createdAt: "2026-11-01T12:00:00.000Z" }),
    ];

    expect(computeStats(records, { window: { kind: "hours", count: 6, label: "last 6h" }, now }).totalTasks).toBe(1);
    expect(computeStats(records, { window: { kind: "days", count: 7, label: "last 7d" }, now }).totalTasks).toBe(2);
    expect(computeStats(records, { window: { kind: "all", label: "all time" }, now }).totalTasks).toBe(3);
  });

  it("formats token counts and durations compactly", () => {
    expect(formatTokens(420)).toBe("420");
    expect(formatTokens(12_500)).toBe("12.5k");
    expect(formatTokens(1_250_000)).toBe("1.25M");
    expect(formatDuration(undefined)).toBe("-");
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(125)).toBe("2m 5s");
    expect(formatDuration(3660)).toBe("1h 1m");
  });
});
