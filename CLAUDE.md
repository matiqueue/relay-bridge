# CLAUDE.md

Guidance for Claude Code (and other coding agents) working **on this repository**. For using Relay Bridge from
another project, read the README instead.

## Working on this repository (always)

Every change follows [CONTRIBUTING.md](CONTRIBUTING.md):

1. **Issue first**, written like the matching form in `.github/ISSUE_TEMPLATE/` (the body uses the form's
   `### <field label>` sections so `issue-automation.yml` can read it), with `type:`, `area:` and `prio:` labels.
2. **Branch** `flow/<type>/<nnn>-<description>` from an up-to-date `dev`, created with
   `gh issue develop <nnn> --base dev --name <branch>`. Never `claude/*` or other names outside the convention.
3. **Commits**: Conventional Commits (commitlint, header ≤ 72), small and logical; the husky hooks run lint-staged
   and the type check. Never `--no-verify` to get around a real failure.
4. **Pull request** to `dev` with the template, `Closes #<nnn>`, after `npm run check` passes on a clean tree (and
   `npm run test:integration` when the provider, the task runner or the agent policy changed). Merge commits, not
   squash. Never merge your own pull request unless the owner asks for it.
5. **Release**: a `dev -> prod` pull request; Release Please does the rest.

Never commit secrets, `.env` files, local paths of other projects or personal data (`.local/` is ignored for notes).

## Commands

```bash
npm install
npm run check              # format:check, typecheck (TypeScript 7), lint (typed ESLint), unit tests, build
npm run test               # unit tests only (Vitest); a stand-in CLI (test/fixtures/fake-agy.mjs) and real git repos
npm run test:integration   # real Antigravity CLI runs: needs a signed-in account, uses quota, takes minutes
npm run build              # dist/
npm run doctor             # checks agy, the account, Neon/Argon and the data directory
npm run skill:install      # links skills/relay-bridge into ~/.claude/skills (test/skill.test.ts keeps it in sync)
```

## Architecture (short)

`docs/architecture.md` has the full picture. The rules that matter when changing code:

- **stdout is the MCP protocol.** Never write to it from the server; diagnostics go through `src/logger.ts` (stderr).
- **No shell, ever.** Programs start through `runCommand`/`spawn` with argument arrays (`src/util/process.ts`).
- **No hardcoded model ids.** `neon`/`argon` are resolved from `agy models` (`src/providers/antigravity/models.ts`);
  never add a fallback to another model.
- **Policy regexes are RE2** (the CLI is a native binary): no lookahead, no backreferences. `test/policy.test.ts`
  checks the deny list against real command lines — extend it with every rule you add.
- **A finished record is written once**, with status, report and verification together (`finalize` in
  `src/tasks/manager.ts`): readers that see a finished status must see everything.
- Provider-specific code stays under `src/providers/<id>/`; the task manager and the tools are provider-neutral.
- **The skill is part of the contract.** A change to a tool's name, parameters or results updates
  `skills/relay-bridge/` in the same pull request; `test/skill.test.ts` fails on names the server does not have.
