# Contributing to Relay Bridge

The whole flow of a change in one line:

```
issue  ->  branch flow/<type>/<number>-<description>  ->  PR to dev  ->  merge  ->  PR dev -> prod  ->  release
```

| Branch                     | What it is for                                                      |
| -------------------------- | ------------------------------------------------------------------- |
| `dev` (default)            | integration: task pull requests land here after green CI            |
| `prod`                     | what is released; changes only through a `dev -> prod` pull request |
| `flow/<type>/<nnn>-<desc>` | one task = one issue = one branch, always from an up-to-date `dev`  |

Release Please runs on `prod`: from the commits it builds a release pull request (version and changelog); merging
it tags the release. `sync-dev.yml` then opens a `prod -> dev` pull request, so `dev` gets the released version back
(a repository admin merges it with a merge commit: `dev` accepts changes only through pull requests).

## 1. Start with an issue

Not with code, not with a branch — with an issue. The branch name contains its number, and CI checks that the
number points at an existing issue.

Open it through a [form](https://github.com/matiqueue/relay-bridge/issues/new/choose). Blank issues are disabled;
there are seven forms:

| Form                     | When                                                |
| ------------------------ | --------------------------------------------------- |
| 🐛 Bug report            | something works incorrectly                         |
| ✨ Feature               | a new capability                                    |
| ♻️ Refactor / perf       | a better shape or speed of existing code            |
| 🔍 Spike / investigation | a time-boxed investigation that ends in a decision  |
| 🔧 Maintenance           | dependencies, configuration, build, tooling, tests  |
| 📚 Documentation         | missing, wrong or outdated docs                     |
| 🔒 Security hardening    | hardening — **not** for exploitable vulnerabilities |

> **An exploitable vulnerability does NOT go through an issue.** Use a
> [private advisory](https://github.com/matiqueue/relay-bridge/security/advisories/new) (see [SECURITY.md](SECURITY.md)).

After you submit, `.github/workflows/issue-automation.yml` applies the `area:` and `prio:` labels from the form,
removes `meta: ❓ needs triage` and stamps the title with the type and number:
`Status shows no progress` → `🐛 Bugfix: [009] Status shows no progress`.

## 2. Labels

The labels live in [`.github/labels.json`](.github/labels.json); `npm run labels` applies them to the repository.

**`type:` — what it is** (one per issue): `✨ feature` · `🐛 bugfix` · `♻️ refactor` · `⚡ perf` · `🔧 chore` ·
`📚 docs` · `🧪 test` · `🔒 security` · `🔍 spike`

**`area:` — what it touches** (several allowed):

| Area        | Covers                                                                   |
| ----------- | ------------------------------------------------------------------------ |
| `mcp`       | the MCP server, tool contracts, the stdio transport                      |
| `providers` | agent providers: the Antigravity CLI adapter, model and effort discovery |
| `tasks`     | task lifecycle, persistence, recovery after restarts, concurrency        |
| `git`       | repositories, worktrees, branches, commit and push facts                 |
| `policy`    | path validation, agent permissions, the sandbox, redaction               |
| `tooling`   | repository tooling, CI, release automation                               |

**`prio:` — how urgent**: `P0-critical` · `P1-high` · `P2-medium` · `P3-low`.

**`meta:` — where it is stuck**: `❓ needs triage` · `🚧 blocked` · `💬 needs discussion` · `💥 breaking change` ·
`🗑️ wontfix` · `♊ duplicate`.

## 3. Branch

```
flow/<type>/<number>-<short-description>
flow/feature/004-progress-in-status
flow/bugfix/012-cancel-leaves-orphan-process
```

- **Type**: `feature`, `bugfix`, `refactor`, `perf`, `chore`, `docs`, `security`, `spike`, `test`.
- **Number**: the number of an existing issue, padded with zeros to three digits (#9 → `009`).
- **Description**: English, lowercase, words joined with hyphens.

```bash
gh issue develop 4 --name "flow/feature/004-progress-in-status" --base dev
```

`pr-automation.yml` fails a pull request with another branch name or with a number that is not an existing issue.
The only exceptions are `dev`, `prod` and branches created by tools (`release-please--*`, `dependabot/*`).

## 4. Commit

[Conventional Commits](https://www.conventionalcommits.org/) — Release Please computes the version and writes the
changelog from them:

```
feat(tasks): resume a delegated conversation for revisions
fix(providers): report the available efforts when a level is missing
```

Types (`commitlint.config.mjs`): `feat`, `fix`, `refactor`, `perf`, `chore`, `docs`, `test`, `security`, `spike`,
`ci`, `build`, `revert`. Header up to 72 characters, no full stop. `feat!:` or a `BREAKING CHANGE:` footer bumps the
major version. Prefer small, logical commits over one large one.

## 5. Hooks (husky)

`npm install` installs them (`prepare`).

- **pre-commit**: lint-staged (ESLint with type information and Prettier on the staged files), then the type check
  of the whole project (`npm run typecheck`).
- **commit-msg**: commitlint.

| Message                                     | What to do                                                       |
| ------------------------------------------- | ---------------------------------------------------------------- |
| `husky - commit-msg script failed`          | fix the header: a type from the list, lowercase, ≤ 72 characters |
| `husky - pre-commit script failed` + ESLint | fix the reported places (warnings block too)                     |
| `husky - pre-commit script failed` + types  | `npm run typecheck` shows every error                            |

`git commit --no-verify` only when a hook itself is broken — CI checks the same things.

## 6. Pull request

- To `dev`, described with the template (`.github/pull_request_template.md`) and `Closes #<number>`.
- The title is the issue's: `<emoji> <Type>: [<nnn>] <description>`. Typing the description is enough —
  `pr-automation.yml` adds the type and number from the branch, applies the `type:` label, copies the issue's
  `area:`/`prio:` labels, assigns the author and adds `Closes #<nnn>` when it is missing.
- **Before you open it: `npm run check`** on a clean working tree — Prettier, types, lint, unit tests and the build.
  When you change the provider, the task runner or the agent policy, also run `npm run test:integration` against the
  real Antigravity CLI (it needs a signed-in account and uses model quota) and say in the template what it covered.
- CI (`ci.yml`) runs the same `npm run check` suite on every push to the pull request; it is a required check.
- Merge with a **merge commit** (not squash): it keeps the conventional commits for Release Please and keeps `dev`
  and `prod` from diverging.
- A release is a `dev -> prod` pull request listing the merged pull requests (titled `🚀 Release: dev → prod`).

`dev` and `prod` are protected by the rulesets in `.github/rulesets/` (no force push or deletion, pull requests with
green CI); `sh scripts/protect-branches.sh` applies them.

## 7. Versions and releases

SemVer `MAJOR.MINOR.PATCH`, computed from the commits by Release Please — versions are never edited by hand. The
single source of truth is `.release-please-manifest.json`; Release Please writes it into `package.json`.

| Commit                               | Before 1.0 (now)    | From 1.0   |
| ------------------------------------ | ------------------- | ---------- |
| `fix:`                               | patch (0.1.0→0.1.1) | patch      |
| `feat:`                              | patch               | minor      |
| `feat!:` / `BREAKING CHANGE:` footer | minor (0.1→0.2)     | major      |
| `chore:`, `docs:`, `ci:`, `test:` …  | no release          | no release |

## 8. Local setup

You need [Node.js](https://nodejs.org/) 22 or newer (`.nvmrc` pins 24), git and, for the integration tests, the
[Antigravity CLI](https://antigravity.google/docs/getting-started) signed in with a plan that includes the models
you test.

```bash
npm install
npm run check              # format, types, lint, unit tests, build
npm run test:integration   # real agy runs: quota, network, minutes
```

## 9. Secrets

The repository needs no secrets. Never commit tokens, `.env` files, local paths of other projects or personal data
— not in code, fixtures, docs or test snapshots. `.local/` is ignored for personal notes.
