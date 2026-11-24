---
name: relay-bridge
description: Delegate real repository work to Gemini through the Relay Bridge MCP tools (delegate_task, check_agent_status, get_agent_result, request_task_revision). Covers when to delegate, choosing neon or argon and the effort, writing a self-contained task, working_directory, read-only analysis of other repositories, task branches, push and draft pull requests, parallel tasks, reviewing the verified result and integrating it. Use whenever you plan, split or start coding, testing, refactoring, migration, documentation, configuration-analysis or review work in a local git repository that another agent could do on its own, and whenever the user mentions Relay Bridge, Gemini, Antigravity, delegating or offloading work.
allowed-tools: mcp__relay-bridge__list_available_models mcp__relay-bridge__list_agent_tasks mcp__relay-bridge__check_agent_status mcp__relay-bridge__get_agent_result
---

# Delegating work with Relay Bridge

Relay Bridge gives you a contractor: **Gemini**, running through the Google Antigravity CLI. You stay the **tech lead**:
you own the architecture, the decisions, the split of work, the review and the integration. Gemini takes well-defined
tickets and does them on its own — reads the repository, edits files, runs the checks, fixes what it broke, commits on
its own branch, pushes and opens a draft pull request when you allow it — and reports back. Relay Bridge isolates the
work, enforces a safety policy, tracks the tasks and **verifies the git facts itself**.

Delegate actively. Whenever a piece of work is well defined and can be done without you steering every step, consider
handing it over and use the time to plan, review or work on something else. Detailed parameters, result fields and
error codes: [reference.md](reference.md).

## The loop

1. `mcp__relay-bridge__list_available_models` once per session: which models and efforts the account has.
2. `mcp__relay-bridge__delegate_task` → a `task_id` at once. The agent works in the background.
3. Keep working. `mcp__relay-bridge__check_agent_status` now and then; with `wait_seconds` (up to 300) when you have
   nothing else to do.
4. `mcp__relay-bridge__get_agent_result`: the agent's `report` plus what Relay Bridge `verified`.
5. Review the diff and run the checks yourself.
6. `mcp__relay-bridge__request_task_revision` for changes, or integrate the work the repository's way.
7. `mcp__relay-bridge__cleanup_task_worktree` once the work is integrated or rejected.

`mcp__relay-bridge__list_agent_tasks` shows tasks in progress, including those started by other sessions — check it
at the start of a session. `mcp__relay-bridge__cancel_agent_task` stops a task that is no longer needed.

## What to delegate

Good: analysing another repository's configuration and preparing it for a new one; an independent feature, endpoint or
component; tests for existing code; fixing a diagnosed bug; a refactor with a clear scope; documentation; library
compatibility analysis; preparing a migration; an independent code review of a branch; the same change in several
repositories (one task each, in parallel).

Not: architecture decisions that are yours; work that needs a running conversation with the user; things you can do
faster yourself (a one-line change, an answer from context you already have); data that must not reach another model
provider.

## Model and effort

Only two models exist for you, and Relay Bridge never substitutes another:

- **`neon`** — the default executor, best quality for the quota: features, components, endpoints, refactors, tests,
  typical bugs, docs, configuration analysis, migrations, repetitive changes. Most tasks.
- **`argon`** — the hardest problems: architecture questions, complex bugs (concurrency, hard-to-reproduce failures),
  intricate algorithms, demanding analysis and code review.

| Task                                         | Start with                 |
| -------------------------------------------- | -------------------------- |
| Simple, mechanical                           | neon `low` / `medium`      |
| Typical development                          | neon `medium` / `high`     |
| Harder implementation, many files            | neon `high` / `xhigh`      |
| Complex bug                                  | argon `high`               |
| Hard architecture analysis, demanding review | argon at its highest level |

Efforts differ per model (argon has no `xhigh` on current accounts); `list_available_models` is the truth. Quota is
shared: do not use argon or a high effort where neon `medium` will do.

## Writing the task

Write it like a ticket for a capable engineer who has never seen this conversation:

1. **Goal** — what and why.
2. **Context** — the decisions that matter, the files and modules involved, constraints.
3. **Scope** — what to do and, explicitly, what not to do.
4. **Verification** — the commands to run (lint, type check, tests, build).
5. **Done when** — how the agent knows it has finished.
6. **Conventions** the repository's own docs do not state (branch name, commit format).

The agent reads the repository's README, CONTRIBUTING, CLAUDE.md and AGENTS.md itself; do not paste them. It does not
know what you know from this conversation — that is what the task text is for.

## `working_directory`: always explicit

Pass the absolute path of the repository's root for every task. Repositories live in many places: never assume a
common parent folder, and never guess. Take it from `git rev-parse --show-toplevel` where you work, or ask. Roots,
the home directory, folders of projects and system or credential locations are refused (`PATH_NOT_ALLOWED`).

## Read-only analysis

`execution_mode: "read_only"` for analysis, research and review. The repository is mounted read-only in the agent's
sandbox; the answers come back in `report.findings`. Pass other repositories to study in `reference_directories` —
the agent can read them, never write them. A common pattern: a read-only analysis first, you decide what to take,
then a `modify` task (or your own work) that applies it.

## Changing a repository

`execution_mode: "modify"` runs in a **new git worktree on a new branch** — your checkout and other tasks are not
touched, so you can keep working in the same repository.

- `branch`: follow the repository's convention. If it requires an issue before a branch (for example
  `flow/<type>/<nnn>-<description>`), open the issue first the repository's way. Never invent issue numbers.
- `base_ref`: where to start (default: the repository's current branch — often you want `dev` or `main` explicitly).
- `commit` (default true), `push` (default false: only the task branch), `open_pull_request` (needs push: a **draft**
  pull request to `pull_request_base`, default `base_ref`; the agent never merges).
- Integration branches (`main`, `master`, `dev`, `develop`, `prod`, `production`, `staging`, `release`, `trunk`) are
  refused as task branches.

## Reading the result

`completed` means the run ended; what was achieved is `report.status` (`completed`, `partial`, `blocked`, `failed`) and
the `verified` section. Read `report.summary`, `tests` (every command with its real outcome), `findings`,
`known_issues`, `review_checklist`, `blocker` and `needed_to_continue`; then `verified` — branch, commits since the base,
changed and uncommitted files, push, pull request — and **`report_mismatches`**: every entry there is a warning sign.
`permission_denials` lists commands the policy blocked; `warnings` says when Relay Bridge had to resume the agent.

## Review before you integrate — always yourself

```bash
git -C <workspace> log --oneline <base_sha>..HEAD
git -C <workspace> diff <base_sha>...HEAD
git -C <workspace> status
```

`workspace` and `base_sha` are in the result (`verified.review_hint` has the command). Run the repository's checks in
the worktree, go through `review_checklist`, and judge the change against the architecture and the conventions.

## Revisions

`request_task_revision` with the finished `task_id` and specific instructions: what to change, why, how to verify. It
continues on the same branch and worktree with new commits, usually in the same Gemini conversation. You may switch
the model or the effort — for example to argon when neon is stuck on a hard problem.

## Parallel tasks

Up to `RELAY_BRIDGE_MAX_CONCURRENCY` tasks run at once (default 3, shared by every session); the rest wait as
`queued`. Each modifying task has its own worktree, but never give two agents the same files or changes that depend on
each other — the conflict appears only when you integrate. Run dependent work one after the other.

## What the agent cannot do

The policy blocks: merging pull requests; pushing to integration branches; force-pushing; deleting or renaming
branches and tags; `git reset --hard`, `git clean` and history rewriting; `gh pr merge`, `gh pr review`, `gh api`,
repository settings, secrets and releases; publishing packages; `sudo` and global configuration; writing outside its
workspace (your checkout and `reference_directories` included); pushing or opening a pull request unless the task
allows it. It must not change the established architecture: when that is needed, it reports a blocker.

## Integration is yours

1. Review and run the checks; clear up every mismatch and denial first.
2. Ask for a revision, or fix a small thing yourself on the same branch.
3. Integrate the repository's way — usually a pull request with its template, green CI and the merge its rules
   prescribe (a merge commit, the owner's approval). Finish a draft pull request from the agent and mark it ready.
   Never merge into a main branch without the approval the process requires.
4. `cleanup_task_worktree` afterwards (it removes only a clean worktree and keeps the branch).
