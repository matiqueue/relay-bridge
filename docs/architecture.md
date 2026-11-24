# Architecture

Relay Bridge is a small TypeScript program: an MCP server over stdio, a task manager, and one provider adapter. No
database, no daemon, no network service — state is a directory of JSON files, and the agents are ordinary child
processes that write their event streams to files.

```
src/
├── index.ts                  entry point: stdio transport, shutdown (agents keep running)
├── app.ts                    wiring: config, store, provider registry, task manager
├── server.ts                 the MCP tools: Zod input schemas, descriptions, JSON results
├── config.ts                 environment configuration
├── errors.ts                 RelayError codes the orchestrator can act on
├── tasks/
│   ├── manager.ts            lifecycle: validate, isolate, queue, run, supervise, finalize, revise, cancel
│   ├── store.ts              task directories, atomic writes, the supervision lock
│   ├── verify.ts             git facts after a run; read-only after-check
│   ├── views.ts              what the tools return
│   └── types.ts              the task record
├── providers/
│   ├── types.ts              the provider contract
│   ├── registry.ts           providers by id
│   └── antigravity/
│       ├── provider.ts       agy: discovery, effort probe, starting a detached run
│       ├── models.ts         `agy models` → neon/argon aliases (no hardcoded ids)
│       ├── events.ts         stream-json → normalised events; log compaction
│       └── policy.ts         the per-run permission policy (allow/deny rules, sandbox settings)
├── prompt/
│   ├── brief.ts              the brief every agent receives
│   └── report.ts             the report schema (enforced with --json-schema) and its parser
├── git/git.ts                the git operations Relay Bridge runs itself
├── security/paths.ts         path and branch validation
├── security/redact.ts        secret redaction
└── util/process.ts           running programs without a shell, process groups
```

## The provider contract

`src/providers/types.ts` defines what a provider is:

```ts
interface AgentProvider {
  readonly id: string;
  describe(options?): Promise<ProviderDescription>; // models behind the aliases, with efforts
  resolveModel(alias, effort): Promise<ResolvedModel>; // throws, never substitutes
  start(spec: RunSpec): Promise<RunHandle>; // a detached process writing events to spec.eventsPath
  parseEventLine(line): ProviderEvent | undefined; // init / step / result
  readonly processMarker: string;
}
```

Everything around it — validation, worktrees, the brief, persistence, supervision, timeouts, verification, the tools
— is provider-neutral. Adding an executor (for example GitHub Copilot's CLI, once it can run a task headlessly and
report events) means one more directory under `providers/`, one `register()` call in `app.ts`, and widening the
`provider` enum of `delegate_task`. The aliases (`neon`, `argon`) are Antigravity's today; another provider would
bring its own and the alias enum would follow.

## A task's life

```
delegate_task ─▶ validate paths, branch, model+effort ─▶ worktree / scratch dir ─▶ task.json (queued)
                                                                                     │
                       schedule(): free slot (counted across every instance) ───────┘
                                                                                     ▼
            agy -p <brief> --model <variant> --output-format stream-json --json-schema <schema>
                --print-timeout <n>m --settings <policy> --sandbox --disable-slash-commands --mode accept-edits
                [--conversation <id>]          stdout → events.ndjson, stderr → stderr.log, own process group
                                                                                     │
       supervisor tick (every RELAY_BRIDGE_POLL_MS): read new events → progress ◀────┘
                                                                                     │ exit / result event
                                                                                     ▼
           finalize: status from the result (SUCCESS, interrupted, print_timeout, WAITING…), parse the report,
           verify git (or the read-only after-check), compact + redact the logs, write everything at once
```

If the run "succeeds" without a report — the turn ended at a command headless mode had to deny, or the agent stopped
short (for example after waiting for a background command) — the task goes back to the queue and resumes its own
conversation with a short continuation prompt instead of finishing (`missingReport`, at most twice).

`decideStatus` maps the CLI's outcome: `SUCCESS` → `completed`; `finished_reason: print_timeout` (exit 3) or the
watchdog → `timed_out`; `interrupted` or a requested stop → `cancelled`; `WAITING` → `awaiting_input`; anything else
→ `failed` with the CLI's error.

## Several instances, restarts

Claude Code starts one Relay Bridge process per session; all of them share `~/.relay-bridge/tasks`. Each task is
supervised by exactly one live process — the holder of its `owner.lock` (created with `O_EXCL`, considered stale when
the PID in it is gone). Every instance's supervisor scans for tasks whose holder is gone and adopts them:

- the agent is still running (its PID is alive _and_ its command line contains the task's own schema path, so a
  reused PID is not mistaken for it) → the new supervisor keeps reading its event log;
- the agent has exited → the task is finalized from the files.

Agents are started detached, with their output going to files rather than pipes, so they survive the end of the
session that started them. A queued task is started by the instance that holds its lock; the concurrency limit counts
running tasks in the shared store.

## Revisions

`request_task_revision` creates a new task that points at its parent (`revision_of`): the same branch and worktree
(recreated from the branch if you removed it), `--conversation <parent's conversation id>` so Gemini continues with
its own context (documented in the CLI's headless mode), and a brief with the requested changes and the facts
verified after the previous run. If the CLI cannot resume the conversation, the run is restarted once in a new
conversation with the previous report in its brief, and a warning says so.

## Why these choices

- **Headless `agy -p`, not ACP.** The CLI's documented headless mode gives everything needed — a conversation id,
  NDJSON progress, structured output, timeouts, resumption — with one process per run. ACP (`agy acp`) is an editor
  protocol with permission prompts and sessions that would make Relay Bridge an editor.
- **`accept-edits` + sandbox + explicit rules, not `auto`.** `auto` mode is not available on every account (the CLI
  falls back to `default`), and its automatic command review is a judgment call. An explicit policy behaves the same
  everywhere and can be read in `agent-settings.json`.
- **Files, not a database.** A few hundred small JSON files are fast to list, easy to inspect and need no migration.
- **Verification over trust.** The report is the agent's account; git is the source of truth for what it did.
