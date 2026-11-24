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

`doctor` must show the Antigravity CLI signed in and both `neon` and `argon` available. If `agy` was never signed
in, run `agy` once in a terminal and sign in with your Google account first.

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

## 3. Tell your sessions how to use it

The server describes itself (instructions and tool descriptions are sent to Claude), but a project's working
conventions are yours to give: which tasks to delegate, which branch naming to use, whether agents may push. Put
them in the project's `CLAUDE.md`, or in your user-level `~/.claude/CLAUDE.md` for all projects.

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
