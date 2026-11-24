import { existsSync } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { RelayConfig } from "../config.js";
import { RelayError } from "../errors.js";
import {
  addWorktree,
  addWorktreeForBranch,
  branchExists,
  globalGitConfigPaths,
  removeWorktree,
  repoInfo,
  resolveCommit,
  status as gitStatus,
  switchToNewBranch,
} from "../git/git.js";
import { compactEventLine } from "../providers/antigravity/events.js";
import { buildPolicy } from "../providers/antigravity/policy.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { AgentProvider, Effort, ExecutionMode, ModelAlias, ProviderEvent } from "../providers/types.js";
import { buildBrief, type BriefInput } from "../prompt/brief.js";
import { parseReport, REPORT_JSON_SCHEMA } from "../prompt/report.js";
import { slugify, validateBranchName, validateDirectory } from "../security/paths.js";
import { redact, redactDeep, truncate } from "../security/redact.js";
import { isProcessAlive, processCommandLine, signalProcessGroup } from "../util/process.js";
import { newTaskId, type TaskStore } from "./store.js";
import {
  emptyProgress,
  isFinished,
  type TaskGit,
  type TaskOutcome,
  type TaskRecord,
  type TaskStatus,
} from "./types.js";
import { snapshot, verifyGit, verifyReadOnly } from "./verify.js";

export interface DelegateRequest {
  readonly provider: string;
  readonly model: ModelAlias;
  readonly effort: Effort;
  readonly task: string;
  readonly title: string | undefined;
  readonly workingDirectory: string;
  readonly mode: ExecutionMode;
  readonly isolation: "worktree" | "in_place" | undefined;
  readonly branch: string | undefined;
  readonly baseRef: string | undefined;
  readonly referenceDirectories: readonly string[];
  readonly commit: boolean | undefined;
  readonly push: boolean | undefined;
  readonly openPullRequest: boolean | undefined;
  readonly pullRequestBase: string | undefined;
  readonly timeoutMinutes: number | undefined;
}

export interface RevisionRequest {
  readonly taskId: string;
  readonly instructions: string;
  readonly model: ModelAlias | undefined;
  readonly effort: Effort | undefined;
  readonly continueConversation: boolean;
  readonly push: boolean | undefined;
  readonly openPullRequest: boolean | undefined;
  readonly timeoutMinutes: number | undefined;
}

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

interface Supervised {
  readonly id: string;
  readonly pid: number;
  readonly provider: AgentProvider;
  exit: { exitCode: number | null; signal: NodeJS.Signals | null } | undefined;
  result: Extract<ProviderEvent, { kind: "result" }> | undefined;
  textStep: number;
  text: string;
  watchdog: NodeJS.Timeout | undefined;
  finalizing: boolean;
}

const MAX_TASK_LENGTH = 100_000;
const RESUME_FAILURE = /conversation|-32002|not found|unknown id/i;
/** What the CLI prints when headless mode had to deny an approval and ended the turn (agy 1.5.15). */
const AUTO_DENIED = /auto-denied|cannot prompt|no output produced/i;
const MAX_CONTINUATIONS = 2;

/**
 * Why a run that "succeeded" has no report: its turn ended at a command headless mode had to deny ("denied"), or the
 * agent stopped short of the final answer, e.g. after waiting for a background task ("unfinished").
 */
export function missingReport(
  record: Pick<TaskRecord, "progress" | "denialsSeen">,
  result: Extract<ProviderEvent, { kind: "result" }> | undefined,
  hasReport: boolean,
  stderr: string,
): "denied" | "unfinished" | undefined {
  if (!result || result.status !== "SUCCESS" || hasReport) return undefined;
  const newDenials = record.progress.permissionDenials.length > (record.denialsSeen ?? 0);
  return AUTO_DENIED.test(stderr) || newDenials ? "denied" : "unfinished";
}

function nowIso(): string {
  return new Date().toISOString();
}

function titleOf(task: string, title: string | undefined): string {
  const source =
    title?.trim() ||
    task
      .trim()
      .split("\n")
      .find((line) => line.trim() !== "") ||
    "Delegated task";
  return truncate(source.replace(/^#+\s*/, "").replace(/\s+/g, " "), 100);
}

/**
 * The lifecycle of delegated tasks: validation and isolation when a task is created, a queue bounded by the
 * concurrency limit, supervision of the detached agent process (its event log, a watchdog, cancellation), and the
 * final record — outcome, the agent's report and the facts Relay Bridge verified.
 *
 * Several Relay Bridge processes can share one task directory (one per Claude Code session). Each task is supervised
 * by exactly one of them (store.tryAcquire); the others read its record. When a supervising process ends, the next
 * supervisor tick of any instance adopts its tasks — the agent processes keep running in between, writing to files.
 */
export class TaskManager {
  private readonly supervised = new Map<string, Supervised>();
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;
  private lastScan = 0;

  constructor(
    private readonly config: RelayConfig,
    private readonly store: TaskStore,
    private readonly providers: ProviderRegistry,
    private readonly log: Logger,
  ) {}

  async start(): Promise<void> {
    await mkdir(this.config.worktreesDir, { recursive: true, mode: 0o700 });
    await this.scan();
    this.timer = setInterval(() => void this.tick(), this.config.pollIntervalMs);
    this.timer.unref();
  }

  /** Stops supervising. Running agents keep running; the next Relay Bridge instance adopts them. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const entry of this.supervised.values()) {
      if (entry.watchdog) clearTimeout(entry.watchdog);
      await this.store.release(entry.id).catch(() => undefined);
    }
    this.supervised.clear();
  }

  // ── Creating tasks ──────────────────────────────────────────────────────────────────────────────

  async delegate(request: DelegateRequest): Promise<TaskRecord> {
    const provider = this.providers.get(request.provider);
    if (request.task.trim().length < 20) {
      throw new RelayError(
        "INVALID_INPUT",
        "The task is too short. Describe the goal, the scope and what done looks like.",
      );
    }
    if (request.task.length > MAX_TASK_LENGTH) {
      throw new RelayError(
        "INVALID_INPUT",
        `The task is longer than ${MAX_TASK_LENGTH} characters. Reference files instead of pasting them.`,
      );
    }
    const timeoutMinutes = this.timeout(request.timeoutMinutes);
    const workingDirectory = validateDirectory(request.workingDirectory, "working_directory", this.config);
    const referenceDirectories = request.referenceDirectories.map((dir) =>
      validateDirectory(dir, "reference_directory", this.config),
    );
    const model = await provider.resolveModel(request.model, request.effort);
    const repo = await repoInfo(workingDirectory);

    const id = newTaskId();
    const paths = this.store.paths(id);
    let workspace: string;
    let git: TaskGit | undefined;
    let isolation: TaskRecord["isolation"];
    let createdWorktree: string | undefined;

    if (request.mode === "read_only") {
      if (request.push || request.openPullRequest || request.branch) {
        throw new RelayError(
          "INVALID_INPUT",
          'branch, push and open_pull_request apply to execution_mode "modify" only.',
        );
      }
      isolation = "read_only";
      workspace = paths.scratch;
    } else {
      if (!repo) {
        throw new RelayError(
          "NOT_A_GIT_REPOSITORY",
          `${workingDirectory} is not inside a git repository. Modifying tasks need git (isolation, verification); use execution_mode "read_only" for other directories.`,
        );
      }
      const allowCommit = request.commit ?? true;
      const allowPush = allowCommit && (request.push ?? false);
      const allowPullRequest = allowPush && (request.openPullRequest ?? false);
      if (request.openPullRequest && !allowPush) {
        throw new RelayError("INVALID_INPUT", "open_pull_request needs push: true (and commit: true).");
      }
      isolation = request.isolation ?? "worktree";
      const baseRef = request.baseRef ?? repo.branch ?? "HEAD";
      const baseSha = await resolveCommit(repo.root, baseRef);

      if (isolation === "worktree") {
        const branch = validateBranchName(
          request.branch ?? `relay/${id}-${slugify(titleOf(request.task, request.title), 32)}`,
        );
        if (await branchExists(repo.root, branch)) {
          throw new RelayError(
            "BRANCH_EXISTS",
            `Branch "${branch}" already exists in ${repo.root}. Pick another name, or continue the earlier task with request_task_revision.`,
          );
        }
        workspace = path.join(this.config.worktreesDir, `${slugify(path.basename(repo.root), 40)}-${id}`);
        await addWorktree(repo.root, workspace, branch, baseSha);
        createdWorktree = workspace;
        git = {
          repoRoot: repo.root,
          commonDir: repo.commonDir,
          baseRef,
          baseSha,
          startSha: baseSha,
          branch,
          createdBranch: true,
          worktreePath: workspace,
          allowCommit,
          allowPush,
          allowPullRequest,
          pullRequestBase:
            request.pullRequestBase ?? (repo.branch && baseRef === repo.branch ? repo.branch : undefined),
        };
      } else {
        const dirty = await gitStatus(repo.root);
        if (dirty.length > 0) {
          throw new RelayError(
            "DIRTY_WORKING_TREE",
            `isolation "in_place" needs a clean working tree, and ${repo.root} has ${dirty.length} changed or untracked path(s). Commit or stash them, or use isolation "worktree".`,
            { paths: dirty.slice(0, 20).map((entry) => entry.path) },
          );
        }
        let branch: string;
        let createdBranch = false;
        if (request.branch) {
          branch = validateBranchName(request.branch);
          if (await branchExists(repo.root, branch)) {
            throw new RelayError("BRANCH_EXISTS", `Branch "${branch}" already exists in ${repo.root}.`);
          }
          await switchToNewBranch(repo.root, branch);
          createdBranch = true;
        } else {
          if (!repo.branch) throw new RelayError("INVALID_INPUT", `${repo.root} has a detached HEAD: pass a branch.`);
          branch = validateBranchName(repo.branch);
        }
        workspace = repo.root;
        git = {
          repoRoot: repo.root,
          commonDir: repo.commonDir,
          baseRef,
          baseSha,
          startSha: baseSha,
          branch,
          createdBranch,
          worktreePath: undefined,
          allowCommit,
          allowPush,
          allowPullRequest,
          pullRequestBase: request.pullRequestBase,
        };
      }
    }

    const record: TaskRecord = {
      schemaVersion: 1,
      id,
      provider: provider.id,
      model: { alias: model.alias, id: model.modelId, label: model.label },
      effort: model.effort,
      title: titleOf(request.task, request.title),
      task: request.task,
      mode: request.mode,
      isolation,
      workingDirectory: repo?.root ?? workingDirectory,
      workspace,
      referenceDirectories,
      git,
      timeoutMinutes,
      createdAt: nowIso(),
      revisionOf: undefined,
      revisionNumber: 0,
      revisionInstructions: undefined,
      resumeConversationId: undefined,
      snapshotBefore:
        repo && (request.mode === "read_only" || isolation === "worktree") ? await snapshot(repo.root) : undefined,
      status: "queued",
      updatedAt: nowIso(),
      startedAt: undefined,
      finishedAt: undefined,
      ownerPid: process.pid,
      process: undefined,
      conversationId: undefined,
      cancelRequested: undefined,
      progress: emptyProgress(),
      outcome: undefined,
      report: undefined,
      verification: undefined,
      warnings: [],
      continuations: 0,
      nextPrompt: undefined,
    };

    try {
      await this.store.create(record);
      await this.writeRunFiles(record, this.briefFor(record, undefined));
      await this.store.tryAcquire(id);
    } catch (error) {
      if (createdWorktree && git) await removeWorktree(git.repoRoot, createdWorktree).catch(() => undefined);
      throw error;
    }
    this.log.info(`task ${id} queued (${model.label}, ${request.mode}, ${workspace})`);
    await this.schedule();
    return this.store.get(id);
  }

  async revise(request: RevisionRequest): Promise<TaskRecord> {
    const parent = await this.store.get(request.taskId);
    if (!isFinished(parent.status)) {
      throw new RelayError(
        "TASK_NOT_FINISHED",
        `Task ${parent.id} is still ${parent.status}. Wait for it, or cancel it first.`,
      );
    }
    if (request.instructions.trim().length < 10)
      throw new RelayError("INVALID_INPUT", "Describe the requested changes.");
    const provider = this.providers.get(parent.provider);
    const model = await provider.resolveModel(request.model ?? parent.model.alias, request.effort ?? parent.effort);
    const id = newTaskId();
    const paths = this.store.paths(id);

    let workspace = parent.workspace;
    let git = parent.git;
    if (parent.mode === "read_only") {
      workspace = paths.scratch;
    } else if (git) {
      const info = existsSync(workspace) ? await repoInfo(workspace) : undefined;
      if (git.worktreePath) {
        if (!info) {
          workspace = path.join(this.config.worktreesDir, `${slugify(path.basename(git.repoRoot), 40)}-${id}`);
          await addWorktreeForBranch(git.repoRoot, workspace, git.branch);
        } else if (info.branch !== git.branch) {
          throw new RelayError(
            "INVALID_INPUT",
            `The worktree ${workspace} is on "${info.branch ?? "a detached HEAD"}", not on the task branch "${git.branch}".`,
          );
        }
      } else if (info?.branch !== git.branch) {
        throw new RelayError(
          "INVALID_INPUT",
          `${workspace} is no longer on the task branch "${git.branch}". Check it out before asking for a revision.`,
        );
      }
      const busy = (await this.store.list()).find((t) => t.workspace === workspace && !isFinished(t.status));
      if (busy) throw new RelayError("TASK_NOT_FINISHED", `Task ${busy.id} is already working in ${workspace}.`);
      const head = (await repoInfo(workspace))?.head ?? git.baseSha;
      const allowPush = git.allowCommit && (request.push ?? git.allowPush);
      git = {
        ...git,
        startSha: head,
        createdBranch: false,
        worktreePath: git.worktreePath ? workspace : undefined,
        allowPush,
        allowPullRequest: allowPush && (request.openPullRequest ?? git.allowPullRequest),
      };
    }

    const resumeConversationId = request.continueConversation ? parent.conversationId : undefined;
    const record: TaskRecord = {
      ...parent,
      id,
      model: { alias: model.alias, id: model.modelId, label: model.label },
      effort: model.effort,
      workspace,
      git,
      timeoutMinutes: this.timeout(request.timeoutMinutes ?? parent.timeoutMinutes),
      createdAt: nowIso(),
      revisionOf: parent.id,
      revisionNumber: parent.revisionNumber + 1,
      revisionInstructions: request.instructions,
      resumeConversationId,
      snapshotBefore:
        parent.mode === "read_only" || git?.worktreePath
          ? await snapshot(git?.repoRoot ?? parent.workingDirectory)
          : undefined,
      status: "queued",
      updatedAt: nowIso(),
      startedAt: undefined,
      finishedAt: undefined,
      ownerPid: process.pid,
      process: undefined,
      conversationId: undefined,
      cancelRequested: undefined,
      progress: emptyProgress(),
      outcome: undefined,
      report: undefined,
      verification: undefined,
      warnings: [],
      continuations: 0,
      nextPrompt: undefined,
    };
    await this.store.create(record);
    await this.writeRunFiles(record, this.briefFor(record, parent));
    await this.store.tryAcquire(id);
    this.log.info(`task ${id} queued as revision ${record.revisionNumber} of ${parent.id}`);
    await this.schedule();
    return this.store.get(id);
  }

  private timeout(requested: number | undefined): number {
    const value = requested ?? this.config.defaultTimeoutMinutes;
    if (!Number.isInteger(value) || value < 1 || value > this.config.maxTimeoutMinutes) {
      throw new RelayError(
        "INVALID_INPUT",
        `timeout_minutes must be an integer from 1 to ${this.config.maxTimeoutMinutes}.`,
      );
    }
    return value;
  }

  private briefFor(record: TaskRecord, parent: TaskRecord | undefined, forceFresh = false): string {
    const git = record.git;
    const input: BriefInput = {
      task: record.task,
      mode: record.mode,
      workspace: record.workspace,
      repository: git?.repoRoot ?? record.workingDirectory,
      referenceDirectories: record.referenceDirectories,
      git: git
        ? {
            branch: git.branch,
            baseRef: git.baseRef,
            baseSha: git.baseSha,
            worktree: git.worktreePath !== undefined,
            allowCommit: git.allowCommit,
            allowPush: git.allowPush,
            allowPullRequest: git.allowPullRequest,
            pullRequestBase: git.pullRequestBase,
          }
        : undefined,
      revision:
        parent && record.revisionInstructions
          ? {
              number: record.revisionNumber,
              instructions: record.revisionInstructions,
              previousSummary:
                parent.report?.summary || parent.outcome?.error || `The previous run ended as ${parent.status}.`,
              previousReport: truncate(JSON.stringify(parent.report ?? {}, null, 2), 20_000),
              verifiedFacts: describeVerification(parent),
              sameConversation: record.resumeConversationId !== undefined && !forceFresh,
            }
          : undefined,
    };
    return buildBrief(input);
  }

  private async writeRunFiles(record: TaskRecord, brief: string): Promise<void> {
    const paths = this.store.paths(record.id);
    await writeFile(paths.brief, `${brief}\n`, { mode: 0o600 });
    await writeFile(paths.schema, `${JSON.stringify(REPORT_JSON_SCHEMA, null, 2)}\n`, { mode: 0o600 });
    if (record.mode === "read_only") await mkdir(paths.scratch, { recursive: true, mode: 0o700 });
  }

  // ── Scheduling and running ──────────────────────────────────────────────────────────────────────

  private async schedule(): Promise<void> {
    const tasks = await this.store.list();
    let running = tasks.filter((t) => t.status === "running").length;
    const queued = tasks.filter((t) => t.status === "queued").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const task of queued) {
      if (running >= this.config.maxConcurrentTasks) break;
      if ((await this.store.lockHolder(task.id)) !== process.pid) continue;
      if (this.supervised.has(task.id)) continue;
      running++;
      await this.run(task.id);
    }
  }

  private async run(id: string): Promise<void> {
    const record = await this.store.get(id);
    const provider = this.providers.get(record.provider);
    const paths = this.store.paths(id);
    const policy = buildPolicy({
      mode: record.mode,
      repository: record.git?.repoRoot ?? record.workingDirectory,
      gitCommonDir: record.git?.commonDir,
      referenceDirectories: record.referenceDirectories,
      gitConfigPaths: globalGitConfigPaths(homedir()).filter((p) => existsSync(p)),
      allowCommit: record.git?.allowCommit ?? false,
      allowPush: record.git?.allowPush ?? false,
      allowPullRequest: record.git?.allowPullRequest ?? false,
      extraAllowRules: record.mode === "modify" ? this.config.extraAllowRules : [],
    });
    try {
      const handle = await provider.start({
        taskId: id,
        workspace: record.workspace,
        brief: record.nextPrompt ?? (await readFile(paths.brief, "utf8")).trimEnd(),
        reportSchemaPath: paths.schema,
        model: {
          alias: record.model.alias,
          modelId: record.model.id,
          label: record.model.label,
          effort: record.effort,
        },
        mode: record.mode,
        policy,
        timeoutMinutes: record.timeoutMinutes,
        resumeConversationId: record.resumeConversationId,
        eventsPath: paths.events,
        stderrPath: paths.stderr,
      });
      const startedAt = nowIso();
      await this.store.update(id, (r) => {
        r.status = "running";
        r.startedAt = startedAt;
        r.ownerPid = process.pid;
        r.process = { pid: handle.pid, startedAt, displayCommand: handle.displayCommand };
      });
      const entry = this.supervise(id, handle.pid, provider, startedAt, record.timeoutMinutes);
      void handle.exited.then((exit) => {
        entry.exit = exit;
        void this.tick();
      });
      this.log.info(`task ${id} running (pid ${handle.pid})`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.store.update(id, (r) => {
        r.status = "failed";
        r.finishedAt = nowIso();
        r.outcome = emptyOutcome({ error: message });
      });
      await this.store.release(id);
      this.log.error(`task ${id} could not start: ${message}`);
    }
  }

  private supervise(
    id: string,
    pid: number,
    provider: AgentProvider,
    startedAt: string,
    timeoutMinutes: number,
  ): Supervised {
    const entry: Supervised = {
      id,
      pid,
      provider,
      exit: undefined,
      result: undefined,
      textStep: -1,
      text: "",
      watchdog: undefined,
      finalizing: false,
    };
    // The CLI enforces the timeout itself (--print-timeout); this is the backstop when it does not stop
    const deadline = Date.parse(startedAt) + timeoutMinutes * 60_000 + 120_000;
    entry.watchdog = setTimeout(() => void this.stopProcess(id, "timed_out"), Math.max(1000, deadline - Date.now()));
    entry.watchdog.unref();
    this.supervised.set(id, entry);
    return entry;
  }

  /** One supervisor round: read new events of supervised tasks, finish exited ones, adopt orphans, start queued. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const entry of [...this.supervised.values()]) {
        if (entry.finalizing) continue;
        await this.readEvents(entry);
        if (entry.exit !== undefined || !isProcessAlive(entry.pid)) await this.finalize(entry);
      }
      if (Date.now() - this.lastScan > Math.max(3000, this.config.pollIntervalMs * 3)) await this.scan();
    } catch (error) {
      this.log.error(`supervisor: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.ticking = false;
    }
  }

  /** Adopts tasks whose supervisor is gone, finishes those whose agent already exited, and starts queued tasks. */
  private async scan(): Promise<void> {
    this.lastScan = Date.now();
    for (const task of await this.store.list()) {
      if (isFinished(task.status) || this.supervised.has(task.id)) continue;
      if (!(await this.store.tryAcquire(task.id))) continue;
      if (task.status === "queued") continue;
      const pid = task.process?.pid;
      const provider = this.providers.get(task.provider);
      const alive = pid !== undefined && (await this.isOwnAgent(task, pid));
      if (pid === undefined) {
        await this.store.update(task.id, (r) => {
          r.status = "failed";
          r.finishedAt = nowIso();
          r.outcome = emptyOutcome({ error: "The task was marked running but no agent process was recorded." });
        });
        await this.store.release(task.id);
        continue;
      }
      this.log.info(`task ${task.id}: adopted (agent ${alive ? "still running" : "already exited"})`);
      await this.store.update(task.id, (r) => {
        r.ownerPid = process.pid;
      });
      const entry = this.supervise(task.id, pid, provider, task.startedAt ?? task.createdAt, task.timeoutMinutes);
      if (!alive) entry.exit = { exitCode: null, signal: null };
    }
    await this.schedule();
  }

  private async isOwnAgent(task: TaskRecord, pid: number): Promise<boolean> {
    const commandLine = await processCommandLine(pid);
    return commandLine !== undefined && commandLine.includes(this.store.paths(task.id).schema);
  }

  private async readEvents(entry: Supervised): Promise<void> {
    const paths = this.store.paths(entry.id);
    const record = await this.store.get(entry.id);
    const size = await stat(paths.events)
      .then((s) => s.size)
      .catch(() => 0);
    let offset = record.progress.eventsOffset;
    if (size <= offset) return;
    const handle = await open(paths.events, "r");
    try {
      const length = Math.min(size - offset, 4 * 1024 * 1024);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, offset);
      const text = buffer.toString("utf8");
      const lastNewline = text.lastIndexOf("\n");
      if (lastNewline < 0) return;
      const lines = text.slice(0, lastNewline).split("\n");
      offset += Buffer.byteLength(text.slice(0, lastNewline + 1));
      const events = lines
        .map((line) => entry.provider.parseEventLine(line))
        .filter((e): e is ProviderEvent => e !== undefined);
      await this.store.update(entry.id, (r) => {
        r.progress.eventsOffset = offset;
        for (const event of events) this.apply(r, entry, event);
      });
    } finally {
      await handle.close();
    }
  }

  private apply(record: TaskRecord, entry: Supervised, event: ProviderEvent): void {
    const progress = record.progress;
    const at = nowIso();
    switch (event.kind) {
      case "init":
        if (event.conversationId) record.conversationId = event.conversationId;
        break;
      case "step":
        progress.steps = Math.max(progress.steps, event.index + 1);
        progress.lastActivityAt = at;
        if (event.stepType === "tool" && event.done && event.toolName) {
          progress.toolCalls++;
          progress.lastTool = { name: event.toolName, summary: event.toolSummary, at };
          progress.recentTools = [
            ...progress.recentTools,
            { name: event.toolName, summary: event.toolSummary, error: event.toolError },
          ].slice(-8);
        }
        if (event.permissionDenied && !progress.permissionDenials.includes(event.permissionDenied)) {
          progress.permissionDenials = [...progress.permissionDenials, event.permissionDenied].slice(-20);
        }
        if (event.textDelta) {
          if (event.index !== entry.textStep) {
            entry.textStep = event.index;
            entry.text = "";
          }
          entry.text = (entry.text + event.textDelta).slice(-600);
          progress.lastMessage = truncate(redact(entry.text.trim()), 400);
        }
        break;
      case "result":
        entry.result = event;
        if (event.conversationId) record.conversationId = event.conversationId;
        break;
    }
  }

  private async finalize(entry: Supervised): Promise<void> {
    entry.finalizing = true;
    if (entry.watchdog) clearTimeout(entry.watchdog);
    const paths = this.store.paths(entry.id);
    let restart: TaskRecord | undefined;
    let continueRun: { record: TaskRecord; reason: "denied" | "unfinished" } | undefined;
    try {
      await this.readEvents(entry);
      const result = entry.result ?? (await this.lastResult(paths.events, entry.provider));
      const stderr = redact(await readTail(paths.stderr, 8000));
      const before = await this.store.get(entry.id);

      // A revision that could not resume its conversation starts over with the previous context in the brief
      if (
        before.resumeConversationId &&
        before.progress.toolCalls === 0 &&
        result?.status !== "SUCCESS" &&
        RESUME_FAILURE.test(`${result?.error ?? ""} ${stderr}`) &&
        !before.cancelRequested
      ) {
        restart = before;
        return;
      }

      const parsed = result ? parseReport(result.structuredOutput, result.response) : undefined;
      const gap = missingReport(before, result, parsed !== undefined, stderr);
      if (gap && before.conversationId && (before.continuations ?? 0) < MAX_CONTINUATIONS && !before.cancelRequested) {
        continueRun = { record: before, reason: gap };
        return;
      }

      let status = decideStatus(before, result, entry.exit, stderr);
      const deniedError =
        gap === "denied"
          ? `The agent's turn kept ending at commands the task's policy does not allow (${before.progress.permissionDenials.slice(-3).join("; ") || "a command that needed approval"}), and it never reported. Allow the command (RELAY_BRIDGE_EXTRA_ALLOW) or change the task.`
          : undefined;
      if (deniedError) status = "failed";
      const outcome: TaskOutcome = {
        cliStatus: result?.status,
        finishedReason: result?.finishedReason,
        exitCode: entry.exit?.exitCode,
        signal: entry.exit?.signal,
        error:
          status === "completed"
            ? undefined
            : truncate(
                redact(
                  deniedError ||
                    result?.error ||
                    lastLines(stderr, 6) ||
                    `The agent exited with code ${String(entry.exit?.exitCode ?? "unknown")}.`,
                ),
                2000,
              ),
        response: result?.response ? truncate(redact(result.response), 20_000) : undefined,
        usage: result?.usage,
        durationSeconds: result?.durationSeconds,
      };
      const report = parsed ? redactDeep(parsed) : undefined;
      // Verify and compact before the status changes, so whoever sees the task finished sees all of it
      const provisional: TaskRecord = { ...before, status, outcome, report };
      const verification =
        provisional.mode === "read_only" ? await verifyReadOnly(provisional) : await verifyGit(provisional);
      await compactLogs(paths.events, paths.stderr);
      await this.store.update(entry.id, (r) => {
        r.status = status;
        r.finishedAt = nowIso();
        r.outcome = outcome;
        r.report = report;
        r.verification = verification;
        if (result?.conversationId) r.conversationId = result.conversationId;
        if (status === "completed" && !report) {
          r.warnings.push("The agent finished without a structured report; its response text is in the outcome.");
        }
      });
      this.log.info(`task ${entry.id} ${status}`);
    } catch (error) {
      this.log.error(`task ${entry.id}: finalizing failed: ${error instanceof Error ? error.message : String(error)}`);
      await this.store
        .update(entry.id, (r) => {
          if (!isFinished(r.status)) {
            r.status = "failed";
            r.finishedAt = nowIso();
            r.outcome = emptyOutcome({ error: `Relay Bridge could not read the run's result: ${String(error)}` });
          }
        })
        .catch(() => undefined);
    } finally {
      this.supervised.delete(entry.id);
      if (!restart && !continueRun) await this.store.release(entry.id).catch(() => undefined);
      if (restart)
        await this.restartWithoutResume(entry, restart).catch((error: unknown) => this.log.error(String(error)));
      if (continueRun)
        await this.continueRun(continueRun.record, continueRun.reason).catch((error: unknown) =>
          this.log.error(String(error)),
        );
      await this.schedule();
    }
  }

  /** Resumes the run's own conversation with a short prompt, instead of finishing a task that has no report. */
  private async continueRun(record: TaskRecord, reason: "denied" | "unfinished"): Promise<void> {
    const paths = this.store.paths(record.id);
    const number = (record.continuations ?? 0) + 1;
    // The next run's stderr starts empty, so an old "auto-denied" line is not taken for a new one
    await rename(paths.stderr, `${paths.stderr.replace(/\.log$/, "")}.${number}.log`).catch(() => undefined);
    const denials = record.progress.permissionDenials.slice(-3);
    const prompt =
      reason === "denied"
        ? [
            "Relay Bridge: your last turn ended because a command needed an approval that cannot be given in this run, so it was denied" +
              (denials.length > 0 ? `: ${denials.join("; ")}.` : "."),
            "Do not run it again in that form and do not look for a workaround of the policy. Commands that leave the sandbox must be plain commands without $(...), backticks or heredocs: write long text (such as a pull request description) to a temporary file and pass the file (gh pr create --body-file <file>).",
            "Continue the task and finish with the JSON report the output schema requires. Mention a command you could not run under known_issues, or as the blocker if the task cannot be done without it.",
          ].join(" ")
        : "Relay Bridge: your last turn ended without the final JSON report. If any work is left, finish it now (including any background command you were waiting for); then answer with the JSON report the output schema requires.";
    await this.store.update(record.id, (r) => {
      r.status = "queued";
      r.process = undefined;
      r.resumeConversationId = r.conversationId;
      r.nextPrompt = prompt;
      r.continuations = number;
      r.denialsSeen = r.progress.permissionDenials.length;
      r.warnings.push(
        reason === "denied"
          ? `The agent's turn ended at a command that needed approval${denials.length > 0 ? ` (${denials.join("; ")})` : ""}; Relay Bridge resumed the conversation and told it to continue without it (continuation ${number} of ${MAX_CONTINUATIONS}).`
          : `The agent's turn ended without its report; Relay Bridge resumed the conversation and asked it to finish and report (continuation ${number} of ${MAX_CONTINUATIONS}).`,
      );
    });
    this.log.warn(`task ${record.id}: no report (${reason}), continuing the conversation (${number})`);
  }

  private async restartWithoutResume(entry: Supervised, record: TaskRecord): Promise<void> {
    const paths = this.store.paths(entry.id);
    const parent = record.revisionOf ? await this.store.get(record.revisionOf) : undefined;
    await writeFile(paths.brief, `${this.briefFor(record, parent, true)}\n`, { mode: 0o600 });
    await rm(paths.events, { force: true });
    await this.store.update(entry.id, (r) => {
      r.resumeConversationId = undefined;
      r.nextPrompt = undefined;
      r.status = "queued";
      r.process = undefined;
      r.startedAt = undefined;
      r.progress = emptyProgress();
      r.warnings.push(
        `Conversation ${record.resumeConversationId ?? ""} could not be resumed; the revision runs in a new conversation with the previous result in its brief.`,
      );
    });
    this.log.warn(`task ${entry.id}: resume failed, restarting without the previous conversation`);
  }

  private async lastResult(
    eventsPath: string,
    provider: AgentProvider,
  ): Promise<Extract<ProviderEvent, { kind: "result" }> | undefined> {
    const text = await readFile(eventsPath, "utf8").catch(() => "");
    let last: Extract<ProviderEvent, { kind: "result" }> | undefined;
    for (const line of text.split("\n")) {
      const event = provider.parseEventLine(line);
      if (event?.kind === "result") last = event;
    }
    return last;
  }

  // ── Stopping ────────────────────────────────────────────────────────────────────────────────────

  private async stopProcess(id: string, reason: "cancelled" | "timed_out"): Promise<void> {
    const record = await this.store.update(id, (r) => {
      r.cancelRequested ??= { at: nowIso(), reason };
    });
    const pid = record.process?.pid;
    if (pid === undefined || !(await this.isOwnAgent(record, pid))) return;
    this.log.info(`task ${id}: stopping agent (${reason})`);
    signalProcessGroup(pid, "SIGINT");
    const grace = this.config.killGraceMs;
    setTimeout(() => {
      if (isProcessAlive(pid)) signalProcessGroup(pid, "SIGTERM");
    }, grace).unref();
    setTimeout(() => {
      if (isProcessAlive(pid)) signalProcessGroup(pid, "SIGKILL");
    }, grace * 2).unref();
  }

  async cancel(id: string): Promise<TaskRecord> {
    const record = await this.store.get(id);
    if (isFinished(record.status)) {
      throw new RelayError("TASK_ALREADY_FINISHED", `Task ${id} already finished as ${record.status}.`);
    }
    if (record.status === "queued") {
      const updated = await this.store.update(id, (r) => {
        r.status = "cancelled";
        r.finishedAt = nowIso();
        r.cancelRequested = { at: nowIso(), reason: "cancelled" };
        r.outcome = emptyOutcome({ error: "Cancelled before it started." });
      });
      await this.store.release(id);
      return updated;
    }
    await this.stopProcess(id, "cancelled");
    return this.waitFor(id, Math.ceil((this.config.killGraceMs * 2 + 5000) / 1000));
  }

  // ── Reading ─────────────────────────────────────────────────────────────────────────────────────

  get(id: string): Promise<TaskRecord> {
    return this.store.get(id);
  }

  async list(statuses: readonly TaskStatus[] | undefined, limit: number): Promise<TaskRecord[]> {
    const all = await this.store.list();
    return all.filter((t) => !statuses || statuses.length === 0 || statuses.includes(t.status)).slice(0, limit);
  }

  /** Waits until the task finishes or `seconds` pass, whichever comes first. */
  async waitFor(id: string, seconds: number): Promise<TaskRecord> {
    const deadline = Date.now() + seconds * 1000;
    let record = await this.store.get(id);
    while (!isFinished(record.status) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(1000, this.config.pollIntervalMs)));
      if (this.supervised.has(id)) await this.tick();
      record = await this.store.get(id);
    }
    return record;
  }

  async removeWorktree(id: string): Promise<{ removed: string; branchKept: string }> {
    const record = await this.store.get(id);
    if (!isFinished(record.status)) throw new RelayError("TASK_NOT_FINISHED", `Task ${id} is still ${record.status}.`);
    const git = record.git;
    if (!git?.worktreePath) throw new RelayError("INVALID_INPUT", `Task ${id} did not run in a worktree of its own.`);
    if (!existsSync(record.workspace))
      throw new RelayError("INVALID_INPUT", `The worktree ${record.workspace} no longer exists.`);
    const others = (await this.store.list()).filter(
      (t) => t.id !== id && t.workspace === record.workspace && !isFinished(t.status),
    );
    if (others.length > 0)
      throw new RelayError("TASK_NOT_FINISHED", `Task ${others[0]?.id ?? ""} is still using ${record.workspace}.`);
    const dirty = await gitStatus(record.workspace);
    if (dirty.length > 0) {
      throw new RelayError(
        "WORKTREE_NOT_CLEAN",
        `The worktree has ${dirty.length} uncommitted or untracked path(s); it is kept so nothing is lost. Commit, move or discard them yourself first.`,
        { paths: dirty.slice(0, 30).map((entry) => `${entry.status} ${entry.path}`) },
      );
    }
    await removeWorktree(git.repoRoot, record.workspace);
    await this.store.update(id, (r) => {
      r.warnings.push(`Worktree ${record.workspace} removed at ${nowIso()}; branch ${git.branch} kept.`);
    });
    return { removed: record.workspace, branchKept: git.branch };
  }
}

function emptyOutcome(partial: Partial<TaskOutcome>): TaskOutcome {
  return {
    cliStatus: undefined,
    finishedReason: undefined,
    exitCode: undefined,
    signal: undefined,
    error: undefined,
    response: undefined,
    usage: undefined,
    durationSeconds: undefined,
    ...partial,
  };
}

export function decideStatus(
  record: Pick<TaskRecord, "cancelRequested">,
  result: Extract<ProviderEvent, { kind: "result" }> | undefined,
  exit: { exitCode: number | null; signal: NodeJS.Signals | null } | undefined,
  stderr: string,
): TaskStatus {
  // A run that finished before a stop request arrived did finish
  if (result?.status === "SUCCESS" && !result.finishedReason) return "completed";
  if (record.cancelRequested?.reason === "timed_out") return "timed_out";
  if (record.cancelRequested) return "cancelled";
  if (result?.finishedReason === "print_timeout" || /DEADLINE_EXCEEDED|print timeout/i.test(stderr)) return "timed_out";
  if (result?.finishedReason === "interrupted" || result?.status === "CANCELED" || result?.status === "INTERRUPTED")
    return "cancelled";
  if (result?.status === "SUCCESS") return "completed";
  if (result?.status === "WAITING") return "awaiting_input";
  if (!result && exit?.signal) return "cancelled";
  return "failed";
}

function lastLines(text: string, count: number): string {
  return text
    .trim()
    .split("\n")
    .filter((line) => line.trim() !== "")
    .slice(-count)
    .join("\n");
}

async function readTail(file: string, bytes: number): Promise<string> {
  try {
    const handle = await open(file, "r");
    try {
      const { size } = await handle.stat();
      const length = Math.min(size, bytes);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, size - length);
      return buffer.toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return "";
  }
}

/** After a run: keep a compact, redacted event log and a redacted stderr (the raw files may hold tool output). */
async function compactLogs(eventsPath: string, stderrPath: string): Promise<void> {
  const raw = await readFile(eventsPath, "utf8").catch(() => undefined);
  if (raw !== undefined) {
    const compact = raw
      .split("\n")
      .map((line) => compactEventLine(line))
      .filter((line): line is string => line !== undefined)
      .join("\n");
    const tmp = `${eventsPath}.compact`;
    await writeFile(tmp, compact ? `${compact}\n` : "", { mode: 0o600 });
    await rename(tmp, eventsPath);
  }
  const err = await readFile(stderrPath, "utf8").catch(() => undefined);
  if (err !== undefined) await writeFile(stderrPath, truncate(redact(err), 200_000), { mode: 0o600 });
}

/** The verified facts of a finished task, as plain text for a revision brief. */
export function describeVerification(record: TaskRecord): string {
  const v = record.verification;
  if (!v) return "No verification is available.";
  if (v.kind === "read_only") return v.note;
  const lines = [
    `Branch: ${v.branch ?? "(detached)"} at ${v.headSha?.slice(0, 12) ?? "?"}; base ${v.baseSha.slice(0, 12)}.`,
    `Commits since base: ${v.commits.length === 0 ? "none" : v.commits.map((c) => `${c.sha.slice(0, 10)} ${c.subject}`).join("; ")}.`,
    `Files changed in commits: ${v.committedFiles.length === 0 ? "none" : v.committedFiles.map((f) => `${f.status} ${f.path}`).join(", ")}.`,
    `Uncommitted: ${v.uncommitted.length === 0 ? "none" : v.uncommitted.map((f) => `${f.status.trim()} ${f.path}`).join(", ")}.`,
    `Pushed: ${v.pushed ? `yes (${v.upstream ?? ""})` : "no"}.`,
  ];
  if (v.pullRequest) lines.push(`Pull request: ${v.pullRequest.url} (${v.pullRequest.state}).`);
  if (v.mismatches.length > 0) lines.push(`Differences from the report: ${v.mismatches.join(" ")}`);
  return lines.join("\n");
}
