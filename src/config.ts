import { homedir } from "node:os";
import path from "node:path";

/**
 * Runtime configuration, from environment variables only (an MCP server gets its environment from the client's
 * registration: `claude mcp add -e KEY=value`). Every value has a default that works for a single user on macOS.
 */
export interface RelayConfig {
  /** Root of all local state: task records, logs, worktrees. RELAY_BRIDGE_HOME, default ~/.relay-bridge */
  readonly home: string;
  readonly tasksDir: string;
  /** Where task worktrees are created. RELAY_BRIDGE_WORKTREE_ROOT, default <home>/worktrees */
  readonly worktreesDir: string;
  /** The Antigravity CLI executable. RELAY_BRIDGE_AGY_PATH, default `agy` from PATH */
  readonly agyPath: string;
  /** Tasks running at the same time across every Relay Bridge instance. RELAY_BRIDGE_MAX_CONCURRENCY, default 3 */
  readonly maxConcurrentTasks: number;
  readonly defaultTimeoutMinutes: number;
  readonly maxTimeoutMinutes: number;
  /**
   * When set, working directories must be inside one of these roots. RELAY_BRIDGE_ALLOWED_ROOTS, separated by the
   * platform path delimiter (`:` on macOS). Empty = any directory that passes the built-in deny list.
   */
  readonly allowedRoots: readonly string[];
  /** Extra Antigravity permission rules for modifying tasks, e.g. `["command(cargo build)"]`. RELAY_BRIDGE_EXTRA_ALLOW (JSON array) */
  readonly extraAllowRules: readonly string[];
  /** How long discovered models stay cached. */
  readonly modelCacheTtlMs: number;
  /** How often a running task's event log is read and its record saved. */
  readonly pollIntervalMs: number;
  /** Grace period between asking the agent to stop (SIGINT) and terminating it (SIGTERM, then SIGKILL). */
  readonly killGraceMs: number;
}

function intFromEnv(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`Invalid configuration value "${value}": expected an integer from ${min} to ${max}`);
  }
  return parsed;
}

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return path.join(homedir(), value.slice(2));
  return value;
}

function parseRules(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every((rule) => typeof rule === "string" && /^[a-z_]+\(.+\)$/.test(rule))) {
    throw new Error('RELAY_BRIDGE_EXTRA_ALLOW must be a JSON array of rules such as ["command(cargo build)"]');
  }
  return parsed as string[];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  const home = path.resolve(expandHome(env.RELAY_BRIDGE_HOME ?? path.join(homedir(), ".relay-bridge")));
  const worktreesDir = path.resolve(expandHome(env.RELAY_BRIDGE_WORKTREE_ROOT ?? path.join(home, "worktrees")));
  const allowedRoots = (env.RELAY_BRIDGE_ALLOWED_ROOTS ?? "")
    .split(path.delimiter)
    .map((root) => root.trim())
    .filter(Boolean)
    .map((root) => path.resolve(expandHome(root)));

  return {
    home,
    tasksDir: path.join(home, "tasks"),
    worktreesDir,
    agyPath: env.RELAY_BRIDGE_AGY_PATH?.trim() || "agy",
    maxConcurrentTasks: intFromEnv(env.RELAY_BRIDGE_MAX_CONCURRENCY, 3, 1, 16),
    defaultTimeoutMinutes: intFromEnv(env.RELAY_BRIDGE_DEFAULT_TIMEOUT_MINUTES, 60, 1, 720),
    maxTimeoutMinutes: intFromEnv(env.RELAY_BRIDGE_MAX_TIMEOUT_MINUTES, 360, 1, 1440),
    allowedRoots,
    extraAllowRules: parseRules(env.RELAY_BRIDGE_EXTRA_ALLOW),
    modelCacheTtlMs: intFromEnv(env.RELAY_BRIDGE_MODEL_CACHE_SECONDS, 600, 0, 86_400) * 1000,
    pollIntervalMs: intFromEnv(env.RELAY_BRIDGE_POLL_MS, 1000, 50, 60_000),
    killGraceMs: intFromEnv(env.RELAY_BRIDGE_KILL_GRACE_MS, 15_000, 100, 120_000),
  };
}
