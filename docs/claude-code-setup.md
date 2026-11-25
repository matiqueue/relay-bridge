# Setting up Relay Bridge in Claude Code

Relay Bridge is meant to be installed once and registered once, globally, so that every Claude Code session — in any
project, in the terminal or the desktop app — can delegate work, passing the `working_directory` of whatever
repository it is working on.

## 1. Install and check

```bash
git clone https://github.com/matiqueue/relay-bridge.git ~/code/relay-bridge
cd ~/code/relay-bridge
npm install
npm run build
npm run doctor
```

`doctor` must show the Antigravity CLI signed in and `hydrogen`, `neon` and `carbon` available. If `agy` was never
signed in, run `agy` once in a terminal and sign in with your Google account first.

## 2. Register the server in user scope

Claude Code has three MCP scopes: `local` (one project, the default), `project` (`.mcp.json`, shared through git)
and `user` (all your projects, stored in `~/.claude.json`). Relay Bridge belongs in **user** scope:

```bash
claude mcp add --scope user relay-bridge -- node ~/code/relay-bridge/dist/index.js
```

- Use the absolute path of your clone (the shell expands `~`).
- Options for Claude Code (`--scope`, `-e`) come before `--`; everything after it is the server's command line.
- To pass configuration: `claude mcp add --scope user -e RELAY_BRIDGE_MAX_CONCURRENCY=2 relay-bridge -- node …`.

Check it:

```bash
claude mcp list                 # relay-bridge: node …/dist/index.js - ✓ Connected
claude mcp get relay-bridge     # scope: User config
```

In a session, `/mcp` lists the server and its eight tools. Before changing an existing registration, `claude mcp get
relay-bridge` shows what is there; `claude mcp add` refuses to overwrite a server of the same name in the same
scope.

## 3. Install the skill

The server describes its tools; the `relay-bridge` skill (`skills/relay-bridge/`) is the playbook for using them:
when to delegate, the model and effort, how to write a task, how to review and integrate the result. Install it as a
personal skill:

```bash
npm run skill:install
```

It creates the symlink `~/.claude/skills/relay-bridge` pointing to the clone, so `git pull` updates it and Claude Code
picks up changes without a restart. The script never overwrites an existing `relay-bridge` folder that is not its own
link; `npm run skill:uninstall` removes only that link. In a session, `/skills` lists it; `/relay-bridge` loads it by
hand, and Claude loads it by itself when it plans or splits work.

## 4. Tell your projects to use it

A skill is loaded when Claude judges it relevant; actively delegating is a working style, so say it where it is
always read — the project's `CLAUDE.md` (or `~/.claude/CLAUDE.md` for every project):

```markdown
## Delegating with Relay Bridge

Use the relay-bridge skill. Delegate well-defined work (implementation, tests, refactors, docs, configuration
analysis, reviews) to Gemini instead of doing all of it yourself; you own the architecture, the review and the
integration. Branches follow `flow/<type>/<nnn>-<description>` from an issue; agents may push their branch and open
draft pull requests to `dev`.
```

Replace the last sentence with the project's own conventions.

## 5. Optional: quick local usage stats (`!relay-stats`)

`npm run stats` prints local usage views (`summary`, `tasks`/`sessions`, `models`, `projects`, `daily`, `full`, or a
single `<task-id>`) straight from `~/.relay-bridge/tasks`, with composable time windows (`today`, `yesterday`, `24h`,
`7d`, `2w`, `--since YYYY-MM-DD`) and filters (`-m`/`--model`, `-s`/`--status`, `-e`/`--effort`, `--mode`,
`-p`/`--project`, `--sort`, `--limit`, `--json`). To run it from any Claude Code session with zero LLM tokens
(`!relay-stats`, `!relay-stats sessions 7d`, `!relay-stats projects --sort tokens`), symlink the built CLI into a
directory on your `PATH`, for example:

```bash
chmod +x ~/code/relay-bridge/dist/cli/stats.js
ln -sf ~/code/relay-bridge/dist/cli/stats.js ~/.local/bin/relay-stats
```

## Updating

```bash
cd ~/code/relay-bridge
git pull
npm install
npm run build
```

Running sessions keep the old server process until they restart; new sessions start the new build. Tasks in progress
are not affected — they are adopted by the next server instance.

## Removing

```bash
claude mcp remove relay-bridge --scope user
```

Task history and worktrees stay in `~/.relay-bridge` until you delete them (check for worktrees with uncommitted
work first: `git worktree list` in each repository).
