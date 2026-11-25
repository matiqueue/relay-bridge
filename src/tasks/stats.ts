import path from "node:path";
import { EFFORTS, MODEL_ALIASES, RETIRED_MODEL_ALIASES, type Effort, type ExecutionMode } from "../providers/types.js";
import { redact, truncate } from "../security/redact.js";
import { isTaskId } from "./store.js";
import { TASK_STATUSES, type TaskRecord, type TaskStatus } from "./types.js";

export const STATS_VIEWS = ["summary", "tasks", "models", "projects", "daily", "full"] as const;
export type StatsView = (typeof STATS_VIEWS)[number];

const VIEW_ALIASES: Readonly<Record<string, StatsView>> = {
  summary: "summary",
  overview: "summary",
  tasks: "tasks",
  task: "tasks",
  sessions: "tasks",
  session: "tasks",
  list: "tasks",
  recent: "tasks",
  models: "models",
  efforts: "models",
  projects: "projects",
  project: "projects",
  repos: "projects",
  repo: "projects",
  daily: "daily",
  days: "daily",
  timeline: "daily",
  full: "full",
};

export const SORT_KEYS = ["date", "tokens", "duration", "tasks"] as const;
export type SortKey = (typeof SORT_KEYS)[number];

export type TimeWindow =
  | { readonly kind: "all"; readonly label: string }
  | { readonly kind: "today"; readonly label: string }
  | { readonly kind: "yesterday"; readonly label: string }
  | { readonly kind: "hours"; readonly count: number; readonly label: string }
  | { readonly kind: "days"; readonly count: number; readonly label: string }
  | { readonly kind: "weeks"; readonly count: number; readonly label: string }
  | { readonly kind: "since"; readonly date: string; readonly label: string };

export interface StatsFilters {
  readonly models: readonly string[];
  readonly statuses: readonly TaskStatus[];
  readonly modes: readonly ExecutionMode[];
  readonly efforts: readonly Effort[];
  readonly project: string | undefined;
}

export interface StatsCliOptions {
  readonly view: StatsView;
  readonly taskId: string | undefined;
  readonly window: TimeWindow;
  readonly filters: StatsFilters;
  readonly limit: number;
  readonly sort: SortKey | undefined;
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

export interface ModelEffortStats {
  readonly alias: string;
  readonly effort: Effort;
  readonly retired: boolean;
  readonly tasks: number;
  readonly taskSharePct: number;
  readonly completed: number;
  readonly tokens: number;
  readonly avgDurationSeconds: number | undefined;
}

export interface ProjectStats {
  readonly project: string;
  readonly tasks: number;
  readonly taskSharePct: number;
  readonly completed: number;
  readonly failed: number;
  readonly tokens: number;
  readonly totalDurationSeconds: number;
  readonly topModel: string;
}

export interface DailyStats {
  readonly date: string;
  readonly tasks: number;
  readonly completed: number;
  readonly failed: number;
  readonly tokens: number;
  readonly totalDurationSeconds: number;
}

export interface TaskRow {
  readonly id: string;
  readonly createdAt: string;
  readonly alias: string;
  readonly effort: Effort;
  readonly mode: ExecutionMode;
  readonly status: TaskStatus;
  readonly steps: number;
  readonly toolCalls: number;
  readonly tokens: number;
  readonly durationSeconds: number | undefined;
  readonly project: string;
  readonly title: string;
  readonly revisionOf: string | undefined;
  readonly denials: number;
  readonly commits: number | undefined;
  readonly pushed: boolean | undefined;
}

export interface UsageStats {
  readonly window: TimeWindow;
  readonly filters: StatsFilters;
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
  readonly activity: {
    readonly totalSteps: number;
    readonly totalToolCalls: number;
    readonly avgToolCalls: number | undefined;
    readonly revisions: number;
    readonly tasksWithDenials: number;
    readonly totalDenials: number;
  };
  readonly models: readonly ModelStats[];
  readonly modelEfforts: readonly ModelEffortStats[];
  readonly projects: readonly ProjectStats[];
  readonly daily: readonly DailyStats[];
  readonly tasks: readonly TaskRow[];
}

export const STATS_HELP = `Usage: relay-stats [view | task-id] [window] [filters] [options]

Local Relay Bridge usage statistics from ~/.relay-bridge/tasks (zero LLM tokens).

Views (default: summary):
  summary            Model breakdown, totals, tokens, efforts, modes, activity
  tasks              Recent tasks / sessions (aliases: sessions, list, recent)
  models             Breakdown by model x effort (alias: efforts)
  projects           Breakdown by repository (alias: repos)
  daily              Day-by-day activity table (aliases: days, timeline)
  full               All sections combined
  <task-id>          Detailed card for one task (e.g. rb-20261124-abc123)

Time windows (default: all):
  all                All recorded tasks
  today              Tasks created since local midnight
  yesterday          Tasks created yesterday
  <n>h / <n>d / <n>w Last N hours, days or weeks (e.g. 24h, 7d, 2w)
  --since YYYY-MM-DD Tasks created on or after a local date
  --days <n>         Alias for <n>d

Filters (combine freely, comma-separated values supported):
  -m, --model <list>   Filter by model alias (e.g. neon,carbon)
  -s, --status <list>  Filter by status (e.g. failed,timed_out or running,queued)
  -e, --effort <list>  Filter by effort (low, medium, high, xhigh, max)
  --mode <list>        Filter by mode (modify, read_only)
  -p, --project <name> Filter by project name (substring, case-insensitive)

Options:
  -v, --view <name>    Explicitly select a view (summary, tasks, models, projects, daily, full)
  -w, --window <spec>  Explicitly select a window (all, today, yesterday, <n>h, <n>d, <n>w)
  -n, --limit <n>      Max rows for tasks / projects / daily (default: 20)
  --sort <key>         Sort rows by: date | tokens | duration | tasks
  --json               Output machine-readable JSON
  -h, --help           Show this help message

Examples:
  relay-stats                           Summary of all tasks
  relay-stats 7d                        Summary of the last 7 days
  relay-stats sessions 24h              Tasks from the last 24 hours
  relay-stats tasks -s failed,timed_out Only failed or timed-out tasks
  relay-stats projects --sort tokens    Projects ranked by token usage
  relay-stats full today                Full breakdown for today
`;

const EMPTY_FILTERS: StatsFilters = {
  models: [],
  statuses: [],
  modes: [],
  efforts: [],
  project: undefined,
};

function parsePositiveInt(raw: string, flag: string): number {
  if (!/^\d+$/.test(raw)) throw new Error(`Invalid value "${raw}" for ${flag}: expected a positive integer.`);
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid value "${raw}" for ${flag}: expected a positive integer.`);
  }
  return parsed;
}

function splitList(raw: string, flag: string): string[] {
  const values = raw
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
  if (values.length === 0) throw new Error(`Missing value for ${flag}.`);
  return values;
}

function validateEnumList<T extends string>(raw: string, flag: string, allowed: readonly T[]): T[] {
  const values = splitList(raw, flag);
  for (const value of values) {
    if (!(allowed as readonly string[]).includes(value)) {
      throw new Error(`Invalid value "${value}" for ${flag}. Expected one of: ${allowed.join(", ")}.`);
    }
  }
  return values as T[];
}

function parseWindowToken(token: string): TimeWindow | undefined {
  const lower = token.toLowerCase();
  if (lower === "all") return { kind: "all", label: "all time" };
  if (lower === "today") return { kind: "today", label: "today" };
  if (lower === "yesterday") return { kind: "yesterday", label: "yesterday" };
  const relMatch = /^(\d+)([hdw])$/i.exec(token);
  if (relMatch?.[1] && relMatch[2]) {
    const count = parsePositiveInt(relMatch[1], token);
    const unit = relMatch[2].toLowerCase();
    if (unit === "h") return { kind: "hours", count, label: `last ${count}h` };
    if (unit === "d") return { kind: "days", count, label: `last ${count}d` };
    return { kind: "weeks", count, label: `last ${count}w` };
  }
  return undefined;
}

function parseSinceDate(raw: string): TimeWindow {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (!match) throw new Error(`Invalid date "${raw}" for --since: expected YYYY-MM-DD.`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(year, month - 1, day);
  if (probe.getFullYear() !== year || probe.getMonth() !== month - 1 || probe.getDate() !== day) {
    throw new Error(`Invalid calendar date "${raw}" for --since.`);
  }
  return { kind: "since", date: raw.trim(), label: `since ${raw.trim()}` };
}

function takeFlagValue(argv: readonly string[], index: number, flag: string): { value: string; nextIndex: number } {
  const current = argv[index] ?? "";
  const eq = current.indexOf("=");
  if (eq >= 0) {
    const value = current.slice(eq + 1);
    if (!value) throw new Error(`Missing value for ${flag}.`);
    return { value, nextIndex: index };
  }
  const value = argv[index + 1];
  if (!value) throw new Error(`Missing value for ${flag}.`);
  return { value, nextIndex: index + 1 };
}

export function parseStatsArgs(argv: readonly string[]): StatsCliOptions {
  let view: StatsView = "summary";
  let viewSet = false;
  let taskId: string | undefined;
  let window: TimeWindow = { kind: "all", label: "all time" };
  let windowSet = false;
  let limit = 20;
  let sort: SortKey | undefined;
  let json = false;
  let help = false;

  const models: string[] = [];
  const statuses: TaskStatus[] = [];
  const modes: ExecutionMode[] = [];
  const efforts: Effort[] = [];
  let project: string | undefined;

  const setView = (next: StatsView) => {
    if (viewSet || taskId) throw new Error(`Only one view or task id can be specified (got "${next}").`);
    view = next;
    viewSet = true;
  };

  const setWindow = (next: TimeWindow) => {
    if (windowSet) {
      throw new Error(`Only one time window can be specified (got "${next.label}" after "${window.label}").`);
    }
    window = next;
    windowSet = true;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    const flagName = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;

    if (arg === "-h" || arg === "--help") {
      help = true;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (flagName === "-v" || flagName === "--view") {
      const { value, nextIndex } = takeFlagValue(argv, i, flagName);
      i = nextIndex;
      const mapped = VIEW_ALIASES[value.trim().toLowerCase()];
      if (!mapped) throw new Error(`Invalid view "${value}". Expected one of: ${STATS_VIEWS.join(", ")}.`);
      setView(mapped);
      continue;
    }
    if (flagName === "-w" || flagName === "--window") {
      const { value, nextIndex } = takeFlagValue(argv, i, flagName);
      i = nextIndex;
      const parsedWindow = parseWindowToken(value.trim());
      if (!parsedWindow) {
        throw new Error(`Invalid window "${value}". Expected: all, today, yesterday, <n>h, <n>d, or <n>w.`);
      }
      setWindow(parsedWindow);
      continue;
    }
    if (flagName === "--days") {
      const { value, nextIndex } = takeFlagValue(argv, i, "--days");
      i = nextIndex;
      const count = parsePositiveInt(value, "--days");
      setWindow({ kind: "days", count, label: `last ${count}d` });
      continue;
    }
    if (flagName === "--since") {
      const { value, nextIndex } = takeFlagValue(argv, i, "--since");
      i = nextIndex;
      setWindow(parseSinceDate(value));
      continue;
    }
    if (flagName === "-m" || flagName === "--model") {
      const { value, nextIndex } = takeFlagValue(argv, i, flagName);
      i = nextIndex;
      models.push(...splitList(value, flagName));
      continue;
    }
    if (flagName === "-s" || flagName === "--status") {
      const { value, nextIndex } = takeFlagValue(argv, i, flagName);
      i = nextIndex;
      statuses.push(...validateEnumList(value, flagName, TASK_STATUSES));
      continue;
    }
    if (flagName === "-e" || flagName === "--effort") {
      const { value, nextIndex } = takeFlagValue(argv, i, flagName);
      i = nextIndex;
      efforts.push(...validateEnumList(value, flagName, EFFORTS));
      continue;
    }
    if (flagName === "--mode") {
      const { value, nextIndex } = takeFlagValue(argv, i, flagName);
      i = nextIndex;
      modes.push(...validateEnumList(value, flagName, ["modify", "read_only"] as const));
      continue;
    }
    if (flagName === "-p" || flagName === "--project") {
      const { value, nextIndex } = takeFlagValue(argv, i, flagName);
      i = nextIndex;
      project = value.trim();
      continue;
    }
    if (flagName === "-n" || flagName === "--limit") {
      const { value, nextIndex } = takeFlagValue(argv, i, flagName);
      i = nextIndex;
      limit = parsePositiveInt(value, flagName);
      continue;
    }
    if (flagName === "--sort") {
      const { value, nextIndex } = takeFlagValue(argv, i, flagName);
      i = nextIndex;
      const [key] = validateEnumList(value, flagName, SORT_KEYS);
      sort = key;
      continue;
    }

    if (isTaskId(arg)) {
      if (viewSet || taskId) throw new Error(`Only one view or task id can be specified (got "${arg}").`);
      taskId = arg;
      continue;
    }

    const lower = arg.toLowerCase();
    const mappedView = VIEW_ALIASES[lower];
    if (mappedView) {
      setView(mappedView);
      continue;
    }
    const parsedWindow = parseWindowToken(arg);
    if (parsedWindow) {
      setWindow(parsedWindow);
      continue;
    }

    throw new Error(`Unknown argument "${arg}". Run with --help for usage.`);
  }

  return {
    view,
    taskId,
    window,
    filters: {
      models: [...new Set(models)],
      statuses: [...new Set(statuses)],
      modes: [...new Set(modes)],
      efforts: [...new Set(efforts)],
      project,
    },
    limit,
    sort,
    json,
    help,
  };
}

function windowBoundsMs(window: TimeWindow, now: Date): { min?: number; max?: number } {
  switch (window.kind) {
    case "all":
      return {};
    case "today":
      return { min: new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() };
    case "yesterday": {
      const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
      const startYesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime();
      return { min: startYesterday, max: startToday };
    }
    case "hours":
      return { min: now.getTime() - window.count * 60 * 60 * 1000 };
    case "days":
      return { min: now.getTime() - window.count * 24 * 60 * 60 * 1000 };
    case "weeks":
      return { min: now.getTime() - window.count * 7 * 24 * 60 * 60 * 1000 };
    case "since": {
      const [y = 0, m = 1, d = 1] = window.date.split("-").map(Number);
      return { min: new Date(y, m - 1, d).getTime() };
    }
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

function recordTokens(record: TaskRecord): number {
  const usage = record.outcome?.usage;
  if (!usage) return 0;
  return usage.totalTokens || usage.inputTokens + usage.outputTokens + usage.thinkingTokens;
}

function projectName(workingDirectory: string): string {
  const base = path.basename(workingDirectory.replace(/[\\/]+$/, ""));
  return base || workingDirectory;
}

function localDateKey(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso.slice(0, 10);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function roundPct(part: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((part / total) * 1000) / 10;
}

function matchesFilters(record: TaskRecord, filters: StatsFilters): boolean {
  if (filters.models.length > 0 && !filters.models.includes(String(record.model.alias).toLowerCase())) return false;
  if (filters.statuses.length > 0 && !filters.statuses.includes(record.status)) return false;
  if (filters.modes.length > 0 && !filters.modes.includes(record.mode)) return false;
  if (filters.efforts.length > 0 && !filters.efforts.includes(record.effort)) return false;
  if (filters.project) {
    const needle = filters.project.toLowerCase();
    if (!projectName(record.workingDirectory).toLowerCase().includes(needle)) return false;
  }
  return true;
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
  options: {
    readonly window?: TimeWindow | undefined;
    readonly filters?: StatsFilters | undefined;
    readonly sort?: SortKey | undefined;
    readonly now?: Date | undefined;
  } = {},
): UsageStats {
  const now = options.now ?? new Date();
  const window: TimeWindow = options.window ?? { kind: "all", label: "all time" };
  const filters: StatsFilters = options.filters ?? EMPTY_FILTERS;
  const bounds = windowBoundsMs(window, now);

  const filtered = records.filter((record) => {
    if (bounds.min !== undefined || bounds.max !== undefined) {
      const created = Date.parse(record.createdAt);
      if (!Number.isFinite(created)) return false;
      if (bounds.min !== undefined && created < bounds.min) return false;
      if (bounds.max !== undefined && created >= bounds.max) return false;
    }
    return matchesFilters(record, filters);
  });

  const byStatus = Object.fromEntries(TASK_STATUSES.map((s) => [s, 0])) as Record<TaskStatus, number>;
  const byMode = { modify: 0, read_only: 0 };
  const effortCounts = new Map<Effort, number>();
  const buckets = new Map<string, ModelBucket>();
  const modelEffortBuckets = new Map<string, { alias: string; effort: Effort; bucket: ModelBucket }>();
  const projectBuckets = new Map<
    string,
    { tasks: number; completed: number; failed: number; tokens: number; duration: number; models: Map<string, number> }
  >();
  const dailyBuckets = new Map<
    string,
    { tasks: number; completed: number; failed: number; tokens: number; duration: number }
  >();

  for (const alias of MODEL_ALIASES) buckets.set(alias, emptyBucket());

  let inputTokens = 0;
  let outputTokens = 0;
  let thinkingTokens = 0;
  let totalTokens = 0;
  let tasksWithUsage = 0;
  let totalDuration = 0;
  let tasksWithDuration = 0;
  let totalSteps = 0;
  let totalToolCalls = 0;
  let revisions = 0;
  let tasksWithDenials = 0;
  let totalDenials = 0;

  const taskRows: TaskRow[] = [];

  for (const record of filtered) {
    byStatus[record.status] = (byStatus[record.status] ?? 0) + 1;
    if (record.mode === "modify") byMode.modify++;
    else byMode.read_only++;

    effortCounts.set(record.effort, (effortCounts.get(record.effort) ?? 0) + 1);

    const alias: string = record.model.alias;
    const isCompleted = record.status === "completed";
    const isFailed = record.status === "failed" || record.status === "timed_out";

    const bucket = buckets.get(alias) ?? emptyBucket();
    if (!buckets.has(alias)) buckets.set(alias, bucket);
    bucket.tasks++;
    if (isCompleted) bucket.completed++;
    if (isFailed) bucket.failed++;

    const meKey = `${alias}:${record.effort}`;
    const meEntry = modelEffortBuckets.get(meKey) ?? { alias, effort: record.effort, bucket: emptyBucket() };
    if (!modelEffortBuckets.has(meKey)) modelEffortBuckets.set(meKey, meEntry);
    meEntry.bucket.tasks++;
    if (isCompleted) meEntry.bucket.completed++;

    const proj = projectName(record.workingDirectory);
    const projEntry = projectBuckets.get(proj) ?? {
      tasks: 0,
      completed: 0,
      failed: 0,
      tokens: 0,
      duration: 0,
      models: new Map<string, number>(),
    };
    if (!projectBuckets.has(proj)) projectBuckets.set(proj, projEntry);
    projEntry.tasks++;
    if (isCompleted) projEntry.completed++;
    if (isFailed) projEntry.failed++;
    projEntry.models.set(alias, (projEntry.models.get(alias) ?? 0) + 1);

    const dayKey = localDateKey(record.createdAt);
    const dayEntry = dailyBuckets.get(dayKey) ?? { tasks: 0, completed: 0, failed: 0, tokens: 0, duration: 0 };
    if (!dailyBuckets.has(dayKey)) dailyBuckets.set(dayKey, dayEntry);
    dayEntry.tasks++;
    if (isCompleted) dayEntry.completed++;
    if (isFailed) dayEntry.failed++;

    const usage = record.outcome?.usage;
    const taskTotalTokens = recordTokens(record);
    if (usage) {
      inputTokens += usage.inputTokens;
      outputTokens += usage.outputTokens;
      thinkingTokens += usage.thinkingTokens;
      totalTokens += taskTotalTokens;
      bucket.tokens += taskTotalTokens;
      meEntry.bucket.tokens += taskTotalTokens;
      projEntry.tokens += taskTotalTokens;
      dayEntry.tokens += taskTotalTokens;
      tasksWithUsage++;
    }

    const duration = recordDurationSeconds(record);
    if (duration !== undefined) {
      totalDuration += duration;
      tasksWithDuration++;
      bucket.durationSum += duration;
      bucket.durationCount++;
      meEntry.bucket.durationSum += duration;
      meEntry.bucket.durationCount++;
      projEntry.duration += duration;
      dayEntry.duration += duration;
    }

    totalSteps += record.progress.steps;
    totalToolCalls += record.progress.toolCalls;
    if (record.revisionOf) revisions++;
    const denials = record.progress.permissionDenials.length;
    if (denials > 0) {
      tasksWithDenials++;
      totalDenials += denials;
    }

    const gitVerification = record.verification?.kind === "git" ? record.verification : undefined;
    taskRows.push({
      id: record.id,
      createdAt: record.createdAt,
      alias,
      effort: record.effort,
      mode: record.mode,
      status: record.status,
      steps: record.progress.steps,
      toolCalls: record.progress.toolCalls,
      tokens: taskTotalTokens,
      durationSeconds: duration !== undefined ? Math.round(duration) : undefined,
      project: proj,
      title: truncate(redact(record.title), 52),
      revisionOf: record.revisionOf,
      denials,
      commits: gitVerification?.commits.length,
      pushed: gitVerification?.pushed,
    });
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

  const aliasOrder = new Map(orderedAliases.map((alias, index) => [alias, index]));
  const effortOrder = new Map<string, number>(EFFORTS.map((effort, index) => [effort, index]));
  const modelEfforts: ModelEffortStats[] = [...modelEffortBuckets.values()]
    .map(({ alias, effort, bucket }) => ({
      alias,
      effort,
      retired: alias in RETIRED_MODEL_ALIASES,
      tasks: bucket.tasks,
      taskSharePct: roundPct(bucket.tasks, totalTasks),
      completed: bucket.completed,
      tokens: bucket.tokens,
      avgDurationSeconds: bucket.durationCount > 0 ? Math.round(bucket.durationSum / bucket.durationCount) : undefined,
    }))
    .sort((a, b) => {
      if (options.sort === "tokens") return b.tokens - a.tokens || b.tasks - a.tasks;
      if (options.sort === "duration") return (b.avgDurationSeconds ?? -1) - (a.avgDurationSeconds ?? -1);
      if (options.sort === "tasks") return b.tasks - a.tasks || b.tokens - a.tokens;
      return (
        (aliasOrder.get(a.alias) ?? 99) - (aliasOrder.get(b.alias) ?? 99) ||
        (effortOrder.get(a.effort) ?? 99) - (effortOrder.get(b.effort) ?? 99)
      );
    });

  const projects: ProjectStats[] = [...projectBuckets.entries()]
    .map(([project, entry]) => {
      const topModel =
        [...entry.models.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? "-";
      return {
        project,
        tasks: entry.tasks,
        taskSharePct: roundPct(entry.tasks, totalTasks),
        completed: entry.completed,
        failed: entry.failed,
        tokens: entry.tokens,
        totalDurationSeconds: Math.round(entry.duration),
        topModel,
      };
    })
    .sort((a, b) => {
      if (options.sort === "tokens") return b.tokens - a.tokens || b.tasks - a.tasks;
      if (options.sort === "duration") return b.totalDurationSeconds - a.totalDurationSeconds;
      return b.tasks - a.tasks || b.tokens - a.tokens || a.project.localeCompare(b.project);
    });

  const daily: DailyStats[] = [...dailyBuckets.entries()]
    .map(([date, entry]) => ({
      date,
      tasks: entry.tasks,
      completed: entry.completed,
      failed: entry.failed,
      tokens: entry.tokens,
      totalDurationSeconds: Math.round(entry.duration),
    }))
    .sort((a, b) => {
      if (options.sort === "tokens") return b.tokens - a.tokens;
      if (options.sort === "duration") return b.totalDurationSeconds - a.totalDurationSeconds;
      if (options.sort === "tasks") return b.tasks - a.tasks;
      return b.date.localeCompare(a.date);
    });

  taskRows.sort((a, b) => {
    if (options.sort === "tokens") return b.tokens - a.tokens || b.createdAt.localeCompare(a.createdAt);
    if (options.sort === "duration") {
      return (b.durationSeconds ?? -1) - (a.durationSeconds ?? -1) || b.createdAt.localeCompare(a.createdAt);
    }
    return b.createdAt.localeCompare(a.createdAt);
  });

  const byEffort = EFFORTS.map((effort) => {
    const tasks = effortCounts.get(effort) ?? 0;
    return { effort, tasks, sharePct: roundPct(tasks, totalTasks) };
  }).filter((entry) => entry.tasks > 0);

  return {
    window,
    filters,
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
    activity: {
      totalSteps,
      totalToolCalls,
      avgToolCalls: totalTasks > 0 ? Math.round((totalToolCalls / totalTasks) * 10) / 10 : undefined,
      revisions,
      tasksWithDenials,
      totalDenials,
    },
    models,
    modelEfforts,
    projects,
    daily,
    tasks: taskRows,
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

interface ColumnDef<Row> {
  readonly header: string;
  readonly align?: "left" | "right";
  readonly value: (row: Row) => string;
}

function renderTable<Row>(columns: readonly ColumnDef<Row>[], rows: readonly Row[]): string[] {
  const cells = rows.map((row) => columns.map((col) => col.value(row)));
  const widths = columns.map((col, idx) => Math.max(col.header.length, ...cells.map((r) => (r[idx] ?? "").length)));
  const pad = (text: string, width: number, align: "left" | "right" = "left") =>
    align === "right" ? text.padStart(width) : text.padEnd(width);
  const header = columns.map((col, idx) => pad(col.header, widths[idx] ?? 0, col.align)).join("  ");
  return [
    header,
    "─".repeat(header.length),
    ...cells.map((row) => row.map((cell, idx) => pad(cell, widths[idx] ?? 0, columns[idx]?.align)).join("  ")),
  ];
}

function activeFiltersLabel(filters: StatsFilters): string {
  const parts: string[] = [];
  if (filters.models.length > 0) parts.push(`model=${filters.models.join(",")}`);
  if (filters.statuses.length > 0) parts.push(`status=${filters.statuses.join(",")}`);
  if (filters.efforts.length > 0) parts.push(`effort=${filters.efforts.join(",")}`);
  if (filters.modes.length > 0) parts.push(`mode=${filters.modes.join(",")}`);
  if (filters.project) parts.push(`project~${filters.project}`);
  return parts.join(", ");
}

function headerLine(stats: UsageStats, version: string, viewLabel?: string): string {
  const filterText = activeFiltersLabel(stats.filters);
  const scope = [stats.window.label, filterText].filter(Boolean).join(" · ");
  const title = viewLabel ? `usage / ${viewLabel}` : "usage";
  return `Relay Bridge ${version} — ${title} (${scope})`;
}

function renderSummarySection(stats: UsageStats): string[] {
  const lines = renderTable(
    [
      { header: "Model", value: (m) => (m.retired ? `${m.alias} (retired)` : m.alias) },
      { header: "Tasks", align: "right", value: (m) => String(m.tasks) },
      { header: "Share", value: (m) => `${shareBar(m.taskSharePct)} ${m.taskSharePct.toFixed(1).padStart(5)}%` },
      { header: "Done", align: "right", value: (m) => (m.tasks > 0 ? `${m.completed}/${m.tasks}` : "-") },
      { header: "Tokens", align: "right", value: (m) => (m.tokens > 0 ? formatTokens(m.tokens) : "-") },
      {
        header: "Tok %",
        align: "right",
        value: (m) => (stats.tokens.total > 0 && m.tokens > 0 ? `${m.tokenSharePct.toFixed(1)}%` : "-"),
      },
      { header: "Avg time", align: "right", value: (m) => formatDuration(m.avgDurationSeconds) },
    ],
    stats.models,
  );

  lines.push("");

  const statusParts = TASK_STATUSES.filter((status) => stats.byStatus[status] > 0).map(
    (status) => `${stats.byStatus[status]} ${status}`,
  );
  lines.push(
    `Total:    ${stats.totalTasks} task${stats.totalTasks === 1 ? "" : "s"} (${statusParts.join(" · ")}) · time ${formatDuration(stats.durationSeconds.total)}`,
  );

  if (stats.tokens.total > 0) {
    lines.push(
      `Tokens:   ${formatTokens(stats.tokens.total)} total (${formatTokens(stats.tokens.input)} in · ${formatTokens(stats.tokens.output)} out · ${formatTokens(stats.tokens.thinking)} thinking)`,
    );
  }

  if (stats.byEffort.length > 0) {
    const effortParts = stats.byEffort.map((e) => `${e.effort} ${e.tasks} (${Math.round(e.sharePct)}%)`);
    lines.push(`Efforts:  ${effortParts.join(" · ")}`);
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
    lines.push(`Modes:    ${modeParts.join(" · ")}`);
  }

  const activityParts = [
    `${stats.activity.totalToolCalls} tool calls${stats.activity.avgToolCalls !== undefined ? ` (avg ${stats.activity.avgToolCalls}/task)` : ""}`,
    stats.activity.revisions > 0 ? `${stats.activity.revisions} revisions` : undefined,
    stats.activity.totalDenials > 0
      ? `${stats.activity.totalDenials} denials in ${stats.activity.tasksWithDenials} task${stats.activity.tasksWithDenials === 1 ? "" : "s"}`
      : undefined,
  ].filter((part): part is string => part !== undefined);
  lines.push(`Activity: ${activityParts.join(" · ")}`);

  return lines;
}

function renderModelsSection(stats: UsageStats): string[] {
  return renderTable(
    [
      { header: "Model", value: (m) => (m.retired ? `${m.alias} (retired)` : m.alias) },
      { header: "Effort", value: (m) => m.effort },
      { header: "Tasks", align: "right", value: (m) => String(m.tasks) },
      { header: "Share", value: (m) => `${shareBar(m.taskSharePct)} ${m.taskSharePct.toFixed(1).padStart(5)}%` },
      { header: "Done", align: "right", value: (m) => `${m.completed}/${m.tasks}` },
      { header: "Tokens", align: "right", value: (m) => (m.tokens > 0 ? formatTokens(m.tokens) : "-") },
      { header: "Avg time", align: "right", value: (m) => formatDuration(m.avgDurationSeconds) },
    ],
    stats.modelEfforts,
  );
}

function renderProjectsSection(stats: UsageStats, limit: number): string[] {
  const shown = stats.projects.slice(0, limit);
  const lines = renderTable(
    [
      { header: "Project", value: (p) => truncate(p.project, 28) },
      { header: "Tasks", align: "right", value: (p) => String(p.tasks) },
      { header: "Share", value: (p) => `${shareBar(p.taskSharePct)} ${p.taskSharePct.toFixed(1).padStart(5)}%` },
      { header: "Done", align: "right", value: (p) => `${p.completed}/${p.tasks}` },
      { header: "Tokens", align: "right", value: (p) => (p.tokens > 0 ? formatTokens(p.tokens) : "-") },
      { header: "Time", align: "right", value: (p) => formatDuration(p.totalDurationSeconds) },
      { header: "Top model", value: (p) => p.topModel },
    ],
    shown,
  );
  if (stats.projects.length > shown.length) {
    lines.push("", `Showing ${shown.length} of ${stats.projects.length} projects (use --limit to show more).`);
  }
  return lines;
}

function renderDailySection(stats: UsageStats, limit: number): string[] {
  const shown = stats.daily.slice(0, limit);
  const maxTasks = Math.max(1, ...shown.map((d) => d.tasks));
  const lines = renderTable(
    [
      { header: "Date", value: (d) => d.date },
      { header: "Tasks", align: "right", value: (d) => String(d.tasks) },
      { header: "Activity", value: (d) => shareBar((d.tasks / maxTasks) * 100, 12) },
      { header: "Done", align: "right", value: (d) => `${d.completed}/${d.tasks}` },
      { header: "Tokens", align: "right", value: (d) => (d.tokens > 0 ? formatTokens(d.tokens) : "-") },
      { header: "Time", align: "right", value: (d) => formatDuration(d.totalDurationSeconds) },
    ],
    shown,
  );
  if (stats.daily.length > shown.length) {
    lines.push("", `Showing ${shown.length} of ${stats.daily.length} days (use --limit to show more).`);
  }
  return lines;
}

function shortTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso.slice(5, 16).replace("T", " ");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${min}`;
}

function renderTasksSection(stats: UsageStats, limit: number): string[] {
  const shown = stats.tasks.slice(0, limit);
  const lines = renderTable(
    [
      { header: "Task ID", value: (t) => t.id },
      { header: "When", value: (t) => shortTimestamp(t.createdAt) },
      { header: "Model", value: (t) => `${t.alias}/${t.effort}` },
      { header: "Status", value: (t) => t.status },
      { header: "Tools", align: "right", value: (t) => String(t.toolCalls) },
      { header: "Tokens", align: "right", value: (t) => (t.tokens > 0 ? formatTokens(t.tokens) : "-") },
      { header: "Time", align: "right", value: (t) => formatDuration(t.durationSeconds) },
      { header: "Project", value: (t) => truncate(t.project, 20) },
      { header: "Title", value: (t) => truncate(t.title, 36) },
    ],
    shown,
  );
  if (stats.tasks.length > shown.length) {
    lines.push("", `Showing ${shown.length} of ${stats.tasks.length} tasks (use --limit to show more).`);
  }
  return lines;
}

export function formatStatsTable(stats: UsageStats, version: string, view: StatsView = "summary", limit = 20): string {
  const viewLabel = view === "summary" ? undefined : view;
  const lines: string[] = [headerLine(stats, version, viewLabel), ""];

  if (stats.totalTasks === 0) {
    lines.push("No delegated tasks found for this period.");
    return `${lines.join("\n")}\n`;
  }

  switch (view) {
    case "summary":
      lines.push(...renderSummarySection(stats));
      break;
    case "models":
      lines.push(...renderModelsSection(stats));
      break;
    case "projects":
      lines.push(...renderProjectsSection(stats, limit));
      break;
    case "daily":
      lines.push(...renderDailySection(stats, limit));
      break;
    case "tasks":
      lines.push(...renderTasksSection(stats, limit));
      break;
    case "full":
      lines.push(...renderSummarySection(stats));
      lines.push("", "Model x effort", "", ...renderModelsSection(stats));
      lines.push("", "Projects", "", ...renderProjectsSection(stats, limit));
      lines.push("", "Daily activity", "", ...renderDailySection(stats, Math.min(limit, 14)));
      lines.push("", "Recent tasks", "", ...renderTasksSection(stats, Math.min(limit, 10)));
      break;
  }

  return `${lines.join("\n")}\n`;
}

export function formatTaskDetail(record: TaskRecord, version: string): string {
  const duration = recordDurationSeconds(record);
  const usage = record.outcome?.usage;
  const totalTokens = recordTokens(record);
  const lines = [
    `Relay Bridge ${version} — task ${record.id}`,
    "",
    `Title:    ${redact(record.title)}`,
    `Status:   ${record.status}${record.revisionOf ? ` (revision ${record.revisionNumber} of ${record.revisionOf})` : ""}`,
    `Model:    ${record.model.alias} (${record.model.label}) · effort ${record.effort}`,
    `Mode:     ${record.mode} (${record.isolation}) · project ${projectName(record.workingDirectory)}`,
    `Created:  ${shortTimestamp(record.createdAt)} · duration ${formatDuration(duration)}`,
    `Progress: ${record.progress.steps} steps · ${record.progress.toolCalls} tool calls · ${record.progress.permissionDenials.length} denials`,
  ];
  if (usage) {
    lines.push(
      `Tokens:   ${formatTokens(totalTokens)} total (${formatTokens(usage.inputTokens)} in · ${formatTokens(usage.outputTokens)} out · ${formatTokens(usage.thinkingTokens)} thinking)`,
    );
  }
  if (record.git) {
    const v = record.verification?.kind === "git" ? record.verification : undefined;
    lines.push(
      `Git:      branch ${record.git.branch}${v ? ` · ${v.commits.length} commit${v.commits.length === 1 ? "" : "s"} · pushed ${v.pushed ? "yes" : "no"}` : ""}`,
    );
    if (v?.pullRequest) {
      lines.push(`PR:       #${v.pullRequest.number} (${v.pullRequest.state}${v.pullRequest.draft ? ", draft" : ""})`);
    }
    if (v && v.mismatches.length > 0) {
      lines.push(`Mismatch: ${v.mismatches.length} report mismatch(es)`);
    }
  }
  if (record.outcome?.error) {
    lines.push(`Error:    ${truncate(redact(record.outcome.error), 200)}`);
  }
  if (record.progress.permissionDenials.length > 0) {
    lines.push(`Denials:  ${record.progress.permissionDenials.slice(0, 3).join("; ")}`);
  }
  return `${lines.join("\n")}\n`;
}
