# Delegation session example

This walkthrough shows a complete delegation session as an orchestrator (Claude Code) runs it through Relay Bridge:
checking available models, running a read-only comparison, delegating the changes on a new branch with a draft pull
request, waiting for completion, inspecting the result, asking for a revision, and cleaning up the worktree.

All paths below are placeholders.

## 1. Check available models

Call `list_available_models` once per session to see which aliases are available on the signed-in account and which
effort levels each one supports:

```json
{}
```

The response lists `neon` (default executor) and `argon` (hardest problems) with their resolved `model_id` values and
confirmed `efforts` (for example `["low", "medium", "high", "xhigh"]` for `neon` and `["low", "medium", "high"]` for
`argon`). Pass `"refresh": true` only if the account's plan changed recently.

## 2. Run a read-only comparison

Start with a `read_only` task to compare two repositories without touching either one. `working_directory` is the
repository you are analysing; `reference_directories` gives read-only access to another repository to compare against.

Call `delegate_task`:

```json
{
  "model": "neon",
  "effort": "medium",
  "execution_mode": "read_only",
  "title": "Compare tooling with reference-app",
  "working_directory": "/Users/me/code/app",
  "reference_directories": ["/Users/me/code/reference-app"],
  "task": "Compare the lint, formatting, TypeScript, and CI setup of /Users/me/code/reference-app with /Users/me/code/app.\n\nScope: ESLint, Prettier, tsconfig, package.json scripts, and .github/workflows.\nOut of scope: application code and runtime dependencies.\n\nIn findings, list what app lacks and the exact files and settings to port, adapted to app."
}
```

Relay Bridge mounts both directories read-only in the sandbox and returns a `task_id` immediately (for example
`rb-20261124-f4n8q1`). Once it finishes, `get_agent_result` returns the comparison in `report.findings` and confirms in
`verified` that the repository was not modified (`repository_checked`, `changed_paths_during_task`, `head_moved`,
`note`).

## 3. Delegate the changes

Using those findings, start a `modify` task on its own branch, allowing the agent to commit (the default), push the
task branch, and open a draft pull request against `base_ref`:

```json
{
  "model": "neon",
  "effort": "high",
  "execution_mode": "modify",
  "title": "Port lint and CI setup from reference-app",
  "working_directory": "/Users/me/code/app",
  "reference_directories": ["/Users/me/code/reference-app"],
  "branch": "flow/chore/014-lint-and-ci",
  "base_ref": "dev",
  "push": true,
  "open_pull_request": true,
  "task": "Port the ESLint, Prettier, and GitHub Actions CI setup from /Users/me/code/reference-app to /Users/me/code/app.\n\nScope:\n- Add eslint.config.js, .prettierrc.json, and .github/workflows/ci.yml adapted to app.\n- Update package.json scripts (lint, format:check, typecheck, check).\n\nOut of scope: refactoring application code beyond fixing lint errors.\n\nVerify: run npm ci and npm run check; everything must pass.\nDone when: changes are committed on the task branch, pushed, and a draft pull request is open against dev."
}
```

Relay Bridge creates a git worktree under `~/.relay-bridge/worktrees/app-rb-20261124-a7k2m9` on
`flow/chore/014-lint-and-ci` (leaving `/Users/me/code/app` untouched) and returns `task_id: "rb-20261124-a7k2m9"`.

## 4. Wait for the task

`delegate_task` runs asynchronously. Keep working, then call `check_agent_status` with `wait_seconds` (up to `300`) so
Relay Bridge blocks until the task finishes or the window elapses instead of polling in a tight loop:

```json
{
  "task_id": "rb-20261124-a7k2m9",
  "wait_seconds": 120
}
```

While the task is `running`, `progress` shows `steps`, `tool_calls`, `last_activity_at`, `last_tool`, `recent_tools`,
`last_message`, and any `permission_denials`. When `finished` is `true`, read the result.

## 5. Inspect the result

Call `get_agent_result` (optionally with `"log_tail": 30` when debugging a failure):

```json
{
  "task_id": "rb-20261124-a7k2m9"
}
```

A finished `modify` task returns two distinct blocks alongside metadata (`task_id`, `status`, `title`, `model`,
`effort`, `execution_mode`, `working_directory`, `workspace`, `elapsed_seconds`, `conversation_id`, `outcome`,
`permission_denials`, `warnings`):

```json
{
  "task_id": "rb-20261124-a7k2m9",
  "status": "completed",
  "title": "Port lint and CI setup from reference-app",
  "model": { "alias": "neon", "label": "Gemini 4 Neon (High)" },
  "effort": "high",
  "execution_mode": "modify",
  "working_directory": "/Users/me/code/app",
  "workspace": "/Users/me/.relay-bridge/worktrees/app-rb-20261124-a7k2m9",
  "elapsed_seconds": 184,
  "conversation_id": "9f8c2a1e-4b3d-4c2a-9e1f-0a1b2c3d4e5f",
  "report": {
    "status": "completed",
    "summary": "Ported ESLint, Prettier, and the CI workflow from reference-app and updated package.json scripts. All checks pass and a draft PR is open against dev.",
    "work_done": [
      "Added eslint.config.js and .prettierrc.json adapted to app",
      "Added .github/workflows/ci.yml running npm run check",
      "Added lint, format:check, typecheck, and check scripts to package.json"
    ],
    "files_changed": [
      { "path": "eslint.config.js", "change": "added", "description": "Typed ESLint flat config" },
      { "path": ".prettierrc.json", "change": "added", "description": "Prettier formatting rules" },
      { "path": ".github/workflows/ci.yml", "change": "added", "description": "CI workflow running npm run check" },
      {
        "path": "package.json",
        "change": "modified",
        "description": "Added check, lint, format:check, typecheck scripts"
      }
    ],
    "branch": "flow/chore/014-lint-and-ci",
    "commits": [{ "sha": "4e81c2b", "message": "chore: port lint, formatting and CI setup from reference-app" }],
    "pushed": true,
    "pull_request_url": "https://github.com/example/app/pull/15",
    "tests": [
      { "command": "npm run check", "outcome": "passed", "details": "format, typecheck, lint, tests, and build passed" }
    ],
    "findings": [],
    "known_issues": [],
    "review_checklist": ["Check the Node version matrix in .github/workflows/ci.yml"],
    "blocker": "",
    "needed_to_continue": "",
    "notes_for_lead": ""
  },
  "verified": {
    "branch": "flow/chore/014-lint-and-ci",
    "expected_branch": "flow/chore/014-lint-and-ci",
    "head_sha": "4e81c2b91f3a0e7d6c5b4a3f2e1d0c9b8a7f6e5d",
    "base_ref": "dev",
    "base_sha": "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b",
    "commits": [
      {
        "sha": "4e81c2b91f3a0e7d6c5b4a3f2e1d0c9b8a7f6e5d",
        "subject": "chore: port lint, formatting and CI setup from reference-app"
      }
    ],
    "new_commits_in_this_run": 1,
    "files_changed": [
      { "status": "A", "path": ".github/workflows/ci.yml" },
      { "status": "A", "path": ".prettierrc.json" },
      { "status": "A", "path": "eslint.config.js" },
      { "status": "M", "path": "package.json" }
    ],
    "uncommitted_changes": [],
    "pushed": true,
    "upstream": "origin/flow/chore/014-lint-and-ci",
    "ahead_of_upstream": 0,
    "pull_request": {
      "url": "https://github.com/example/app/pull/15",
      "number": 15,
      "state": "OPEN",
      "draft": true
    },
    "original_checkout_changes": [],
    "report_mismatches": [],
    "review_hint": "git -C /Users/me/.relay-bridge/worktrees/app-rb-20261124-a7k2m9 diff 1a2b3c4d5e6f...HEAD   # review before integrating"
  },
  "outcome": {
    "cli_status": "success",
    "finished_reason": "end_turn",
    "exit_code": 0,
    "usage": { "inputTokens": 42000, "outputTokens": 3100, "thinkingTokens": 6400, "totalTokens": 51500 }
  },
  "permission_denials": [],
  "warnings": []
}
```

### Understanding `report` vs `verified`

- **`report`** is what the agent itself claimed at the end of the run (enforced by `--json-schema`):
  - `status` (`completed`, `partial`, `blocked`, or `failed`), `summary`, and `work_done` describe the outcome and steps.
  - `files_changed` (`path`, `change`, `description`), `branch`, `commits` (`sha`, `message`), `pushed`, and
    `pull_request_url` are the agent's self-reported git state.
  - `tests` (`command`, `outcome`, `details`) lists every check the agent ran.
  - `findings` holds the answers for `read_only` analysis tasks.
  - `known_issues`, `review_checklist`, `blocker`, `needed_to_continue`, and `notes_for_lead` highlight remaining risks,
    what to review, or why the task stopped.
- **`verified`** is what Relay Bridge checked directly against git (and `gh` for pull requests) after the process
  exited:
  - For `modify` tasks: `branch`, `expected_branch`, `head_sha`, `base_ref`, `base_sha`, `commits` (`sha`, `subject`),
    `new_commits_in_this_run`, `files_changed` (`status`, `path`, and `from` on renames), `uncommitted_changes`
    (`status`, `path`), `pushed`, `upstream`, `ahead_of_upstream`, `pull_request` (`url`, `number`, `state`, `draft`),
    `original_checkout_changes`, `report_mismatches` (any disagreement between `report` and git), and `review_hint`.
  - For `read_only` tasks: `repository_checked`, `changed_paths_during_task`, `head_moved`, and `note`.

Always inspect the diff (for example using `verified.review_hint`) and check `verified.report_mismatches` and
`verified.uncommitted_changes` before integrating.

## 6. Request a revision

If your review turns up something to change, call `request_task_revision` with the finished `task_id` and specific
instructions:

```json
{
  "task_id": "rb-20261124-a7k2m9",
  "instructions": "In .github/workflows/ci.yml, pin actions/checkout and actions/setup-node to commit SHAs like reference-app does, and cancel in-progress runs on pull requests. Re-run npm run check, commit the fix, and push the branch."
}
```

Relay Bridge starts a new task (for example `rb-20261124-c3p9v2`, with `revision_of: "rb-20261124-a7k2m9"` and
`revision_number: 1`) on the **same branch and worktree**, resuming the agent's previous conversation by default
(`continue_conversation: true`). You can optionally override `model`, `effort`, `push`, `open_pull_request`, or
`timeout_minutes`. Wait for the revision with `check_agent_status` and inspect it with `get_agent_result` as before.

## 7. Clean up the worktree

After you integrate (or reject) the branch, remove the task's worktree with `cleanup_task_worktree`:

```json
{
  "task_id": "rb-20261124-a7k2m9"
}
```

Relay Bridge returns `removed_worktree` and `branch_kept`. It refuses if the worktree has uncommitted or untracked
changes, and it never deletes the branch.
