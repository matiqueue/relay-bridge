# Troubleshooting

Start with:

```bash
npm run doctor
```

It checks Node, git, gh, the data directory, the Antigravity CLI, its sign-in, and Hydrogen, Neon and Carbon with
their effort levels — the same way the MCP server sees them.

## The server does not show up in Claude Code

- `claude mcp list` — is `relay-bridge` there and connected? If not, register it (see
  [claude-code-setup.md](claude-code-setup.md)). A relative path or a missing `dist/` (forgot `npm run build`) are
  the usual causes.
- `claude mcp get relay-bridge` shows the command; run it yourself (`node …/dist/index.js`): it should print
  `relay-bridge … ready` on stderr and wait for input. Errors there are startup errors (for example an invalid
  `RELAY_BRIDGE_*` variable).

## `NOT_AUTHENTICATED` / `PROVIDER_UNAVAILABLE`

- The CLI is not signed in: run `agy` once in a terminal and complete the Google sign-in. Headless runs use the saved
  credentials from the system keychain and cannot sign in themselves.
- `agy` is not on the `PATH` the server gets from Claude Code: set `RELAY_BRIDGE_AGY_PATH` to its absolute path
  (`which agy`).

## `MODEL_UNAVAILABLE` / `EFFORT_UNSUPPORTED` / `QUOTA_EXHAUSTED`

- `list_available_models` (or `agy models`) shows what the account has. Hydrogen, Neon and Carbon need a plan that
  includes them (Google AI Pro or Ultra at the time of writing; Pro trials may not include every model). When all three
  are listed, each alias runs strictly on its own model. If an alias is missing from the account (for example, only
  `hydrogen` is available), Relay Bridge falls back to an available alias and records a warning; `MODEL_UNAVAILABLE`
  only happens when none of the three exist or when revising a retired `argon` task without naming a new model.
- `QUOTA_EXHAUSTED` (and `error_code: "QUOTA_EXHAUSTED"` in task status/result) means the Antigravity CLI hit a quota or
  rate limit. Wait for quota to reset, lower concurrency or effort, or retry on another available model (e.g.
  `hydrogen`) with `request_task_revision`.
- Effort levels differ per model: Carbon has no `xhigh` on current accounts. The error lists the supported levels.
- `argon` is retired. `delegate_task` rejects it; revising a task that ran on Argon fails with `MODEL_UNAVAILABLE`
  until you pass `model` (usually `carbon`, which took over Argon's role).
- After a plan change, `list_available_models` with `refresh: true` re-reads the account.

## A task failed

`get_agent_result` (with `log_tail: 30` for the last events) shows:

- `outcome.error` — the CLI's own error, e.g. quota exhausted or a model error;
- `permission_denials` — commands the policy blocked. The agent is told not to work around them; if it needed one
  legitimately (say a build tool that needs the network), add an allow rule with `RELAY_BRIDGE_EXTRA_ALLOW` and run
  the task again;
- `report.blocker` / `report.needed_to_continue` — what the agent says it needs.

The full record is `~/.relay-bridge/tasks/<task-id>/` (`task.json`, `events.ndjson`, `stderr.log`, `brief.md`).

## A task is stuck in `running`

- `check_agent_status` → `progress.last_activity_at` shows when it last did something; agents can be quiet while a
  long command runs.
- The CLI's `--print-timeout` and Relay Bridge's watchdog end it at `timeout_minutes`. `cancel_agent_task` stops it
  now (interrupt, then termination of the whole process group).
- If the Relay Bridge process that supervised it ended, any other instance adopts it within a few seconds; if no
  Claude Code session is running, the next one picks it up.

## Commits fail inside the agent

In a worktree, `git commit` writes the repository's shared `.git` directory, which is outside the sandbox. The policy
lets git run outside the sandbox and the brief tells the agent to retry with BypassSandbox; the CLI's first sandboxed
attempt failing with "Operation not permitted" is expected. Global git configuration files are mounted read-only so
your identity and includes apply. A commit signing setup that needs an agent socket or a hardware key may still fail:
set `commit: false` and commit yourself.

## `BRANCH_EXISTS` / `DIRTY_WORKING_TREE` / `WORKTREE_NOT_CLEAN`

- Pick another `branch`, or continue the earlier work with `request_task_revision`.
- `in_place` needs a clean tree: commit or stash, or use the default worktree isolation.
- `cleanup_task_worktree` keeps worktrees with uncommitted changes on purpose. Look at them (`git -C <worktree>
status`), keep what you need, then clean up.

## Quota

Each run uses your Antigravity plan's quota (it refreshes every few hours on paid plans). Lower
`RELAY_BRIDGE_MAX_CONCURRENCY`, use lower efforts for simple work, send routine work to Hydrogen, and prefer Neon
over Carbon unless the task needs Carbon.
