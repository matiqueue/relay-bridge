# Security model

Relay Bridge gives an AI agent real access to a repository on your machine. This page states what it protects, how,
and what it cannot guarantee.

## Who is trusted

- **You** and the **orchestrator** (Claude Code) are trusted: they choose the working directory, the task and the
  permissions (push, pull request) of each run.
- The **delegated agent** is not fully trusted. It follows the brief, but a model can misunderstand, and repository
  content (a README, an issue text, a dependency) can contain instructions aimed at it. Relay Bridge therefore limits
  what it _can_ do, independently of what it is asked to do.
- The **Antigravity CLI** is trusted to enforce its sandbox and permission engine as documented. Relay Bridge relies
  on them and adds its own checks around them.

## Layers

### 1. Paths

`working_directory` and `reference_directories` must be absolute paths to existing directories; symlinks are
resolved first (`src/security/paths.ts`). Refused:

- filesystem and folder-of-everything roots: `/`, your home directory, `/Users`, `/home`, `/tmp`, `/var`, `/Volumes`,
  `~/Projects`, `~/Documents`, `~/Desktop`, `~/Downloads`;
- system locations: `/System`, `/Library`, `/Applications`, `/usr`, `/bin`, `/sbin`, `/etc`, `/dev`, …;
- credentials and agent configuration: `~/Library`, `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.azure`, `~/.kube`,
  `~/.docker`, `~/.config/gcloud`, `~/.config/gh`, `~/.gemini`, `~/.claude`, `~/.codex`;
- Relay Bridge's own state (except its task worktrees, so a task can build on another task's worktree).

`RELAY_BRIDGE_ALLOWED_ROOTS` turns this into an allow list. Branch names are validated (git ref rules, no option-like
or shell characters) and integration branches are refused.

### 2. Isolation

- `modify` tasks run in a new git worktree on a new branch; your checkout and other tasks' worktrees are separate
  directories. `in_place` requires a clean tree, so there is nothing of yours to overwrite.
- `read_only` tasks run in an empty scratch directory; the repository is mounted read-only into the sandbox and the
  agent's file tools are denied writing to it.
- Worktrees are never deleted automatically; `cleanup_task_worktree` refuses one with uncommitted changes and never
  deletes branches.

### 3. The sandbox

Every run passes `--sandbox` and `enableTerminalSandbox: true`. Per the Antigravity documentation, shell commands
then run under `sandbox-exec` (macOS) / namespaces (Linux): writable are the workspace, temporary directories and
build caches; `read_file` paths are mounted read-only; `.env` files and `~/.ssh` are blocked; outbound network is
limited to `read_url` domains (Relay Bridge allows the npm and GitHub hosts so dependency installs can work).

### 4. The per-run policy

`src/providers/antigravity/policy.ts` builds an allow/deny list in Antigravity's `action(target)` syntax, passed with
`--settings` for that run only (your `~/.gemini/antigravity-cli/settings.json` is never touched). Deny always wins.

Always denied (modify and read-only), among others:

- `git push --force`, `-f`, `--force-with-lease`, `+refspec`, `--mirror`, `--all`, `--delete`, `:branch`, `--prune`,
  and any push to `main`, `master`, `dev`, `develop`, `development`, `prod`, `production`, `trunk`, `staging`,
  `release`;
- `git reset --hard`, `git clean`, `git branch -d/-D/-m/-M`, `git tag -d`, `git worktree remove/prune`,
  `git stash drop/clear`, `git update-ref -d`, `git reflog expire`, `git filter-branch/filter-repo`,
  `git config --global/--system`, `git remote add/remove/set-url/rename`;
- `gh pr merge/close/review`, `gh repo delete/edit/rename/archive`, `gh release`, `gh secret`, `gh variable`,
  `gh api`, `gh auth`, `gh workflow`, `gh run`, `gh ruleset`, `gh issue close/delete`;
- `npm publish/unpublish/deprecate/owner/token/login/adduser`, `sudo`, `su`, `security`, `defaults write`,
  `launchctl`, `osascript`, `crontab`, `rm` of `/` or the home directory, piping a download into a shell;
- file-tool writes to the repository's `.git` directory and its hooks, and to reference directories.

Depending on the task: `git push` and `gh pr create` are denied unless `push` / `open_pull_request` are set;
`git commit` is denied when `commit: false`.

Allowed to run outside the sandbox without a prompt (modify): `git` (minus the above), `gh pr create/view/list/diff/
checks/status`, `gh issue view/list`, `gh repo view`, dependency installs (`npm ci`, `npm install`, `pnpm install`,
`yarn install`, `bun install`), plus `RELAY_BRIDGE_EXTRA_ALLOW`. In read-only runs only the `gh` reading commands
(`gh pr view/list/diff/checks`, `gh issue view/list`, `gh repo view`) may leave the sandbox — a broad list would let a
command such as `cat` read `~/.ssh` outside it. Everything else runs inside the sandbox
(`toolPermission: proceed-in-sandbox`), where a write to a read-only repository simply fails.

A command that needs an approval nobody can give in headless mode is denied by the CLI, and Antigravity CLI 1.5.15
then ends the agent's turn without an answer. Relay Bridge detects this, resumes the same conversation and tells the
agent the command was denied and to finish without it (at most twice; then the task fails with the denied commands
in its error).

### 5. Processes

Every program — git, gh, agy — is started with an argument array and `shell: false`; nothing from a tool call is ever
interpreted by a shell. Agents run in their own process group, so cancelling or timing out stops their children too
(interrupt, then `SIGTERM`, then `SIGKILL`). The agent's environment is the user's, minus variables of the
orchestrator (`CLAUDE*`, `ANTHROPIC_*`, `MCP_*`, `RELAY_BRIDGE_*`, `npm_*`).

### 6. Secrets in records and logs

Tool summaries, progress messages, reports, errors, the compacted event log and stderr are passed through
`src/security/redact.ts` (GitHub, Google, AWS, Slack, npm and API-key token formats, JWTs, private keys, bearer
tokens, credentials in URLs and `password=`/`token:` assignments). While a run is in progress its raw event log exists
with `0600` permissions; when it ends it is rewritten compacted and redacted. Redaction is pattern based: it lowers
the risk, it does not make printing a secret harmless.

### 7. Verification

The report is the agent's claim. Relay Bridge reads the branch, commits, changed files, push state and pull request
from git itself and lists every mismatch; after a read-only task it compares the repository's state with the state
before the run.

## What is not guaranteed

- That the agent's changes are correct, secure or what you wanted — review the diff; that is the orchestrator's job.
- That a command on the allow list cannot be misused. `git` is broadly allowed outside the sandbox for modifying runs
  (commits in a worktree must write the repository's shared `.git`); the deny list covers the destructive forms, but
  a creative command line may slip past a prefix rule. Pushes are confined to what the deny rules recognise.
- Protection against other software on your machine or a compromised account.
- The guarantees of the Antigravity sandbox itself on platforms where it is unavailable (then `--sandbox` has no
  effect; `npm run doctor` and the Antigravity docs tell you whether it is).

Report vulnerabilities privately: [SECURITY.md](../SECURITY.md).
