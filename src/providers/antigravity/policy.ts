import path from "node:path";
import { PROTECTED_BRANCHES } from "../../security/paths.js";
import type { AgentPolicy, ExecutionMode } from "../types.js";

/**
 * Regular expressions here are matched by the CLI (a Go binary, RE2 syntax): no lookahead or backreferences.
 *
 * The permission policy of one delegated run, in Antigravity's `action(target)` rule syntax
 * (antigravity.google/docs/permissions). It is passed with `--settings` and applies to that run only: the user's
 * own settings.json is never modified.
 *
 * Antigravity evaluates Deny > Ask > Allow, and in headless mode an action that would need approval is soft-denied.
 * The run also uses `--sandbox`: shell commands run in the OS sandbox (sandbox-exec on macOS) where only the
 * workspace and paths allowed under write_file are writable, paths under read_file are mounted read-only and the
 * network is limited to read_url domains. A `command` allow rule lets that command run outside the sandbox without
 * a prompt — that is how git (which writes the shared .git directory of a worktree), gh and dependency installs work.
 */
export interface PolicyInput {
  readonly mode: ExecutionMode;
  /** The repository (or directory) the task is about. Read-only tasks see it mounted read-only. */
  readonly repository: string;
  /** The shared .git directory, when the repository is a git repository. */
  readonly gitCommonDir: string | undefined;
  readonly referenceDirectories: readonly string[];
  /** The run's own directory for temporary files, writable by the agent's file tools. */
  readonly temporaryDirectory: string | undefined;
  /** Global git config files the sandboxed git must be able to read (identity, includes). */
  readonly gitConfigPaths: readonly string[];
  readonly allowCommit: boolean;
  readonly allowPush: boolean;
  readonly allowPullRequest: boolean;
  readonly extraAllowRules: readonly string[];
}

/** Package registries the sandbox may reach so dependency installs can run inside it. */
const REGISTRY_DOMAINS = ["registry.npmjs.org", "registry.yarnpkg.com", "github.com", "codeload.github.com"];

const ALWAYS_DENIED_COMMANDS = [
  // History and branches that are not the task's own
  "git push --force",
  "git push -f",
  "git push --force-with-lease",
  "git push --mirror",
  "git push --all",
  "git push --delete",
  "git push -d",
  "git push --prune",
  "git reset --hard",
  "git clean",
  "git branch -D",
  "git branch -d",
  "git branch --delete",
  "git branch -m",
  "git branch -M",
  "git branch --move",
  "git tag -d",
  "git tag --delete",
  "git worktree remove",
  "git worktree prune",
  "git stash drop",
  "git stash clear",
  "git update-ref -d",
  "git reflog expire",
  "git filter-branch",
  "git filter-repo",
  "git config --global",
  "git config --system",
  "git remote add",
  "git remote remove",
  "git remote rm",
  "git remote set-url",
  "git remote rename",
  // GitHub actions that are the lead's or the owner's to take
  "gh pr merge",
  "gh pr close",
  "gh pr review",
  "gh repo delete",
  "gh repo edit",
  "gh repo rename",
  "gh repo archive",
  "gh release",
  "gh secret",
  "gh variable",
  "gh api",
  "gh auth",
  "gh workflow",
  "gh run",
  "gh ruleset",
  "gh issue close",
  "gh issue delete",
  "gh label delete",
  // Publishing, privileges, the user's machine
  "npm publish",
  "npm unpublish",
  "npm deprecate",
  "npm owner",
  "npm token",
  "npm login",
  "npm adduser",
  "sudo",
  "su",
  "security",
  "defaults write",
  "launchctl",
  "osascript",
  "crontab",
];

const ALWAYS_DENIED_REGEX = [
  // Force or deleting refspecs wherever the flag sits: `git push origin x --force`, `+x`, `:x`
  String.raw`git\s+push\b.*\s(--force\b|--force-with-lease\b|-f\b|--mirror\b|--all\b|--delete\b|-d\b|--prune\b|\+\S|:\S)`,
  // Pushing to an integration branch
  String.raw`git\s+push\b.*\s(\S+:)?(refs/heads/)?(${PROTECTED_BRANCHES.filter((b) => b !== "HEAD").join("|")})(\s|$)`,
  // Deleting from the filesystem root or the home directory
  String.raw`\brm\s+(-[a-zA-Z]*\s+)*(/|~|\$HOME)(\s|/\s|$)`,
  // Piping a download into a shell
  String.raw`\b(curl|wget)\b.*\|\s*(sudo\s+)?(ba|z|da|k)?sh\b`,
];

const MODIFY_ALLOWED_COMMANDS = [
  "git",
  "gh pr create",
  "gh pr view",
  "gh pr list",
  "gh pr diff",
  "gh pr checks",
  "gh pr status",
  "gh issue view",
  "gh issue list",
  "gh repo view",
  "npm ci",
  "npm install",
  "npm i",
  "pnpm install",
  "pnpm i",
  "yarn install",
  "bun install",
];

// Read-only runs: every command runs in the sandbox, where the repository is mounted read-only. Only commands that
// need the network may leave it (a broad list here would let e.g. `cat` read ~/.ssh outside the sandbox).
const READ_ONLY_ALLOWED_COMMANDS = [
  "gh pr view",
  "gh pr list",
  "gh pr diff",
  "gh pr checks",
  "gh issue view",
  "gh issue list",
  "gh repo view",
];

const READ_ONLY_DENIED_REGEX = [
  String.raw`--output(=|\s)`,
  String.raw`\bfind\b.*\s-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)\b`,
  String.raw`\bgit\s+(commit|push|merge|rebase|reset|checkout|switch|restore|stash|cherry-pick|revert|tag|am|apply|clean|rm|mv|add|worktree|init|clone|fetch|pull|gc|prune|notes|update-index|update-ref)\b`,
];

const command = (prefix: string) => `command(${prefix})`;
const regex = (pattern: string) => `command(regex:${pattern})`;

export function buildPolicy(input: PolicyInput): AgentPolicy {
  const allow: string[] = [];
  const deny: string[] = [...ALWAYS_DENIED_COMMANDS.map(command), ...ALWAYS_DENIED_REGEX.map(regex)];

  for (const configPath of input.gitConfigPaths) allow.push(`read_file(${configPath})`);
  if (input.temporaryDirectory) allow.push(`write_file(${input.temporaryDirectory})`);
  for (const dir of input.referenceDirectories) {
    allow.push(`read_file(${dir})`);
    deny.push(`write_file(${dir})`);
  }

  if (input.gitCommonDir) {
    // The agent's file tools never edit git internals; hooks and config would outlive the task
    deny.push(`write_file(${input.gitCommonDir})`);
    deny.push(`write_file(${path.join(input.gitCommonDir, "hooks")})`);
  }

  if (input.mode === "read_only") {
    allow.push(`read_file(${input.repository})`);
    deny.push(`write_file(${input.repository})`);
    allow.push(...READ_ONLY_ALLOWED_COMMANDS.map(command));
    deny.push(...READ_ONLY_DENIED_REGEX.map(regex));
    return { allow: unique(allow), deny: unique(deny) };
  }

  allow.push(...MODIFY_ALLOWED_COMMANDS.map(command));
  allow.push(...REGISTRY_DOMAINS.map((domain) => `read_url(${domain})`));
  allow.push(...input.extraAllowRules);
  if (!input.allowCommit) deny.push(command("git commit"), command("git push"), command("gh pr create"));
  if (!input.allowPush) deny.push(command("git push"), command("gh pr create"));
  if (!input.allowPullRequest) deny.push(command("gh pr create"));
  return { allow: unique(allow), deny: unique(deny) };
}

function unique(rules: readonly string[]): string[] {
  return [...new Set(rules)];
}

/**
 * The `--settings` object for one run: the policy plus the sandbox switch. `toolPermission` decides what happens to
 * commands no rule covers: modifying runs let sandboxed commands proceed (the sandbox confines them to the
 * workspace), read-only runs ask — which headless mode soft-denies — so only the read-only allow list runs.
 */
export function buildSessionSettings(_mode: ExecutionMode, policy: AgentPolicy): Record<string, unknown> {
  return {
    enableTerminalSandbox: true,
    toolPermission: "proceed-in-sandbox",
    allowNonWorkspaceAccess: false,
    artifactReviewPolicy: "always-proceed",
    permissions: { allow: policy.allow, deny: policy.deny },
  };
}
