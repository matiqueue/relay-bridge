import type { AgentReport } from "../prompt/report.js";
import type { Effort, ExecutionMode, ModelAlias, TokenUsage } from "../providers/types.js";

export const TASK_STATUSES = [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "timed_out",
  "awaiting_input",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Statuses after which the agent process is gone and the record no longer changes. */
export const FINISHED_STATUSES: readonly TaskStatus[] = [
  "completed",
  "failed",
  "cancelled",
  "timed_out",
  "awaiting_input",
];

export function isFinished(status: TaskStatus): boolean {
  return FINISHED_STATUSES.includes(status);
}

export type Isolation = "worktree" | "in_place" | "read_only";

export interface TaskGit {
  readonly repoRoot: string;
  readonly commonDir: string;
  readonly baseRef: string;
  readonly baseSha: string;
  /** HEAD when this run started: the base for a new task, the previous run's last commit for a revision. */
  readonly startSha: string;
  readonly branch: string;
  /** False when the task reuses an existing branch (a revision). */
  readonly createdBranch: boolean;
  readonly worktreePath: string | undefined;
  readonly allowCommit: boolean;
  readonly allowPush: boolean;
  readonly allowPullRequest: boolean;
  readonly pullRequestBase: string | undefined;
}

export interface TaskProgress {
  steps: number;
  toolCalls: number;
  lastActivityAt: string | undefined;
  lastTool: { name: string; summary: string | undefined; at: string } | undefined;
  /** The latest response text fragment, shortened. */
  lastMessage: string | undefined;
  recentTools: { name: string; summary: string | undefined; error: string | undefined }[];
  permissionDenials: string[];
  /** Byte offset up to which the event log has been read. */
  eventsOffset: number;
}

export interface TaskProcess {
  readonly pid: number;
  readonly startedAt: string;
  readonly displayCommand: readonly string[];
}

export interface TaskOutcome {
  readonly cliStatus: string | undefined;
  readonly finishedReason: string | undefined;
  readonly exitCode: number | null | undefined;
  readonly signal: string | null | undefined;
  readonly error: string | undefined;
  readonly response: string | undefined;
  readonly usage: TokenUsage | undefined;
  readonly durationSeconds: number | undefined;
}

export interface GitVerification {
  readonly kind: "git";
  readonly checkedAt: string;
  readonly branch: string | undefined;
  readonly headSha: string | undefined;
  readonly baseSha: string;
  readonly commits: readonly { sha: string; subject: string }[];
  readonly committedFiles: readonly { status: string; path: string; from?: string | undefined }[];
  readonly uncommitted: readonly { status: string; path: string }[];
  readonly upstream: string | undefined;
  readonly pushed: boolean;
  readonly aheadOfUpstream: number;
  readonly pullRequest: { url: string; number: number; state: string; draft: boolean } | undefined;
  /** Paths that changed in the original checkout while the task ran (the agent's, yours or the user's). */
  readonly originalCheckoutChanges: readonly string[];
  readonly mismatches: readonly string[];
}

export interface ReadOnlyVerification {
  readonly kind: "read_only";
  readonly checkedAt: string;
  readonly checked: boolean;
  /** Paths whose state changed in the repository while the task ran. */
  readonly changedPaths: readonly string[];
  readonly headMoved: boolean;
  readonly note: string;
}

export interface CheckoutSnapshot {
  readonly head: string | undefined;
  readonly status: readonly string[];
  readonly branches: readonly string[];
}

export interface TaskRecord {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly provider: string;
  readonly model: { readonly alias: ModelAlias; readonly id: string; readonly label: string };
  readonly effort: Effort;
  readonly title: string;
  readonly task: string;
  readonly mode: ExecutionMode;
  readonly isolation: Isolation;
  /** The validated directory the orchestrator passed (the repository root for git repositories). */
  readonly workingDirectory: string;
  /** Where the agent runs. */
  readonly workspace: string;
  readonly referenceDirectories: readonly string[];
  readonly git: TaskGit | undefined;
  readonly timeoutMinutes: number;
  readonly createdAt: string;
  readonly revisionOf: string | undefined;
  readonly revisionNumber: number;
  readonly revisionInstructions: string | undefined;
  /** The conversation this run resumes: a revision continuing the previous one, or a continuation (below). */
  resumeConversationId: string | undefined;
  readonly snapshotBefore: CheckoutSnapshot | undefined;

  status: TaskStatus;
  updatedAt: string;
  startedAt: string | undefined;
  finishedAt: string | undefined;
  ownerPid: number | undefined;
  process: TaskProcess | undefined;
  conversationId: string | undefined;
  cancelRequested: { at: string; reason: "cancelled" | "timed_out" } | undefined;
  progress: TaskProgress;
  outcome: TaskOutcome | undefined;
  report: AgentReport | undefined;
  verification: GitVerification | ReadOnlyVerification | undefined;
  warnings: string[];
  /**
   * Headless runs end their turn without an answer when a command needs an approval nobody can give. Relay Bridge
   * then resumes the conversation with `nextPrompt` (the command was denied, carry on without it), at most twice.
   */
  continuations?: number;
  nextPrompt?: string | undefined;
  /** Permission denials already answered by a continuation. */
  denialsSeen?: number;
}

export function emptyProgress(): TaskProgress {
  return {
    steps: 0,
    toolCalls: 0,
    lastActivityAt: undefined,
    lastTool: undefined,
    lastMessage: undefined,
    recentTools: [],
    permissionDenials: [],
    eventsOffset: 0,
  };
}
