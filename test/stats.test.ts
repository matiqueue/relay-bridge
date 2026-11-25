import { describe, expect, it } from "vitest";
import type { Effort, ExecutionMode, ModelAlias } from "../src/providers/types.js";
import {
  computeStats,
  formatDuration,
  formatStatsTable,
  formatTaskDetail,
  formatTokens,
  parseStatsArgs,
} from "../src/tasks/stats.js";
import { emptyProgress, type TaskRecord, type TaskStatus } from "../src/tasks/types.js";

function makeRecord(overrides: {
  id?: string;
  alias?: string;
  effort?: Effort;
  mode?: ExecutionMode;
  status?: TaskStatus;
  title?: string;
  workingDirectory?: string;
  createdAt?: string;
  startedAt?: string;
  finishedAt?: string;
  durationSeconds?: number;
  steps?: number;
  toolCalls?: number;
  denials?: string[];
  revisionOf?: string;
  usage?: { inputTokens: number; outputTokens: number; thinkingTokens: number; totalTokens: number };
}): TaskRecord {
  const createdAt = overrides.createdAt ?? "2026-11-24T12:00:00.000Z";
  const alias = (overrides.alias ?? "neon") as ModelAlias;
  const progress = emptyProgress();
  progress.steps = overrides.steps ?? 0;
  progress.toolCalls = overrides.toolCalls ?? 0;
  progress.permissionDenials = overrides.denials ?? [];
  return {
    schemaVersion: 1,
    id: overrides.id ?? "rb-20261124-abc123",
    provider: "antigravity",
    model: { alias, id: `gemini-4-${alias}-medium`, label: `Gemini 4 ${alias}` },
    effort: overrides.effort ?? "medium",
    title: overrides.title ?? "Synthetic task",
    task: "Synthetic task body for unit tests.",
    mode: overrides.mode ?? "modify",
    isolation: overrides.mode === "read_only" ? "read_only" : "worktree",
    workingDirectory: overrides.workingDirectory ?? "/tmp/synthetic-repo",
    workspace: "/tmp/synthetic-workspace",
    referenceDirectories: [],
    git: undefined,
    timeoutMinutes: 60,
    createdAt,
    revisionOf: overrides.revisionOf,
    revisionNumber: overrides.revisionOf ? 1 : 0,
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
    progress,
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
  it("defaults to summary view over all time", () => {
    expect(parseStatsArgs([])).toEqual({
      view: "summary",
      taskId: undefined,
      window: { kind: "all", label: "all time" },
      filters: { models: [], statuses: [], modes: [], efforts: [], project: undefined },
      limit: 20,
      sort: undefined,
      json: false,
      help: false,
    });
  });

  it("parses views, aliases, task ids, windows, filters and display options in any order", () => {
    expect(parseStatsArgs(["sessions", "7d", "-m", "neon,carbon", "-s", "failed,timed_out", "--limit=5"])).toEqual({
      view: "tasks",
      taskId: undefined,
      window: { kind: "days", count: 7, label: "last 7d" },
      filters: {
        models: ["neon", "carbon"],
        statuses: ["failed", "timed_out"],
        modes: [],
        efforts: [],
        project: undefined,
      },
      limit: 5,
      sort: undefined,
      json: false,
      help: false,
    });

    expect(parseStatsArgs(["2w", "repos", "--sort", "tokens", "-p", "relay", "--mode", "modify", "--json"])).toEqual({
      view: "projects",
      taskId: undefined,
      window: { kind: "weeks", count: 2, label: "last 2w" },
      filters: { models: [], statuses: [], modes: ["modify"], efforts: [], project: "relay" },
      limit: 20,
      sort: "tokens",
      json: true,
      help: false,
    });

    expect(parseStatsArgs(["rb-20261124-abc123"])).toMatchObject({ taskId: "rb-20261124-abc123" });
    expect(parseStatsArgs(["yesterday", "daily"])).toMatchObject({
      view: "daily",
      window: { kind: "yesterday", label: "yesterday" },
    });
    expect(parseStatsArgs(["--since", "2026-11-20", "models", "-e", "high,xhigh"])).toMatchObject({
      view: "models",
      window: { kind: "since", date: "2026-11-20", label: "since 2026-11-20" },
      filters: { efforts: ["high", "xhigh"] },
    });
    expect(parseStatsArgs(["full", "today"])).toMatchObject({
      view: "full",
      window: { kind: "today", label: "today" },
    });
    expect(parseStatsArgs(["--days=3", "-h"])).toMatchObject({
      window: { kind: "days", count: 3, label: "last 3d" },
      help: true,
    });
    expect(parseStatsArgs(["-v", "sessions", "-w", "24h"])).toMatchObject({
      view: "tasks",
      window: { kind: "hours", count: 24, label: "last 24h" },
    });
  });

  it("rejects unknown, duplicate or invalid arguments", () => {
    expect(() => parseStatsArgs(["--bogus"])).toThrow(/Unknown argument/);
    expect(() => parseStatsArgs(["today", "7d"])).toThrow(/Only one time window/);
    expect(() => parseStatsArgs(["tasks", "projects"])).toThrow(/Only one view/);
    expect(() => parseStatsArgs(["--days", "0"])).toThrow(/positive integer/);
    expect(() => parseStatsArgs(["--status", "nope"])).toThrow(/Invalid value/);
    expect(() => parseStatsArgs(["--since", "2026-02-30"])).toThrow(/Invalid calendar date/);
    expect(() => parseStatsArgs(["--sort", "bogus"])).toThrow(/Invalid value/);
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

  it("aggregates models, efforts, projects, daily, tasks and activity", () => {
    const records = [
      makeRecord({
        id: "rb-20261124-aaa111",
        alias: "neon",
        effort: "high",
        mode: "modify",
        status: "completed",
        title: "Add export endpoint",
        workingDirectory: "/Users/me/code/shop-api",
        createdAt: "2026-11-24T10:00:00.000Z",
        durationSeconds: 120,
        steps: 10,
        toolCalls: 6,
        usage: { inputTokens: 100_000, outputTokens: 10_000, thinkingTokens: 20_000, totalTokens: 130_000 },
      }),
      makeRecord({
        id: "rb-20261124-bbb222",
        alias: "neon",
        effort: "medium",
        mode: "read_only",
        status: "failed",
        title: "Investigate token=ghp_1234567890123456789012345 leak",
        workingDirectory: "/Users/me/code/shop-api",
        createdAt: "2026-11-24T12:00:00.000Z",
        startedAt: "2026-11-24T12:00:00.000Z",
        finishedAt: "2026-11-24T12:01:00.000Z",
        steps: 5,
        toolCalls: 2,
        denials: ["denied command"],
        revisionOf: "rb-20261124-aaa111",
        usage: { inputTokens: 50_000, outputTokens: 5_000, thinkingTokens: 15_000, totalTokens: 70_000 },
      }),
      makeRecord({
        id: "rb-20261125-ccc333",
        alias: "carbon",
        effort: "high",
        mode: "read_only",
        status: "completed",
        title: "Audit architecture",
        workingDirectory: "/Users/me/code/web-app",
        createdAt: "2026-11-25T09:00:00.000Z",
        durationSeconds: 300,
        steps: 14,
        toolCalls: 8,
        usage: { inputTokens: 200_000, outputTokens: 20_000, thinkingTokens: 80_000, totalTokens: 300_000 },
      }),
      makeRecord({
        id: "rb-20261120-ddd444",
        alias: "argon",
        effort: "high",
        mode: "modify",
        status: "completed",
        workingDirectory: "/Users/me/code/legacy-app",
        createdAt: "2026-11-20T09:00:00.000Z",
      }),
    ];

    const stats = computeStats(records, { now: new Date("2026-11-25T12:00:00.000Z") });
    expect(stats.totalTasks).toBe(4);
    expect(stats.activity).toEqual({
      totalSteps: 29,
      totalToolCalls: 16,
      avgToolCalls: 4,
      revisions: 1,
      tasksWithDenials: 1,
      totalDenials: 1,
    });
    expect(stats.projects.map((p) => [p.project, p.tasks])).toEqual([
      ["shop-api", 2],
      ["web-app", 1],
      ["legacy-app", 1],
    ]);
    expect(stats.daily.length).toBe(3);

    const summary = formatStatsTable(stats, "0.2.0", "summary");
    expect(summary).toContain("argon (retired)");
    expect(summary).toContain("16 tool calls (avg 4/task)");
    expect(summary).toContain("1 revisions");
    expect(summary).not.toContain("/Users/me/code/");

    const tasksView = formatStatsTable(stats, "0.2.0", "tasks", 10);
    expect(tasksView).toContain("rb-20261125-ccc333");
    expect(tasksView).toContain("shop-api");
    expect(tasksView).not.toContain("ghp_1234567890123456789012345");
    expect(tasksView).not.toContain("/Users/me/code/");

    const modelsView = formatStatsTable(stats, "0.2.0", "models");
    expect(modelsView).toContain("neon");
    expect(modelsView).toContain("high");

    const projectsView = formatStatsTable(stats, "0.2.0", "projects");
    expect(projectsView).toContain("shop-api");
    expect(projectsView).toContain("web-app");

    const dailyView = formatStatsTable(stats, "0.2.0", "daily");
    expect(dailyView).toContain("2026-11-25");

    const fullView = formatStatsTable(stats, "0.2.0", "full");
    expect(fullView).toContain("Model x effort");
    expect(fullView).toContain("Projects");
    expect(fullView).toContain("Daily activity");
    expect(fullView).toContain("Recent tasks");

    const detail = formatTaskDetail(records[1]!, "0.2.0");
    expect(detail).toContain("task rb-20261124-bbb222");
    expect(detail).toContain("project shop-api");
    expect(detail).not.toContain("ghp_1234567890123456789012345");
  });

  it("filters by time window, model, status, effort, mode and project", () => {
    const now = new Date("2026-11-25T15:00:00.000Z");
    const records = [
      makeRecord({
        id: "rb-20261125-aaa111",
        alias: "neon",
        effort: "high",
        status: "completed",
        workingDirectory: "/tmp/alpha",
        createdAt: "2026-11-25T14:00:00.000Z",
        usage: { inputTokens: 1000, outputTokens: 100, thinkingTokens: 0, totalTokens: 1100 },
      }),
      makeRecord({
        id: "rb-20261123-bbb222",
        alias: "carbon",
        effort: "high",
        status: "failed",
        workingDirectory: "/tmp/beta",
        createdAt: "2026-11-23T12:00:00.000Z",
        usage: { inputTokens: 5000, outputTokens: 500, thinkingTokens: 0, totalTokens: 5500 },
      }),
      makeRecord({
        id: "rb-20261101-ccc333",
        alias: "hydrogen",
        effort: "low",
        status: "completed",
        workingDirectory: "/tmp/alpha",
        createdAt: "2026-11-01T12:00:00.000Z",
      }),
    ];

    expect(computeStats(records, { window: { kind: "hours", count: 6, label: "last 6h" }, now }).totalTasks).toBe(1);
    expect(computeStats(records, { window: { kind: "days", count: 7, label: "last 7d" }, now }).totalTasks).toBe(2);
    expect(
      computeStats(records, {
        filters: { models: ["carbon"], statuses: ["failed"], modes: [], efforts: [], project: "bet" },
        now,
      }).totalTasks,
    ).toBe(1);

    const byTokens = computeStats(records, { sort: "tokens", now });
    expect(byTokens.tasks[0]?.id).toBe("rb-20261123-bbb222");
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
