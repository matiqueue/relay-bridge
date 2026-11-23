/**
 * Commit messages follow Conventional Commits (Release Please builds the changelog and the version from them).
 * The types match the issue labels and branch names:
 *
 *   label             branch              commit
 *   type: ✨ feature   flow/feature/...    feat
 *   type: 🐛 bugfix    flow/bugfix/...     fix
 *   type: ♻️ refactor  flow/refactor/...   refactor
 *   type: ⚡ perf      flow/perf/...       perf
 *   type: 🔧 chore     flow/chore/...      chore
 *   type: 📚 docs      flow/docs/...       docs
 *   type: 🧪 test      flow/test/...       test
 *   type: 🔒 security  flow/security/...   security
 *   type: 🔍 spike     flow/spike/...      spike
 *
 * Also `ci` (pipelines), `build` (packaging, dependencies) and `revert`.
 */
const TYPES = [
  "feat",
  "fix",
  "refactor",
  "perf",
  "chore",
  "docs",
  "test",
  "security",
  "spike",
  "ci",
  "build",
  "revert",
];

export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "type-enum": [2, "always", TYPES],
    "subject-case": [2, "never", ["upper-case", "pascal-case", "start-case"]],
    "subject-empty": [2, "never"],
    "subject-full-stop": [2, "never", "."],
    "header-max-length": [2, "always", 72],
    "body-max-line-length": [2, "always", 100],
    // Trailers such as Co-authored-by carry names and addresses longer than 100 characters
    "footer-max-line-length": [0],
  },
};
