# Changelog

## [0.2.0](https://github.com/matiqueue/relay-bridge/compare/relay-bridge-v0.1.0...relay-bridge-v0.2.0) (2026-11-25)


### ⚠ BREAKING CHANGES

* **providers:** delegate_task and request_task_revision no longer accept model "argon". Use "carbon" for the work Argon did.

### Features

* add the relay-bridge skill for Claude Code ([450ef3e](https://github.com/matiqueue/relay-bridge/commit/450ef3e60f61520d918663448c504670c3fb5c2b))
* delegate repository tasks to Gemini through the Antigravity CLI ([205e0ee](https://github.com/matiqueue/relay-bridge/commit/205e0ee87829d42e5e0fb487a50938274581eae8))
* install the skill as a personal skill with npm run skill:install ([e745716](https://github.com/matiqueue/relay-bridge/commit/e74571613ad3a7edce1a1106efb31e29444c89b5))
* **providers:** replace argon with hydrogen and carbon aliases ([1c279f4](https://github.com/matiqueue/relay-bridge/commit/1c279f4c1469d2bca452756108a7d08189a882d3)), closes [#11](https://github.com/matiqueue/relay-bridge/issues/11)
* **tasks:** ask for a model when revising a retired-alias task ([2cb047d](https://github.com/matiqueue/relay-bridge/commit/2cb047df186ab274a755285608af6d763ba77ce6)), closes [#11](https://github.com/matiqueue/relay-bridge/issues/11)
* **tasks:** give every run its own directory for temporary files ([a85b857](https://github.com/matiqueue/relay-bridge/commit/a85b85700c50c2d6e3212d0b8c03ce8a8273877d))


### Bug Fixes

* **tasks:** resume a turn that ended at a command headless mode denied ([2375b57](https://github.com/matiqueue/relay-bridge/commit/2375b571d65a188cc5a0f00a75500ca7238f19a5))
* **tasks:** resume any run that ends without its report ([6c2903a](https://github.com/matiqueue/relay-bridge/commit/6c2903aaa4533f15960447510bd47feb806098a7))
