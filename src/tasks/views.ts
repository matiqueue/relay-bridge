import { readFile } from "node:fs/promises";
import type { TaskStore } from "./store.js";
import { isFinished, type TaskRecord } from "./types.js";

/**
 * What the tools return: compact, snake_case views of a task record. Status views are small enough to poll; the
 * result view carries the report and the verified facts, never the raw event log (unless asked for its tail).
 */
function elapsedSeconds(record: TaskRecord): number | undefined {
  if (!record.startedAt) return undefined;
  const end = record.finishedAt ? Date.parse(record.finishedAt) : Date.now();
  return Math.max(0, Math.round((end - Date.parse(record.startedAt)) / 1000));
}

export function summaryView(record: TaskRecord) {
  return {
    task_id: record.id,
    status: record.status,
    title: record.title,
    model: record.model.alias,
    effort: record.effort,
    execution_mode: record.mode,
    working_directory: record.workingDirectory,
    branch: record.git?.branch,
    revision_of: record.revisionOf,
    created_at: record.createdAt,
    finished_at: record.finishedAt,
  };
}

export function statusView(record: TaskRecord) {
  const p = record.progress;
  return {
    task_id: record.id,
    status: record.status,
    finished: isFinished(record.status),
    title: record.title,
    provider: record.provider,
    model: { alias: record.model.alias, id: record.model.id, label: record.model.label },
    effort: record.effort,
    execution_mode: record.mode,
    isolation: record.isolation,
    working_directory: record.workingDirectory,
    workspace: record.workspace,
    branch: record.git?.branch,
    revision_of: record.revisionOf,
    revision_number: record.revisionNumber,
    created_at: record.createdAt,
    started_at: record.startedAt,
    finished_at: record.finishedAt,
    elapsed_seconds: elapsedSeconds(record),
    timeout_minutes: record.timeoutMinutes,
    progress: {
      steps: p.steps,
      tool_calls: p.toolCalls,
      last_activity_at: p.lastActivityAt,
      last_tool: p.lastTool
        ? `${p.lastTool.name}${p.lastTool.summary && p.lastTool.summary !== p.lastTool.name ? `: ${p.lastTool.summary}` : ""}`
        : undefined,
      recent_tools: p.recentTools.map(
        (t) =>
          `${t.name}${t.summary && t.summary !== t.name ? `: ${t.summary}` : ""}${t.error ? ` (error: ${t.error})` : ""}`,
      ),
      last_message: p.lastMessage,
      permission_denials: p.permissionDenials,
    },
    cancel_requested: record.cancelRequested,
    error: record.outcome?.error,
    next: nextStep(record),
  };
}

function nextStep(record: TaskRecord): string {
  switch (record.status) {
    case "queued":
      return "Waiting for a free slot (RELAY_BRIDGE_MAX_CONCURRENCY). check_agent_status with wait_seconds to wait.";
    case "running":
      return "Still working. Do other work and check back, or call check_agent_status with wait_seconds (up to 300) to wait.";
    case "completed":
      return "Finished. Read get_agent_result, then review the diff and the checks yourself before integrating.";
    case "awaiting_input":
      return "The agent stopped waiting for input. Read get_agent_result and answer with request_task_revision.";
    case "failed":
    case "timed_out":
    case "cancelled":
      return "Ended without completing. get_agent_result shows what was done; request_task_revision can continue it.";
  }
}

/** Commits are newest first; those before the run's start commit are this run's. */
function commitsSince(commits: readonly { sha: string }[], startSha: string): number {
  const index = commits.findIndex((c) => c.sha === startSha);
  return index === -1 ? commits.length : index;
}

export interface ResultOptions {
  readonly logTail: number;
}

export async function resultView(record: TaskRecord, store: TaskStore, options: ResultOptions) {
  const v = record.verification;
  const git = record.git;
  const view = {
    task_id: record.id,
    status: record.status,
    title: record.title,
    model: { alias: record.model.alias, label: record.model.label },
    effort: record.effort,
    execution_mode: record.mode,
    working_directory: record.workingDirectory,
    workspace: record.workspace,
    elapsed_seconds: elapsedSeconds(record),
    conversation_id: record.conversationId,
    revision_of: record.revisionOf,
    report: record.report,
    verified: v
      ? v.kind === "git"
        ? {
            branch: v.branch,
            expected_branch: git?.branch,
            head_sha: v.headSha,
            base_ref: git?.baseRef,
            base_sha: v.baseSha,
            commits: v.commits,
            new_commits_in_this_run: git ? commitsSince(v.commits, git.startSha) : undefined,
            files_changed: v.committedFiles,
            uncommitted_changes: v.uncommitted,
            pushed: v.pushed,
            upstream: v.upstream,
            ahead_of_upstream: v.aheadOfUpstream,
            pull_request: v.pullRequest,
            original_checkout_changes: v.originalCheckoutChanges,
            report_mismatches: v.mismatches,
            review_hint: git
              ? `git -C ${record.workspace} diff ${v.baseSha.slice(0, 12)}...HEAD   # review before integrating`
              : undefined,
          }
        : {
            repository_checked: v.checked,
            changed_paths_during_task: v.changedPaths,
            head_moved: v.headMoved,
            note: v.note,
          }
      : undefined,
    outcome: record.outcome
      ? {
          cli_status: record.outcome.cliStatus,
          finished_reason: record.outcome.finishedReason,
          exit_code: record.outcome.exitCode,
          error: record.outcome.error,
          usage: record.outcome.usage,
          // The free-text answer only when there is no structured report
          response: record.report ? undefined : record.outcome.response,
        }
      : undefined,
    permission_denials: record.progress.permissionDenials,
    warnings: record.warnings,
    log_tail: options.logTail > 0 ? await logTail(store, record.id, options.logTail) : undefined,
  };
  return view;
}

async function logTail(store: TaskStore, id: string, lines: number): Promise<string[]> {
  const text = await readFile(store.paths(id).events, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .slice(-lines);
}
