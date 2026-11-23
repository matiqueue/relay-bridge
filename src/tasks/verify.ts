import { existsSync } from "node:fs";
import {
  changedFiles,
  commitsBetween,
  listLocalBranches,
  repoInfo,
  status,
  upstreamInfo,
  type ChangedFile,
} from "../git/git.js";
import type { AgentReport } from "../prompt/report.js";
import { runCommand } from "../util/process.js";
import type { CheckoutSnapshot, GitVerification, ReadOnlyVerification, TaskRecord } from "./types.js";

/**
 * What Relay Bridge checks itself after a run, instead of trusting the agent's report: the branch, the commits since
 * the base, the changed files, the push state and the pull request — and whether the original checkout changed while
 * the agent worked.
 */
export async function snapshot(dir: string): Promise<CheckoutSnapshot | undefined> {
  const info = await repoInfo(dir).catch(() => undefined);
  if (!info) return undefined;
  const entries = await status(info.root).catch(() => []);
  return {
    head: info.head,
    status: entries.map((entry) => `${entry.status} ${entry.path}`).sort(),
    branches: await listLocalBranches(info.root).catch(() => []),
  };
}

function changedBetween(before: CheckoutSnapshot, after: CheckoutSnapshot): string[] {
  const a = new Set(before.status);
  const b = new Set(after.status);
  const paths = new Set<string>();
  for (const line of a) if (!b.has(line)) paths.add(line.slice(3));
  for (const line of b) if (!a.has(line)) paths.add(line.slice(3));
  return [...paths].sort();
}

function sameCommit(a: string, b: string): boolean {
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  return x.length >= 7 && y.length >= 7 && (x.startsWith(y) || y.startsWith(x));
}

export function compareReport(
  report: AgentReport | undefined,
  facts: {
    expectedBranch: string;
    branch: string | undefined;
    commits: readonly { sha: string }[];
    files: readonly ChangedFile[];
    uncommitted: readonly { path: string }[];
    pushed: boolean;
  },
): string[] {
  const mismatches: string[] = [];
  if (facts.branch !== facts.expectedBranch) {
    mismatches.push(
      `The workspace is on "${facts.branch ?? "a detached HEAD"}", not on the task branch "${facts.expectedBranch}".`,
    );
  }
  if (!report) return mismatches;
  if (report.branch && report.branch !== facts.branch) {
    mismatches.push(
      `The report names branch "${report.branch}", the workspace is on "${facts.branch ?? "a detached HEAD"}".`,
    );
  }
  for (const commit of report.commits) {
    if (!facts.commits.some((c) => sameCommit(c.sha, commit.sha))) {
      mismatches.push(`Reported commit ${commit.sha} ("${commit.message}") is not on the branch since the base.`);
    }
  }
  if (report.commits.length === 0 && facts.commits.length > 0) {
    mismatches.push(`The report lists no commits, but the branch has ${facts.commits.length} since the base.`);
  }
  if (report.pushed && !facts.pushed) {
    mismatches.push(
      "The report says the branch was pushed, but the local repository shows no up-to-date upstream for it.",
    );
  }
  const touched = new Set([
    ...facts.files.map((f) => f.path),
    ...facts.files.flatMap((f) => (f.from ? [f.from] : [])),
    ...facts.uncommitted.map((f) => f.path),
  ]);
  for (const file of report.files_changed) {
    const normalized = file.path.replace(/^\.\//, "");
    const found = [...touched].some((p) => p === normalized || normalized.endsWith(`/${p}`));
    if (!found) mismatches.push(`The report lists ${file.path} (${file.change}), but git shows no change to it.`);
  }
  return mismatches;
}

async function findPullRequest(dir: string, branch: string): Promise<GitVerification["pullRequest"]> {
  try {
    const result = await runCommand(
      "gh",
      ["pr", "list", "--head", branch, "--state", "all", "--limit", "1", "--json", "url,number,state,isDraft"],
      { cwd: dir, timeoutMs: 20_000, env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" } },
    );
    if (result.exitCode !== 0) return undefined;
    const [pr] = JSON.parse(result.stdout) as { url: string; number: number; state: string; isDraft: boolean }[];
    return pr ? { url: pr.url, number: pr.number, state: pr.state, draft: pr.isDraft } : undefined;
  } catch {
    return undefined;
  }
}

export async function verifyGit(record: TaskRecord): Promise<GitVerification | undefined> {
  const git = record.git;
  if (!git) return undefined;
  const checkedAt = new Date().toISOString();
  if (!existsSync(record.workspace)) {
    return {
      kind: "git",
      checkedAt,
      branch: undefined,
      headSha: undefined,
      baseSha: git.baseSha,
      commits: [],
      committedFiles: [],
      uncommitted: [],
      upstream: undefined,
      pushed: false,
      aheadOfUpstream: 0,
      pullRequest: undefined,
      originalCheckoutChanges: [],
      mismatches: [`The workspace ${record.workspace} no longer exists.`],
    };
  }
  const info = await repoInfo(record.workspace);
  const branch = info?.branch;
  const commits = await commitsBetween(record.workspace, git.baseSha).catch(() => []);
  const committedFiles = await changedFiles(record.workspace, git.baseSha).catch(() => []);
  const uncommitted = await status(record.workspace).catch(() => []);
  const upstream = branch ? await upstreamInfo(record.workspace, branch) : { upstream: undefined, ahead: 0, behind: 0 };
  const pushed = upstream.upstream !== undefined && upstream.ahead === 0;
  const pullRequest =
    git.allowPullRequest && pushed && branch ? await findPullRequest(record.workspace, branch) : undefined;

  let originalCheckoutChanges: string[] = [];
  if (git.worktreePath && record.snapshotBefore) {
    const after = await snapshot(git.repoRoot);
    if (after) originalCheckoutChanges = changedBetween(record.snapshotBefore, after);
  }

  const mismatches = compareReport(record.report, {
    expectedBranch: git.branch,
    branch,
    commits,
    files: committedFiles,
    uncommitted,
    pushed,
  });
  if (record.report?.pull_request_url && pullRequest && record.report.pull_request_url !== pullRequest.url) {
    mismatches.push(
      `The report links ${record.report.pull_request_url}, GitHub shows ${pullRequest.url} for the branch.`,
    );
  }

  return {
    kind: "git",
    checkedAt,
    branch,
    headSha: info?.head,
    baseSha: git.baseSha,
    commits,
    committedFiles: committedFiles.map((f) =>
      f.from ? { status: f.status, path: f.path, from: f.from } : { status: f.status, path: f.path },
    ),
    uncommitted: uncommitted.map((entry) => ({ status: entry.status, path: entry.path })),
    upstream: upstream.upstream,
    pushed,
    aheadOfUpstream: upstream.ahead,
    pullRequest,
    originalCheckoutChanges,
    mismatches,
  };
}

export async function verifyReadOnly(record: TaskRecord): Promise<ReadOnlyVerification> {
  const checkedAt = new Date().toISOString();
  if (!record.snapshotBefore) {
    return {
      kind: "read_only",
      checkedAt,
      checked: false,
      changedPaths: [],
      headMoved: false,
      note: "Not a git repository: read-only access was enforced by the sandbox, but changes could not be compared.",
    };
  }
  const after = await snapshot(record.workingDirectory);
  if (!after) {
    return {
      kind: "read_only",
      checkedAt,
      checked: false,
      changedPaths: [],
      headMoved: false,
      note: "The repository could not be read after the run.",
    };
  }
  const changedPaths = changedBetween(record.snapshotBefore, after);
  const headMoved = after.head !== record.snapshotBefore.head;
  return {
    kind: "read_only",
    checkedAt,
    checked: true,
    changedPaths,
    headMoved,
    note:
      changedPaths.length === 0 && !headMoved
        ? "The repository is unchanged."
        : "The repository changed while the task ran. The agent's sandbox mounts it read-only, so these changes most likely come from another process — you or the user. Check them.",
  };
}
