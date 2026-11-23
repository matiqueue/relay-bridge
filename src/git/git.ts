import path from "node:path";
import { RelayError } from "../errors.js";
import { runCommand, type CommandResult } from "../util/process.js";

/**
 * The few git operations Relay Bridge performs itself: inspecting a repository, creating a task worktree, and
 * reading back the facts of what an agent did (commits, changed files, push state). Every call passes arguments as an
 * array and disables interactive prompts, so a credential prompt can never hang the server.
 */
const GIT_ENV: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" };

export async function git(args: readonly string[], cwd: string, timeoutMs = 30_000): Promise<CommandResult> {
  return runCommand("git", args, { cwd, env: { ...process.env, ...GIT_ENV }, timeoutMs });
}

async function gitOk(args: readonly string[], cwd: string, what: string): Promise<string> {
  const result = await git(args, cwd);
  if (result.exitCode !== 0) {
    throw new RelayError("GIT_FAILED", `${what} failed: ${(result.stderr || result.stdout).trim() || "no output"}`, {
      command: ["git", ...args].join(" "),
    });
  }
  return result.stdout;
}

export interface RepoInfo {
  /** The top level of the working tree (a worktree's own root when the directory is a linked worktree). */
  readonly root: string;
  /** The shared .git directory of the repository. */
  readonly commonDir: string;
  readonly isLinkedWorktree: boolean;
  readonly branch: string | undefined;
  readonly head: string | undefined;
}

export async function repoInfo(dir: string): Promise<RepoInfo | undefined> {
  const top = await git(["rev-parse", "--show-toplevel"], dir);
  if (top.exitCode !== 0) return undefined;
  const root = top.stdout.trim();
  const common = (await gitOk(["rev-parse", "--git-common-dir"], root, "git rev-parse --git-common-dir")).trim();
  const gitDir = (await gitOk(["rev-parse", "--git-dir"], root, "git rev-parse --git-dir")).trim();
  const commonDir = path.resolve(root, common);
  const branchResult = await git(["symbolic-ref", "--short", "-q", "HEAD"], root);
  const headResult = await git(["rev-parse", "--verify", "-q", "HEAD"], root);
  return {
    root,
    commonDir,
    isLinkedWorktree: path.resolve(root, gitDir) !== commonDir,
    branch: branchResult.exitCode === 0 ? branchResult.stdout.trim() || undefined : undefined,
    head: headResult.exitCode === 0 ? headResult.stdout.trim() || undefined : undefined,
  };
}

export interface StatusEntry {
  /** Two-letter porcelain status, e.g. " M", "A ", "??". */
  readonly status: string;
  readonly path: string;
}

/** `git status --porcelain` with untracked files listed one by one. */
export async function status(dir: string): Promise<StatusEntry[]> {
  const out = await gitOk(["status", "--porcelain=v1", "-z", "--untracked-files=all"], dir, "git status");
  const entries: StatusEntry[] = [];
  const parts = out.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part || part.length < 4) continue;
    const code = part.slice(0, 2);
    entries.push({ status: code, path: part.slice(3) });
    // A rename or copy is followed by its source path
    if (code.startsWith("R") || code.startsWith("C")) i++;
  }
  return entries;
}

export async function branchExists(dir: string, branch: string): Promise<boolean> {
  const result = await git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], dir);
  return result.exitCode === 0;
}

export async function resolveCommit(dir: string, ref: string): Promise<string> {
  if (ref.startsWith("-")) throw new RelayError("INVALID_INPUT", `"${ref}" is not a valid git ref.`);
  const result = await git(["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`], dir);
  const sha = result.stdout.trim();
  if (result.exitCode !== 0 || !sha)
    throw new RelayError("INVALID_INPUT", `"${ref}" does not name a commit in ${dir}.`);
  return sha;
}

/** Creates `branch` at `baseSha` and checks it out in a new worktree at `worktreePath`. */
export async function addWorktree(
  repoRoot: string,
  worktreePath: string,
  branch: string,
  baseSha: string,
): Promise<void> {
  await gitOk(["worktree", "add", "-b", branch, "--", worktreePath, baseSha], repoRoot, "git worktree add");
}

/** Checks out an existing branch in a new worktree (used when a revision's worktree was removed). */
export async function addWorktreeForBranch(repoRoot: string, worktreePath: string, branch: string): Promise<void> {
  await gitOk(["worktree", "add", "--", worktreePath, branch], repoRoot, "git worktree add");
}

/** Removes a worktree. Never forces: git refuses when it has uncommitted or untracked changes. */
export async function removeWorktree(repoRoot: string, worktreePath: string): Promise<void> {
  await gitOk(["worktree", "remove", "--", worktreePath], repoRoot, "git worktree remove");
}

export async function switchToNewBranch(dir: string, branch: string): Promise<void> {
  await gitOk(["switch", "-c", branch], dir, "git switch -c");
}

export interface CommitInfo {
  readonly sha: string;
  readonly subject: string;
}

export async function commitsBetween(dir: string, base: string, head = "HEAD"): Promise<CommitInfo[]> {
  const out = await gitOk(["log", "--format=%H%x1f%s%x1e", `${base}..${head}`], dir, "git log");
  return out
    .split("\x1e")
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [sha = "", subject = ""] = record.split("\x1f");
      return { sha, subject };
    });
}

export interface ChangedFile {
  /** A, M, D, R, C, T (git diff --name-status, the score dropped). */
  readonly status: string;
  readonly path: string;
  readonly from?: string;
}

export async function changedFiles(dir: string, base: string, head = "HEAD"): Promise<ChangedFile[]> {
  const out = await gitOk(["diff", "--name-status", "-z", "-M", base, head], dir, "git diff --name-status");
  const parts = out.split("\0").filter((part) => part !== "");
  const files: ChangedFile[] = [];
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i] ?? "";
    const letter = code.charAt(0);
    if (letter === "R" || letter === "C") {
      const from = parts[++i] ?? "";
      const to = parts[++i] ?? "";
      files.push({ status: letter, path: to, from });
    } else {
      files.push({ status: letter, path: parts[++i] ?? "" });
    }
  }
  return files;
}

export interface UpstreamInfo {
  readonly upstream: string | undefined;
  readonly ahead: number;
  readonly behind: number;
}

/** What the local repository knows about the branch's upstream (no network: the agent's push updates these refs). */
export async function upstreamInfo(dir: string, branch: string): Promise<UpstreamInfo> {
  const up = await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", `${branch}@{upstream}`], dir);
  if (up.exitCode !== 0) return { upstream: undefined, ahead: 0, behind: 0 };
  const upstream = up.stdout.trim();
  const counts = await git(["rev-list", "--left-right", "--count", `${branch}...${upstream}`], dir);
  const [ahead = 0, behind = 0] = counts.stdout.trim().split(/\s+/).map(Number);
  return { upstream, ahead, behind };
}

export async function listLocalBranches(dir: string): Promise<string[]> {
  const out = await gitOk(
    ["for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads"],
    dir,
    "git for-each-ref",
  );
  return out.split("\n").filter(Boolean).sort();
}

/** Paths of the user's global git configuration that a sandboxed git needs to read (identity, includes). */
export function globalGitConfigPaths(home: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const xdg = env.XDG_CONFIG_HOME ? path.join(env.XDG_CONFIG_HOME, "git") : path.join(home, ".config", "git");
  return [path.join(home, ".gitconfig"), xdg];
}
