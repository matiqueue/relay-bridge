# Security Policy

## Supported versions

Security fixes target the latest release on `prod`. Relay Bridge runs AI agents that read and change code on your
machine: a passing review or test suite does not guarantee that a delegated agent cannot do something you did not
intend. Read [docs/security.md](docs/security.md) for the trust model before you delegate work in a repository that
matters to you.

## Reporting a vulnerability

Please report exploitable vulnerabilities through a
[private security advisory](https://github.com/matiqueue/relay-bridge/security/advisories/new), not a public issue.
Include the version, a minimal reproduction with synthetic data, the impact and a suggested fix when you have one.
Never include live credentials, tokens or private repository contents in an issue or pull request.

We aim to acknowledge reports within a few days and to coordinate a fix before disclosure. General hardening ideas
and unverified risks can go into a 🔒 Security hardening issue, without exploit details.

## In scope

- An agent escaping the working directory, the worktree or the read-only mode Relay Bridge set up for it.
- A task text or repository content that makes Relay Bridge run a command, merge, delete or force-push something
  outside the delegated task's policy.
- Shell injection or path traversal through tool arguments (`working_directory`, `branch`, `reference_directories`).
- Secrets (tokens, keys, credentials) reaching task records, logs or tool results unredacted.
- Task records of one task being changed or read through another task's tools in a way that breaks the guarantees
  documented in `docs/security.md`.

## Out of scope

- What the delegated model itself decides to write inside the files of its own task: review its diff before you
  integrate it — that is the orchestrator's job by design.
- Behaviour of the Antigravity CLI, its sandbox or its permission engine; report those to Google.
- Attacks that require an already compromised user account on the machine.
