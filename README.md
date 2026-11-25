# Relay Bridge

A local [MCP](https://modelcontextprotocol.io) server that lets **Claude Code delegate real repository work to
other AI coding agents** — starting with **Gemini through the Google Antigravity CLI**.

Claude stays the tech lead: it plans, decides, reviews and integrates. Gemini becomes a contractor it can hand
well-defined tickets to — "port this repository's lint and CI setup to that one", "implement this endpoint with
tests", "find out why this test is flaky" — and that does the work on its own: reads the code, edits files, runs the
checks, fixes what it broke, commits on its own branch, pushes it if allowed and reports back. Claude gets a
structured report plus facts Relay Bridge verified itself, reviews the diff, and asks for revisions or integrates.

```
┌──────────────┐  MCP (stdio)  ┌──────────────┐  agy -p … --output-format stream-json  ┌──────────────────┐
│ Claude Code  │──────────────▶│ Relay Bridge │───────────────────────────────────────▶│ Antigravity CLI  │
│ (the lead)   │◀──────────────│  task runner │◀───────── events, structured report ───│ Gemini (Hydrogen,│
└──────────────┘  task ids,    └──────┬───────┘                                        │ Neon, Carbon) in │
                  status,             │ git worktree add, verify commits/push           │ a sandbox        │
                  results             ▼                                                 └────────┬─────────┘
                               ┌──────────────┐        edits, tests, commits, push               │
                               │ your repo    │◀─────────────────────────────────────────────────┘
                               │ + worktree   │
                               └──────────────┘
```

It is a personal tool for any local git repository — private, public, work or client — not tied to one project.

## Contents

- [Why](#why) · [How a delegated task runs](#how-a-delegated-task-runs) · [Models and effort](#models-and-effort)
- [Requirements](#requirements) · [Install](#install) · [Register in Claude Code](#register-in-claude-code) · [The skill](#the-claude-code-skill)
- [Tools](#tools) · [Delegating work](#delegating-work) · [Monitoring](#monitoring) · [Worktrees and branches](#worktrees-and-branches)
- [Security](#security) · [Configuration](#configuration) · [Where state lives](#where-state-lives)
- [Troubleshooting](#troubleshooting) · [Development](#development) · [Status and limitations](#status-and-limitations)

## Why

Every file Claude reads and every test run it watches costs its own context and time. Much of that work is
well-defined enough for another agent to do end to end. Relay Bridge turns "ask another model a question" into
"give another agent a ticket": it isolates the work, constrains what the agent may do, keeps track of many tasks at
once, survives restarts, and hands back results Claude can check instead of trust.

## How a delegated task runs

1. Claude calls `delegate_task` with a self-contained task, a `working_directory`, a model alias, an effort level and
   an `execution_mode`.
2. Relay Bridge validates the path, resolves the alias to a real model id **discovered from the account**, and
   prepares isolation:
   - **modify** — a new `git worktree` on a new branch (the repository's own checkout is never touched), or
     `in_place` on a clean tree you point it to;
   - **read_only** — an empty scratch directory, with the repository mounted **read-only** in the agent's sandbox.
3. It starts `agy` in headless mode (`-p`, `--output-format stream-json`, `--json-schema` for the report,
   `--print-timeout`, `--sandbox`) with a per-run permission policy (`--settings`) and returns a task id at once.
4. While the agent works, Relay Bridge reads its event stream: steps, tool calls, the last command or file, permission
   denials. `check_agent_status` shows them; `wait_seconds` waits for the end.
5. When the agent finishes, Relay Bridge parses its structured report and **verifies it against git**: branch,
   commits since the base, changed and uncommitted files, push state, the pull request — and lists every mismatch.
6. Claude reads `get_agent_result`, reviews the diff itself, then integrates, or calls `request_task_revision`, which
   continues on the same branch and, when the CLI can resume it, in the same Gemini conversation.

## Models and effort

Relay Bridge uses exactly three Gemini 4 models, one per kind of work, and never falls back to another one:

| Alias      | Model             | Role                                                    | Typical work                                                                                                      |
| ---------- | ----------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `hydrogen` | Gemini 4 Hydrogen | fast, routine work and operations that need low latency | mechanical or repetitive edits, renames, formatting, version bumps, small fixes with a known cause, quick lookups |
| `neon`     | Gemini 4 Neon     | **default**: everyday complex work and standard coding  | features, components, endpoints, refactors, tests, typical bugs, docs, configuration analysis, migrations         |
| `carbon`   | Gemini 4 Carbon   | the hardest problems                                    | deep reasoning, architecture planning, complex bugs, intricate algorithms, long verification, demanding review    |

Argon, the earlier "hardest problems" model, is retired: `argon` is no longer accepted, and Carbon took over its role.
Tasks recorded on Argon stay readable; a revision of one names its model explicitly.

The real model ids (for example `gemini-4-neon-high`) are **not hardcoded**: they are read from `agy models` and
matched by family name in both the id and the display name, preferring the newest generation; Orchestrator variants
(including "Orchestrator (Carbon)") are never used. The effort levels are confirmed with the CLI (`agy -p /effort`,
answered locally). On a current Google AI Pro account that gives:

| Alias      | Efforts                          |
| ---------- | -------------------------------- |
| `hydrogen` | `low`, `medium`, `high`, `xhigh` |
| `neon`     | `low`, `medium`, `high`, `xhigh` |
| `carbon`   | `low`, `medium`, `high`          |

`list_available_models` always shows what _your_ account has. When all three aliases are listed, each runs strictly on
its own model; if a requested alias is unavailable on the account (for example, only `hydrogen` is available), Relay
Bridge falls back to an available alias and records a warning on the task (`MODEL_UNAVAILABLE` only if none of the
three exist). Unsupported effort levels and retired `argon` always fail explicitly (`EFFORT_UNSUPPORTED`,
`MODEL_UNAVAILABLE`).

A reasonable policy, which the orchestrator adapts per task: quick, routine or mechanical work → Hydrogen
`low`/`medium`; typical work → Neon `medium`/`high`; harder implementations → Neon `high`/`xhigh`; complex bugs →
Carbon `high`; architecture planning and long verification → Carbon at its highest level. Start one tier lower when
in doubt and move up with `request_task_revision` (it can switch the model) when the result shows the task needed it.

## Requirements

- macOS (the primary platform; Linux works where the Antigravity sandbox does).
- Node.js 22 or newer, git, and optionally the GitHub CLI (`gh`, signed in) for agents that open pull requests.
- The [Antigravity CLI](https://antigravity.google/docs/getting-started) (`agy`), signed in once interactively.
  Relay Bridge uses your existing sign-in (the CLI reads it from the system keychain); **no API key and no extra
  billing**. Hydrogen, Neon and Carbon require a plan that includes them (Google AI Pro or Ultra at the time of
  writing).

## Install

```bash
git clone https://github.com/matiqueue/relay-bridge.git ~/code/relay-bridge   # any location
cd ~/code/relay-bridge
npm install
npm run build
npm run doctor   # checks Node, git, agy, the sign-in, Hydrogen/Neon/Carbon and their efforts, the data directory
```

## Register in Claude Code

Register the server **once, in user scope**, so every Claude Code session on the machine has it, whatever project it
works in (user-scoped servers are stored in `~/.claude.json` and load in all projects):

```bash
claude mcp add --scope user relay-bridge -- node ~/code/relay-bridge/dist/index.js
claude mcp list   # relay-bridge … ✓ Connected
```

Use the absolute path of your clone. Environment variables for the server go before `--`, for example
`-e RELAY_BRIDGE_MAX_CONCURRENCY=2`. Details, updating and removal: [docs/claude-code-setup.md](docs/claude-code-setup.md).

### The Claude Code skill

The server tells Claude what its tools do; the **`relay-bridge` skill** tells it how to work with them — when to
delegate, `hydrogen`, `neon` or `carbon` and which effort, how to write a task, how to review and integrate the
result. Install it once as a personal skill (a symlink, so it updates with the clone):

```bash
npm run skill:install   # ~/.claude/skills/relay-bridge -> ./skills/relay-bridge
```

Claude loads it when it plans or splits work. To make a project delegate actively, add a line to its `CLAUDE.md`,
for example: _"Use the relay-bridge skill: delegate well-defined work to Gemini, review it, integrate it yourself."_
plus the project's own conventions (branch naming, whether agents may push).

## Tools

| Tool                    | What it does                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------- |
| `list_available_models` | Hydrogen, Neon and Carbon as the account has them: real ids, confirmed efforts, availability                  |
| `delegate_task`         | starts a task asynchronously and returns its `task_id`                                                        |
| `list_agent_tasks`      | tasks, newest first, filtered by status — including tasks started from other Claude Code sessions             |
| `check_agent_status`    | status and live progress (steps, tool calls, last command or file, denials); `wait_seconds` waits up to 300 s |
| `get_agent_result`      | the agent's report and the verified git facts; `log_tail` for debugging                                       |
| `cancel_agent_task`     | interrupts the agent, then terminates it and its child processes; keeps the worktree                          |
| `request_task_revision` | asks for changes: same branch and worktree, the same conversation when it can be resumed                      |
| `cleanup_task_worktree` | removes a finished task's worktree if it has no uncommitted changes; keeps the branch                         |

Statuses: `queued`, `running`, `completed`, `failed`, `cancelled`, `timed_out`, `awaiting_input`.

## Delegating work

Write the task like a ticket for a capable engineer who has not seen the conversation: the goal, the context, the
scope and what is out of scope, the files or areas, how to verify, what done looks like.

```jsonc
// delegate_task
{
  "model": "neon",
  "effort": "high",
  "execution_mode": "modify",
  "working_directory": "/Users/me/code/shop-api",
  "branch": "flow/feature/042-order-export", // follow the repository's convention
  "push": true, // let it push the branch
  "open_pull_request": false, // or true for a draft PR (it never merges)
  "task": "Add GET /orders/export returning CSV …\nScope: … Out of scope: …\nVerify with npm test and npm run lint.\nDone when: …",
}
```

Analysis of another repository, writing nothing:

```jsonc
{
  "model": "neon",
  "effort": "medium",
  "execution_mode": "read_only",
  "working_directory": "/Users/me/code/new-app",
  "reference_directories": ["/Users/me/code/reference-app"],
  "task": "Compare the lint, format, TypeScript, CI and PR-template setup of reference-app with new-app. In findings, list what new-app lacks and the exact files and settings to copy, adapted to new-app.",
}
```

A typical two-step pattern: a read-only analysis first, then a `modify` task (or your own work) that applies it. For a
complete end-to-end session — from checking models to revision and worktree cleanup — see
[docs/examples.md](docs/examples.md).

## Monitoring

`delegate_task` returns immediately. Keep working, and check back:

```jsonc
// check_agent_status
{ "task_id": "rb-20261123-k3j9x2", "wait_seconds": 120 }
```

The status shows the number of steps and tool calls, the last command or file, the latest message fragment and any
permission denials. Several tasks can run at once (`RELAY_BRIDGE_MAX_CONCURRENCY`, default 3); the rest wait in
`queued`. Tasks keep running when the Claude Code session that started them ends: the next Relay Bridge instance
adopts them.

To inspect local usage across models, sessions/tasks, projects and days without spending any model tokens, run
`npm run stats` (or `relay-stats [summary|tasks|models|projects|daily|full|<task-id>] [today|7d|24h|2w] [-m …] [-s …] [-p …] [--sort …] [--json]`;
inside Claude Code, `!relay-stats` runs it locally in the shell).

## Worktrees and branches

- A `modify` task gets its own worktree under `~/.relay-bridge/worktrees/<repo>-<task-id>` on a new branch
  (`branch`, or `relay/<task-id>-<slug>`), created from `base_ref` (default: the repository's current branch).
  Several agents — and you — can work on the same repository at the same time without touching each other's files.
- The branch must not exist yet, and integration branches (`main`, `master`, `dev`, `develop`, `prod`, `production`,
  `staging`, `release`, `trunk`) are refused: agents always work on a task branch.
- Agents may commit (`commit`, default on), push **their own branch** (`push`, default off) and open a **draft**
  pull request (`open_pull_request`, default off). They can never merge, push to integration branches, force-push,
  delete or rename branches, `reset --hard` or `clean` — the per-run policy denies it (see [Security](#security)).
- Worktrees are never removed automatically. When you are done, `cleanup_task_worktree` removes a clean one and keeps
  its branch; a worktree with uncommitted changes is refused.
- `isolation: "in_place"` works directly in `working_directory` (it must have a clean tree) — useful for a worktree
  you created yourself.

## Security

Relay Bridge runs an autonomous agent on your machine, so it constrains it in layers:

- **Paths**: `working_directory` and `reference_directories` must be absolute, existing directories; filesystem and
  home roots, system locations and credential/agent folders (`~/.ssh`, `~/.aws`, `~/.gemini`, `~/.claude`,
  `~/Library`…) are refused. `RELAY_BRIDGE_ALLOWED_ROOTS` restricts it further.
- **Isolation**: a worktree per modifying task; read-only tasks get the repository mounted read-only.
- **Sandbox**: every run uses the Antigravity terminal sandbox (`sandbox-exec` on macOS): commands can write only the
  workspace, the network is limited, `.env` and `~/.ssh` are hidden.
- **Policy**: a per-run allow/deny list (Antigravity's permission engine, deny always wins) blocks force pushes,
  pushes to integration branches, branch deletion, `reset --hard`, `clean`, `gh pr merge`, `gh api`, publishing,
  `sudo` and more; push and pull request creation are denied unless the task allows them. Your own Antigravity
  settings are never modified.
- **No shell**: every process is started with an argument array; no user input is ever interpreted by a shell.
- **Secrets**: task records, logs and tool results are redacted (tokens, keys, credentials in URLs…); the raw event
  log of a run is compacted and redacted when it ends; everything is stored with owner-only permissions.
- **Verification**: git facts are checked by Relay Bridge, not taken from the report.

The full trust model, what is and is not guaranteed, and the exact policy: [docs/security.md](docs/security.md).

## Configuration

All optional, set as environment variables of the MCP server (`claude mcp add … -e KEY=value -- …`):

| Variable                               | Default                        | Meaning                                                                |
| -------------------------------------- | ------------------------------ | ---------------------------------------------------------------------- |
| `RELAY_BRIDGE_HOME`                    | `~/.relay-bridge`              | task records, logs, worktrees                                          |
| `RELAY_BRIDGE_WORKTREE_ROOT`           | `$RELAY_BRIDGE_HOME/worktrees` | where task worktrees are created                                       |
| `RELAY_BRIDGE_AGY_PATH`                | `agy`                          | the Antigravity CLI                                                    |
| `RELAY_BRIDGE_MAX_CONCURRENCY`         | `3`                            | tasks running at once, across all sessions                             |
| `RELAY_BRIDGE_DEFAULT_TIMEOUT_MINUTES` | `60`                           | default `timeout_minutes`                                              |
| `RELAY_BRIDGE_MAX_TIMEOUT_MINUTES`     | `360`                          | the largest `timeout_minutes` accepted                                 |
| `RELAY_BRIDGE_ALLOWED_ROOTS`           | (any)                          | `:`-separated roots working directories must be inside                 |
| `RELAY_BRIDGE_EXTRA_ALLOW`             | (none)                         | extra allow rules for modifying runs, JSON: `["command(cargo build)"]` |
| `RELAY_BRIDGE_MODEL_CACHE_SECONDS`     | `600`                          | how long discovered models are cached                                  |
| `RELAY_BRIDGE_LOG`                     | (info)                         | `quiet` silences informational stderr lines                            |

## Where state lives

```
~/.relay-bridge/
├── tasks/<task-id>/
│   ├── task.json            the record: request, status, progress, outcome, report, verification
│   ├── events.ndjson        the agent's event stream (compacted and redacted when the run ends)
│   ├── stderr.log           the CLI's diagnostics (redacted)
│   ├── brief.md             exactly what the agent was asked
│   ├── report.schema.json   the report schema given to the agent
│   ├── agent-settings.json  the run's permission policy
│   ├── workspace/           the scratch directory of read-only tasks
│   └── tmp/                 the agent's temporary files (e.g. a pull request description)
└── worktrees/<repo>-<task-id>/   git worktrees of modifying tasks
```

Files are owner-only (`0600`/`0700`). Repositories are never copied: worktrees are git's own checkouts of your
repository. History is kept until you delete it; deleting a task directory removes only Relay Bridge's record.

## Troubleshooting

Start with `npm run doctor`. Common cases — not signed in, a model missing from the plan, a command denied by the
policy, a stuck task, quota — are in [docs/troubleshooting.md](docs/troubleshooting.md).

## Development

```bash
npm run check              # Prettier, type check (TypeScript 7), typed ESLint, unit tests, build
npm run test:integration   # the real Antigravity CLI and your account: quota, network, minutes
```

The unit tests need no Antigravity: they drive real git repositories with a stand-in CLI
(`test/fixtures/fake-agy.mjs`) that speaks the same stream protocol. The architecture and how to add another
provider: [docs/architecture.md](docs/architecture.md). Contribution flow: [CONTRIBUTING.md](CONTRIBUTING.md).

## Status and limitations

Verified against Antigravity CLI 1.5.16 on macOS with a Google AI Pro account: discovery of Hydrogen, Neon and Carbon
and their efforts, delegated changes on Neon in worktrees with commits, revisions resuming the conversation,
read-only enforcement by the sandbox, read-only tasks on Carbon and Hydrogen, and cancellation; the deny policy for
destructive git operations was verified with 1.5.15.

- **One provider.** Only Gemini through Antigravity is implemented; the provider boundary is there for more.
- **`auto` mode is not used.** Relay Bridge runs `accept-edits` with the sandbox and its own policy, which behaves the
  same on every account (Antigravity's `auto` mode is not available on all accounts).
- **No live input.** If the agent stops to ask a question, the task ends as `awaiting_input`; answer it with
  `request_task_revision`.
- **Approvals end a turn.** In headless mode a command that needs approval is denied and, in Antigravity CLI 1.5.15,
  ends the agent's turn; a turn can also end before the agent's final answer. Relay Bridge then resumes the
  conversation and asks the agent to finish and report (twice at most) — an agent that really needs a denied command
  reports it as a blocker.
- **Quota.** Runs use your plan's Antigravity quota; heavy parallel use can exhaust it (the task then fails with the
  CLI's message).
- **Read-only is enforced by the sandbox, not by Relay Bridge.** After a read-only task, Relay Bridge reports any
  change it sees in the repository (which may also come from you).

## License

No license has been chosen yet: all rights reserved. Security issues: [SECURITY.md](SECURITY.md).
