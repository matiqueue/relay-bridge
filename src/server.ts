import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { toRelayError } from "./errors.js";
import type { ProviderRegistry } from "./providers/registry.js";
import { EFFORTS, MODEL_ALIASES } from "./providers/types.js";
import type { TaskManager } from "./tasks/manager.js";
import type { TaskStore } from "./tasks/store.js";
import { TASK_STATUSES } from "./tasks/types.js";
import { resultView, statusView, summaryView } from "./tasks/views.js";
import { VERSION } from "./version.js";

function ok(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function fail(error: unknown): CallToolResult {
  const relay = toRelayError(error);
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({ error: relay.code, message: relay.message, details: relay.details }, null, 2),
      },
    ],
  };
}

async function guarded(run: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return ok(await run());
  } catch (error) {
    return fail(error);
  }
}

const taskId = z.string().regex(/^rb-\d{8}-[a-z0-9]{6}$/, "a Relay Bridge task id, e.g. rb-20261123-k3j9x2");
const absolutePath = z.string().min(1).max(4096);

const SERVER_INSTRUCTIONS = `Relay Bridge lets you (the lead) delegate real repository work to Gemini through the Google Antigravity CLI.
Delegated tasks run asynchronously in their own git worktree and branch (or read-only), and end with a structured report plus facts Relay Bridge verified itself (branch, commits, files, push, pull request).
Workflow: list_available_models once per session → delegate_task (returns a task_id at once) → keep working → check_agent_status (wait_seconds to wait) → get_agent_result → review the diff and checks yourself → request_task_revision for changes → integrate yourself.
Models: "neon" is the default executor (best quality per quota); "argon" is for the hardest problems. No other model is ever used. Pick the effort per task.
You stay responsible for architecture, review and integration: delegated agents never merge, never push to integration branches and never force-push.`;

export function createServer(manager: TaskManager, store: TaskStore, providers: ProviderRegistry): McpServer {
  const server = new McpServer({ name: "relay-bridge", version: VERSION }, { instructions: SERVER_INSTRUCTIONS });

  server.registerTool(
    "list_available_models",
    {
      title: "List available models",
      description:
        "Lists the models Relay Bridge can delegate to, discovered live from the signed-in Antigravity account: the aliases neon (default executor) and argon (hardest tasks), the real model ids behind them, and the effort levels each one supports (confirmed with the CLI). Also reports whether an alias is unavailable on the account. Cached for a few minutes; refresh: true forces a new lookup.",
      inputSchema: {
        refresh: z.boolean().optional().describe("Bypass the cache and ask the CLI again."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ refresh }) =>
      guarded(async () => {
        const descriptions = await Promise.all(providers.all().map((p) => p.describe({ refresh: refresh ?? false })));
        return {
          providers: descriptions.map((d) => ({
            provider: d.provider,
            name: d.displayName,
            cli_version: d.cliVersion,
            checked_at: d.checkedAt,
            models: Object.values(d.aliases).map((a) => ({
              alias: a.alias,
              available: a.available,
              family: a.family,
              efforts: a.efforts,
              variants: a.variants.map((v) => ({ effort: v.effort, model_id: v.modelId, label: v.label })),
              note: a.note,
            })),
            other_models_on_account_not_used: d.otherModels.length,
          })),
          guidance: {
            neon: "Default. Features, components, endpoints, refactors, tests, typical bugs, docs, config analysis, migrations, repetitive changes. low/medium for simple or mechanical work, medium/high for typical work, high/xhigh for harder implementations.",
            argon:
              "Hard architecture questions, complex bugs, intricate algorithms, demanding analysis and code review that needs maximum reasoning. Usually high (its highest level).",
          },
        };
      }),
  );

  server.registerTool(
    "delegate_task",
    {
      title: "Delegate a task",
      description: `Starts a task for a delegated agent and returns its task_id immediately; the agent works asynchronously.
Write the task like a ticket for a capable engineer who has never seen the conversation: goal, context, scope (and what is out of scope), constraints, the files or areas involved, how to verify, and what done looks like. The agent reads the repository's own README/CONTRIBUTING/CLAUDE.md/AGENTS.md.
execution_mode:
- "modify": works in a new git worktree on its own branch (isolation "worktree", default) created from base_ref (default: the current branch), runs the project's checks and commits (commit: true by default). Set push: true to push the branch, open_pull_request: true to also open a draft PR. Your own checkout is not touched. Pass branch to follow the repository's branch naming convention; otherwise relay/<task-id>-<slug> is used.
- "read_only": analysis, review, research. The repository is mounted read-only in the agent's sandbox; the answers come back in the report's findings. Works in any directory, git or not.
reference_directories: other repositories or folders the agent may read (never write), e.g. a repository whose configuration it should study.
Choose model "neon" (default) or "argon" (hardest work) and an effort the model supports (list_available_models).`,
      inputSchema: {
        provider: z
          .enum(["antigravity"])
          .default("antigravity")
          .describe("The executor. Only Gemini via Antigravity today."),
        model: z.enum(MODEL_ALIASES).default("neon").describe("neon (default executor) or argon (hardest tasks)."),
        effort: z
          .enum(EFFORTS)
          .default("medium")
          .describe(
            "Reasoning effort; must be supported by the model (neon: up to xhigh, argon: up to high on current accounts).",
          ),
        task: z.string().min(20).max(100_000).describe("The full, self-contained task description."),
        title: z
          .string()
          .max(120)
          .optional()
          .describe("A short title for listings; derived from the task when omitted."),
        working_directory: absolutePath.describe(
          "Absolute path of the repository (or directory) the task is about. Always pass it explicitly; repositories live in many places.",
        ),
        execution_mode: z
          .enum(["modify", "read_only"])
          .describe("modify: change the repository in an isolated worktree; read_only: analyse without writing."),
        isolation: z
          .enum(["worktree", "in_place"])
          .optional()
          .describe(
            'modify only. "worktree" (default): a new worktree and branch. "in_place": work directly in working_directory, which must have a clean tree (use it for a worktree you created yourself).',
          ),
        branch: z
          .string()
          .max(200)
          .optional()
          .describe(
            "modify only. Name of the new task branch, following the repository's convention (e.g. flow/feature/012-short-description). Must not exist yet.",
          ),
        base_ref: z
          .string()
          .max(200)
          .optional()
          .describe(
            "modify only. Branch, tag or commit to start from; default: the current branch of working_directory.",
          ),
        reference_directories: z
          .array(absolutePath)
          .max(10)
          .optional()
          .describe("Absolute paths the agent may read but never modify."),
        commit: z
          .boolean()
          .optional()
          .describe(
            "modify only. Let the agent commit (default true). false: leave changes uncommitted in the worktree.",
          ),
        push: z
          .boolean()
          .optional()
          .describe("modify only. Let the agent push the task branch to origin (default false)."),
        open_pull_request: z
          .boolean()
          .optional()
          .describe(
            "modify only, needs push. Let the agent open a draft pull request (default false). It never merges.",
          ),
        pull_request_base: z
          .string()
          .max(200)
          .optional()
          .describe("Base branch for that pull request; default: base_ref."),
        timeout_minutes: z.number().int().min(1).max(1440).optional().describe("Hard time limit (default 60)."),
      },
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    (input) =>
      guarded(async () => {
        const record = await manager.delegate({
          provider: input.provider,
          model: input.model,
          effort: input.effort,
          task: input.task,
          title: input.title,
          workingDirectory: input.working_directory,
          mode: input.execution_mode,
          isolation: input.isolation,
          branch: input.branch,
          baseRef: input.base_ref,
          referenceDirectories: input.reference_directories ?? [],
          commit: input.commit,
          push: input.push,
          openPullRequest: input.open_pull_request,
          pullRequestBase: input.pull_request_base,
          timeoutMinutes: input.timeout_minutes,
        });
        return {
          ...statusView(record),
          message: `Task ${record.id} started. It runs in the background; check it with check_agent_status.`,
        };
      }),
  );

  server.registerTool(
    "list_agent_tasks",
    {
      title: "List delegated tasks",
      description:
        "Lists delegated tasks, newest first, optionally filtered by status. Includes tasks started by other Claude Code sessions on this machine.",
      inputSchema: {
        status: z.array(z.enum(TASK_STATUSES)).optional().describe('Only these statuses, e.g. ["running", "queued"].'),
        limit: z.number().int().min(1).max(200).optional().describe("Maximum number of tasks (default 20)."),
      },
      annotations: { readOnlyHint: true },
    },
    ({ status, limit }) =>
      guarded(async () => {
        const tasks = await manager.list(status, limit ?? 20);
        return { count: tasks.length, tasks: tasks.map(summaryView) };
      }),
  );

  server.registerTool(
    "check_agent_status",
    {
      title: "Check a task's status",
      description:
        "The status and live progress of a task: steps, tool calls, the last command or file it touched, the latest message, permission denials. With wait_seconds, waits until the task finishes or the time passes (use it instead of polling in a tight loop).",
      inputSchema: {
        task_id: taskId,
        wait_seconds: z
          .number()
          .int()
          .min(0)
          .max(300)
          .optional()
          .describe("Wait up to this long for the task to finish (default 0)."),
      },
      annotations: { readOnlyHint: true },
    },
    ({ task_id, wait_seconds }) =>
      guarded(async () =>
        statusView(wait_seconds ? await manager.waitFor(task_id, wait_seconds) : await manager.get(task_id)),
      ),
  );

  server.registerTool(
    "get_agent_result",
    {
      title: "Get a task's result",
      description:
        "The result of a finished task: the agent's structured report (summary, work done, files, branch, commits, push, pull request, tests and their outcomes, findings, known issues, what to check before integrating, blockers) and the facts Relay Bridge verified itself (branch, commits since base, changed and uncommitted files, push state, pull request, differences from the report). Always review the diff yourself before integrating.",
      inputSchema: {
        task_id: taskId,
        log_tail: z
          .number()
          .int()
          .min(0)
          .max(200)
          .optional()
          .describe("Also return the last N lines of the compacted event log (debugging)."),
      },
      annotations: { readOnlyHint: true },
    },
    ({ task_id, log_tail }) =>
      guarded(async () => {
        const record = await manager.get(task_id);
        const view = await resultView(record, store, { logTail: log_tail ?? 0 });
        return record.status === "running" || record.status === "queued"
          ? {
              ...view,
              note: "The task has not finished; this is a partial view. check_agent_status with wait_seconds waits for it.",
            }
          : view;
      }),
  );

  server.registerTool(
    "cancel_agent_task",
    {
      title: "Cancel a task",
      description:
        "Stops a queued or running task: the agent gets an interrupt, then is terminated with its child processes if it does not stop. Its worktree and branch are kept (nothing is deleted).",
      inputSchema: { task_id: taskId },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    ({ task_id }) => guarded(async () => statusView(await manager.cancel(task_id))),
  );

  server.registerTool(
    "request_task_revision",
    {
      title: "Request a revision",
      description:
        "Asks for changes to a finished task's work: a new task on the same branch and worktree that continues the agent's previous conversation when the CLI can resume it (otherwise a fresh conversation with the previous report and verified facts in its brief). Returns the new task_id. Be specific: what to change, why, and how to verify.",
      inputSchema: {
        task_id: taskId.describe("The finished task to revise (or a previous revision)."),
        instructions: z.string().min(10).max(50_000).describe("The requested changes."),
        model: z.enum(MODEL_ALIASES).optional().describe("Switch model for the revision (default: the same)."),
        effort: z.enum(EFFORTS).optional().describe("Switch effort (default: the same)."),
        continue_conversation: z.boolean().optional().describe("Resume the previous conversation (default true)."),
        push: z.boolean().optional().describe("Override push (default: as before)."),
        open_pull_request: z.boolean().optional().describe("Override open_pull_request (default: as before)."),
        timeout_minutes: z.number().int().min(1).max(1440).optional(),
      },
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    (input) =>
      guarded(async () => {
        const record = await manager.revise({
          taskId: input.task_id,
          instructions: input.instructions,
          model: input.model,
          effort: input.effort,
          continueConversation: input.continue_conversation ?? true,
          push: input.push,
          openPullRequest: input.open_pull_request,
          timeoutMinutes: input.timeout_minutes,
        });
        return { ...statusView(record), message: `Revision ${record.revisionNumber} started as ${record.id}.` };
      }),
  );

  server.registerTool(
    "cleanup_task_worktree",
    {
      title: "Remove a task's worktree",
      description:
        "Removes the worktree of a finished task after you integrated (or rejected) its work. Refuses when the worktree has uncommitted or untracked changes, and never deletes the branch.",
      inputSchema: { task_id: taskId },
      annotations: { destructiveHint: true },
    },
    ({ task_id }) =>
      guarded(async () => {
        const result = await manager.removeWorktree(task_id);
        return { removed_worktree: result.removed, branch_kept: result.branchKept };
      }),
  );

  return server;
}
