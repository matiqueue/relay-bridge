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
npm run test               # unit tests only (Vitest)
npm run build              # dist/
```
