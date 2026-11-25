import { EFFORTS, MODEL_ALIASES, RETIRED_MODEL_ALIASES, type Effort } from "../providers/types.js";
import { TASK_STATUSES, type TaskRecord, type TaskStatus } from "./types.js";

export type TimeWindow =
  | { readonly kind: "all"; readonly label: string }
  | { readonly kind: "today"; readonly label: string }
  | { readonly kind: "days"; readonly count: number; readonly label: string }
  | { readonly kind: "hours"; readonly count: number; readonly label: string };

export interface StatsCliOptions {
  readonly window: TimeWindow;
  readonly json: boolean;
  readonly help: boolean;
}

export interface ModelStats {
  readonly alias: string;
  readonly retired: boolean;
  readonly tasks: number;
  readonly taskSharePct: number;
  readonly completed: number;
  readonly failed: number;
  readonly tokens: number;
  readonly tokenSharePct: number;
  readonly avgDurationSeconds: number | undefined;
}

export interface UsageStats {
  readonly window: TimeWindow;
  readonly generatedAt: string;
  readonly totalTasks: number;
  readonly byStatus: Readonly<Record<TaskStatus, number>>;
  readonly byMode: { readonly modify: number; readonly read_only: number };
  readonly byEffort: readonly { readonly effort: Effort; readonly tasks: number; readonly sharePct: number }[];
  readonly tokens: {
    readonly input: number;
    readonly output: number;
    readonly thinking: number;
    readonly total: number;
    readonly tasksWithUsage: number;
  };
  readonly durationSeconds: {
    readonly total: number;
    readonly average: number | undefined;
    readonly tasksWithDuration: number;
  };
  readonly models: readonly ModelStats[];
}

export const STATS_HELP = `Usage: relay-stats [window] [--days <n>] [--json] [--help]

Prints local Relay Bridge usage statistics from ~/.relay-bridge/tasks.

Windows:
  all           All recorded tasks (default)
  today         Tasks created since local midnight
  <n>d          Tasks created in the last N days (e.g. 7d, 30d)
  <n>h          Tasks created in the last N hours (e.g. 24h)

Options:
  --days <n>    Same as <n>d
  --json        Output machine-readable JSON
  -h, --help    Show this help message
`;

function parsePositiveInt(raw: string, flag: string): number {
  if (!/^\d+$/.test(raw)) throw new Error(`Invalid value "${raw}" for ${flag}: expected a positive integer.`);
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid value "${raw}" for ${flag}: expected a positive integer.`);
  }
  return parsed;
}

export function parseStatsArgs(argv: readonly string[]): StatsCliOptions {
  let window: TimeWindow = { kind: "all", label: "all time" };
  let windowSet = false;
  let json = false;
  let help = false;

  const setWindow = (next: TimeWindow) => {
    if (windowSet)
      throw new Error(`Only one time window can be specified (got "${next.label}" after "${window.label}").`);
    window = next;
    windowSet = true;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "-h" || arg === "--help") {
      help = true;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--days") {
      const next = argv[++i];
      if (!next) throw new Error("Missing value for --days.");
      const count = parsePositiveInt(next, "--days");
      setWindow({ kind: "days", count, label: `last ${count}d` });
      continue;
    }
    if (arg.startsWith("--days=")) {
      const count = parsePositiveInt(arg.slice("--days=".length), "--days");
      setWindow({ kind: "days", count, label: `last ${count}d` });
      continue;
    }
    if (arg === "all") {
      setWindow({ kind: "all", label: "all time" });
      continue;
    }
    if (arg === "today") {
      setWindow({ kind: "today", label: "today" });
      continue;
    }
    const daysMatch = /^(\d+)d$/i.exec(arg);
    if (daysMatch?.[1]) {
      const count = parsePositiveInt(daysMatch[1], arg);
      setWindow({ kind: "days", count, label: `last ${count}d` });
      continue;
    }
    const hoursMatch = /^(\d+)h$/i.exec(arg);
    if (hoursMatch?.[1]) {
      const count = parsePositiveInt(hoursMatch[1], arg);
      setWindow({ kind: "hours", count, label: `last ${count}h` });
      continue;
    }
    throw new Error(`Unknown argument "${arg}". Run with --help for usage.`);
  }

  return { window, json, help };
}

function windowCutoffMs(window: TimeWindow, now: Date): number | undefined {
  switch (window.kind) {
    case "all":
      return undefined;
    case "today":
      return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    case "days":
      return now.getTime() - window.count * 24 * 60 * 60 * 1000;
    case "hours":
      return now.getTime() - window.count * 60 * 60 * 1000;
  }
}

function recordDurationSeconds(record: TaskRecord): number | undefined {
  const fromOutcome = record.outcome?.durationSeconds;
  if (typeof fromOutcome === "number" && Number.isFinite(fromOutcome) && fromOutcome >= 0) {
    return fromOutcome;
  }
  if (record.startedAt && record.finishedAt) {
    const start = Date.parse(record.startedAt);
    const end = Date.parse(record.finishedAt);
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
      return (end - start) / 1000;
    }
  }
  return undefined;
}

function roundPct(part: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((part / total) * 1000) / 10;
}

interface ModelBucket {
  tasks: number;
  completed: number;
  failed: number;
  tokens: number;
  durationSum: number;
  durationCount: number;
}

function emptyBucket(): ModelBucket {
  return { tasks: 0, completed: 0, failed: 0, tokens: 0, durationSum: 0, durationCount: 0 };
}

export function computeStats(
  records: readonly TaskRecord[],
  options: { readonly window?: TimeWindow; readonly now?: Date } = {},
): UsageStats {
  const now = options.now ?? new Date();
  const window: TimeWindow = options.window ?? { kind: "all", label: "all time" };
  const cutoff = windowCutoffMs(window, now);

  const filtered =
    cutoff === undefined
      ? records
      : records.filter((record) => {
          const created = Date.parse(record.createdAt);
          return Number.isFinite(created) && created >= cutoff;
        });

  const byStatus = Object.fromEntries(TASK_STATUSES.map((s) => [s, 0])) as Record<TaskStatus, number>;
  const byMode = { modify: 0, read_only: 0 };
  const effortCounts = new Map<Effort, number>();
  const buckets = new Map<string, ModelBucket>();

  for (const alias of MODEL_ALIASES) buckets.set(alias, emptyBucket());

  let inputTokens = 0;
  let outputTokens = 0;
  let thinkingTokens = 0;
  let totalTokens = 0;
  let tasksWithUsage = 0;
  let totalDuration = 0;
  let tasksWithDuration = 0;

  for (const record of filtered) {
    byStatus[record.status] = (byStatus[record.status] ?? 0) + 1;
    if (record.mode === "modify") byMode.modify++;
    else byMode.read_only++;

    effortCounts.set(record.effort, (effortCounts.get(record.effort) ?? 0) + 1);

    const alias: string = record.model.alias;
    const bucket = buckets.get(alias) ?? emptyBucket();
    if (!buckets.has(alias)) buckets.set(alias, bucket);

    bucket.tasks++;
    if (record.status === "completed") bucket.completed++;
    if (record.status === "failed" || record.status === "timed_out") bucket.failed++;

    const usage = record.outcome?.usage;
    if (usage) {
      const taskTotal = usage.totalTokens || usage.inputTokens + usage.outputTokens + usage.thinkingTokens;
      inputTokens += usage.inputTokens;
      outputTokens += usage.outputTokens;
      thinkingTokens += usage.thinkingTokens;
      totalTokens += taskTotal;
      bucket.tokens += taskTotal;
      tasksWithUsage++;
    }

    const duration = recordDurationSeconds(record);
    if (duration !== undefined) {
      totalDuration += duration;
      tasksWithDuration++;
      bucket.durationSum += duration;
      bucket.durationCount++;
    }
  }

  const totalTasks = filtered.length;
  const knownAliases = new Set<string>(MODEL_ALIASES);
  const extraAliases = [...buckets.keys()].filter((alias) => !knownAliases.has(alias)).sort();
  const orderedAliases = [...MODEL_ALIASES, ...extraAliases];

  const models: ModelStats[] = orderedAliases.map((alias) => {
    const b = buckets.get(alias) ?? emptyBucket();
    return {
      alias,
      retired: alias in RETIRED_MODEL_ALIASES,
      tasks: b.tasks,
      taskSharePct: roundPct(b.tasks, totalTasks),
      completed: b.completed,
      failed: b.failed,
      tokens: b.tokens,
      tokenSharePct: roundPct(b.tokens, totalTokens),
      avgDurationSeconds: b.durationCount > 0 ? Math.round(b.durationSum / b.durationCount) : undefined,
    };
  });

  const byEffort = EFFORTS.map((effort) => {
    const tasks = effortCounts.get(effort) ?? 0;
    return { effort, tasks, sharePct: roundPct(tasks, totalTasks) };
  }).filter((entry) => entry.tasks > 0);

  return {
    window,
    generatedAt: now.toISOString(),
    totalTasks,
    byStatus,
    byMode,
    byEffort,
    tokens: {
      input: inputTokens,
      output: outputTokens,
      thinking: thinkingTokens,
      total: totalTokens,
      tasksWithUsage,
    },
    durationSeconds: {
      total: Math.round(totalDuration),
      average: tasksWithDuration > 0 ? Math.round(totalDuration / tasksWithDuration) : undefined,
      tasksWithDuration,
    },
    models,
  };
}

export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(2)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}

export function formatDuration(seconds: number | undefined): string {
  if (seconds === undefined) return "-";
  const rounded = Math.round(seconds);
  if (rounded < 60) return `${rounded}s`;
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const secs = rounded % 60;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return secs > 0 ? `${minutes}m ${secs}s` : `${minutes}m`;
}

function shareBar(pct: number, width = 10): string {
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

export function formatStatsTable(stats: UsageStats, version: string): string {
  const lines: string[] = [`Relay Bridge ${version} — usage (${stats.window.label})`, ""];

  if (stats.totalTasks === 0) {
    lines.push("No delegated tasks found for this period.");
    return `${lines.join("\n")}\n`;
  }

  const rows = stats.models.map((m) => ({
    name: m.retired ? `${m.alias} (retired)` : m.alias,
    tasks: String(m.tasks),
    share: `${shareBar(m.taskSharePct)} ${m.taskSharePct.toFixed(1).padStart(5)}%`,
    done: m.tasks > 0 ? `${m.completed}/${m.tasks}` : "-",
    tokens: m.tokens > 0 ? formatTokens(m.tokens) : "-",
    tokenShare: stats.tokens.total > 0 && m.tokens > 0 ? `${m.tokenSharePct.toFixed(1)}%` : "-",
    avgTime: formatDuration(m.avgDurationSeconds),
  }));

  const col = {
    name: Math.max("Model".length, ...rows.map((r) => r.name.length)),
    tasks: Math.max("Tasks".length, ...rows.map((r) => r.tasks.length)),
    share: Math.max("Share".length, ...rows.map((r) => r.share.length)),
    done: Math.max("Done".length, ...rows.map((r) => r.done.length)),
    tokens: Math.max("Tokens".length, ...rows.map((r) => r.tokens.length)),
    tokenShare: Math.max("Tok %".length, ...rows.map((r) => r.tokenShare.length)),
    avgTime: Math.max("Avg time".length, ...rows.map((r) => r.avgTime.length)),
  };

  const header = [
    "Model".padEnd(col.name),
    "Tasks".padStart(col.tasks),
    "Share".padEnd(col.share),
    "Done".padStart(col.done),
    "Tokens".padStart(col.tokens),
    "Tok %".padStart(col.tokenShare),
    "Avg time".padStart(col.avgTime),
  ].join("  ");

  lines.push(header);
  lines.push("─".repeat(header.length));

  for (const row of rows) {
    lines.push(
      [
        row.name.padEnd(col.name),
        row.tasks.padStart(col.tasks),
        row.share.padEnd(col.share),
        row.done.padStart(col.done),
        row.tokens.padStart(col.tokens),
        row.tokenShare.padStart(col.tokenShare),
        row.avgTime.padStart(col.avgTime),
      ].join("  "),
    );
  }

  lines.push("");

  const statusParts = TASK_STATUSES.filter((status) => stats.byStatus[status] > 0).map(
    (status) => `${stats.byStatus[status]} ${status}`,
  );
  lines.push(
    `Total:   ${stats.totalTasks} task${stats.totalTasks === 1 ? "" : "s"} (${statusParts.join(" · ")}) · time ${formatDuration(stats.durationSeconds.total)}`,
  );

  if (stats.tokens.total > 0) {
    lines.push(
      `Tokens:  ${formatTokens(stats.tokens.total)} total (${formatTokens(stats.tokens.input)} in · ${formatTokens(stats.tokens.output)} out · ${formatTokens(stats.tokens.thinking)} thinking)`,
    );
  }

  if (stats.byEffort.length > 0) {
    const effortParts = stats.byEffort.map((e) => `${e.effort} ${e.tasks} (${Math.round(e.sharePct)}%)`);
    lines.push(`Efforts: ${effortParts.join(" · ")}`);
  }

  const modeParts = [
    stats.byMode.modify > 0
      ? `modify ${stats.byMode.modify} (${Math.round(roundPct(stats.byMode.modify, stats.totalTasks))}%)`
      : undefined,
    stats.byMode.read_only > 0
      ? `read_only ${stats.byMode.read_only} (${Math.round(roundPct(stats.byMode.read_only, stats.totalTasks))}%)`
      : undefined,
  ].filter((part): part is string => part !== undefined);
  if (modeParts.length > 0) {
    lines.push(`Modes:   ${modeParts.join(" · ")}`);
  }

  return `${lines.join("\n")}\n`;
}
