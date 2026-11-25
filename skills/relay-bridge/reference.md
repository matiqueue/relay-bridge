# Relay Bridge reference

The tool contracts behind the [skill](SKILL.md). Tool names in Claude Code are `mcp__relay-bridge__<tool>`.

## `delegate_task`

| Parameter               | Default                  | Meaning                                                                              |
| ----------------------- | ------------------------ | ------------------------------------------------------------------------------------ |
| `task`                  | required                 | the self-contained task text (20 to 100 000 characters)                              |
| `working_directory`     | required                 | absolute path of the repository (or directory) the task is about                     |
| `execution_mode`        | required                 | `modify` (isolated worktree) or `read_only` (analysis, repository mounted read-only) |
| `model`                 | `neon`                   | `hydrogen` (fast, routine), `neon` (default) or `carbon` (hardest problems)          |
| `effort`                | `medium`                 | `low`, `medium`, `high`, `xhigh`, `max` — must be supported by the model             |
| `title`                 | from the task            | a short title for listings                                                           |
| `isolation`             | `worktree`               | `modify` only: `worktree`, or `in_place` on a clean tree                             |
| `branch`                | `relay/<task-id>-<slug>` | `modify` only: the new task branch, following the repository's convention            |
| `base_ref`              | current branch           | `modify` only: branch, tag or commit to start from                                   |
| `reference_directories` | none                     | absolute paths the agent may read, never write (up to 10)                            |
| `commit`                | `true`                   | `modify` only: let the agent commit                                                  |
| `push`                  | `false`                  | `modify` only: let the agent push the task branch                                    |
| `open_pull_request`     | `false`                  | `modify` only, needs `push`: a draft pull request                                    |
| `pull_request_base`     | `base_ref`               | the pull request's base branch                                                       |
| `timeout_minutes`       | `60`                     | hard limit (up to the server's maximum, 360 by default)                              |
| `provider`              | `antigravity`            | the executor; only Antigravity today                                                 |

A read-only analysis of another repository:

```json
{
  "model": "neon",
  "effort": "medium",
  "execution_mode": "read_only",
  "working_directory": "/Users/me/code/new-app",
  "reference_directories": ["/Users/me/code/reference-app"],
  "task": "Compare the ESLint, Prettier, TypeScript, package.json scripts, GitHub Actions, issue and PR templates and commitlint setup of reference-app with new-app. In findings, list what new-app lacks, the exact files and settings to bring over, and what to adapt because it does not apply to new-app. Do not propose copying source code or business logic."
}
```

A change that ends in a draft pull request:

```json
{
  "model": "neon",
  "effort": "high",
  "execution_mode": "modify",
  "working_directory": "/Users/me/code/shop-api",
  "base_ref": "dev",
  "branch": "flow/feature/042-order-export",
  "push": true,
  "open_pull_request": true,
  "timeout_minutes": 90,
  "task": "Add GET /orders/export returning the orders of the signed-in shop as CSV.\nContext: orders are read through src/orders/repository.ts; follow the existing route style in src/routes/.\nScope: the endpoint, its tests and the API docs entry. Out of scope: pagination, other formats.\nVerify: npm run lint, npm run typecheck, npm test.\nDone when: the endpoint and tests are committed, the branch is pushed and a draft pull request with the repository's template is open."
}
```

## `check_agent_status`

`{"task_id": "rb-20261123-k3j9x2", "wait_seconds": 120}` — `status`, `finished`, `progress` (`steps`, `tool_calls`,
`last_tool`, `recent_tools`, `last_message`, `permission_denials`, `last_activity_at`), `elapsed_seconds`, `error`,
`next`.

Statuses: `queued`, `running`, `completed`, `failed`, `cancelled`, `timed_out`, `awaiting_input` (the agent asked a
question: answer it with `request_task_revision`).

## `get_agent_result`

`{"task_id": "rb-20261123-k3j9x2", "log_tail": 30}` (`log_tail` only for debugging).

- `report` — the agent's account: `status` (`completed`, `partial`, `blocked`, `failed`), `summary`, `work_done`,
  `files_changed`, `branch`, `commits`, `pushed`, `pull_request_url`, `tests` (`command`, `outcome`, `details`),
  `findings`, `known_issues`, `review_checklist`, `blocker`, `needed_to_continue`, `notes_for_lead`.
- `verified` (modifying tasks) — `branch`, `expected_branch`, `head_sha`, `base_ref`, `base_sha`, `commits`,
  `new_commits_in_this_run`, `files_changed`, `uncommitted_changes`, `pushed`, `upstream`, `ahead_of_upstream`,
  `pull_request`, `original_checkout_changes`, `report_mismatches`, `review_hint`.
- `verified` (read-only tasks) — `repository_checked`, `changed_paths_during_task`, `head_moved`, `note`.
- `outcome` — `cli_status`, `finished_reason`, `exit_code`, `error`, `usage`, and `response` when there is no report.
- `workspace`, `conversation_id`, `permission_denials`, `warnings`.

## `request_task_revision`

`{"task_id": "rb-20261123-k3j9x2", "instructions": "…", "effort": "high"}` — optional `model`, `effort`,
`continue_conversation` (default `true`), `push`, `open_pull_request`, `timeout_minutes`. Returns the new task's id
(`revision_of` points at the previous one). Escalating: `{"task_id": "rb-20261123-k3j9x2", "instructions": "…",
"model": "carbon", "effort": "high"}`. `model` is required when the task ran on the retired `argon`.

## Other tools

- `list_available_models` — `{"refresh": true}` to bypass the cache. Returns `hydrogen`, `neon` and `carbon` with
  their real ids, confirmed efforts and availability, plus `guidance` on when to use each.
- `list_agent_tasks` — `{"status": ["running", "queued"], "limit": 20}`.
- `cancel_agent_task` — `{"task_id": "…"}`; keeps the worktree.
- `cleanup_task_worktree` — `{"task_id": "…"}`; refuses a worktree with uncommitted changes, keeps the branch.

## Errors

| Code                                                               | What to do                                                                                                         |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `PATH_NOT_ALLOWED`, `INVALID_INPUT`                                | fix the path or the parameters as the message says                                                                 |
| `NOT_A_GIT_REPOSITORY`                                             | `modify` needs git; use `read_only` for other directories                                                          |
| `BRANCH_EXISTS`, `BRANCH_PROTECTED`                                | another branch name, or `request_task_revision` to continue existing work                                          |
| `DIRTY_WORKING_TREE`                                               | `in_place` needs a clean tree; use the default worktree isolation                                                  |
| `MODEL_UNAVAILABLE`, `EFFORT_UNSUPPORTED`                          | check `list_available_models`; never replace the model with another one; a retired `argon` task needs `model`      |
| `NOT_AUTHENTICATED`, `PROVIDER_UNAVAILABLE`                        | the user signs in by running `agy` once; `npm run doctor` in the Relay Bridge clone diagnoses it                   |
| `TASK_NOT_FINISHED`, `TASK_ALREADY_FINISHED`, `WORKTREE_NOT_CLEAN` | wait for or cancel the task; commit, move or discard leftovers yourself first                                      |
| status `failed` / `timed_out`                                      | read `outcome.error` and `permission_denials`, adjust the task or `timeout_minutes`, then revise or delegate again |
