import type { ExecutionMode } from "../providers/types.js";

/**
 * The brief a delegated agent receives: who it works for, the task, where it works, the rules of engagement and how
 * to report. The task text is Claude's; everything around it is fixed by Relay Bridge, so every executor gets the same
 * contract whatever the orchestrator wrote.
 */
export interface BriefInput {
  readonly task: string;
  readonly mode: ExecutionMode;
  readonly workspace: string;
  readonly repository: string;
  readonly referenceDirectories: readonly string[];
  readonly git:
    | {
        readonly branch: string;
        readonly baseRef: string;
        readonly baseSha: string;
        readonly worktree: boolean;
        readonly allowCommit: boolean;
        readonly allowPush: boolean;
        readonly allowPullRequest: boolean;
        readonly pullRequestBase: string | undefined;
      }
    | undefined;
  readonly revision:
    | {
        readonly number: number;
        readonly instructions: string;
        readonly previousSummary: string;
        readonly previousReport: string;
        readonly verifiedFacts: string;
        readonly sameConversation: boolean;
      }
    | undefined;
}

function bullets(items: readonly string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

function gitRules(input: BriefInput): string[] {
  const g = input.git;
  if (!g) return [];
  const rules = [
    `Work only on the branch \`${g.branch}\` (created for this task from \`${g.baseRef}\`, ${g.baseSha.slice(0, 12)}). Do not check out, merge into, rebase onto or push to any other branch.`,
  ];
  if (g.allowCommit) {
    rules.push(
      "Commit your work in small, logical commits. Follow the repository's commit convention (look at `git log` and its contributing docs; use Conventional Commits if it has none). Never amend or rewrite commits that are already pushed.",
    );
  } else {
    rules.push("Do not commit. Leave your changes uncommitted in the workspace for the lead to review.");
  }
  if (g.allowCommit && g.allowPush) {
    rules.push(`When your commits are ready and the checks pass, push the branch: \`git push -u origin ${g.branch}\`.`);
  } else {
    rules.push("Do not push.");
  }
  if (g.allowCommit && g.allowPush && g.allowPullRequest) {
    rules.push(
      `After pushing, open a draft pull request with \`gh pr create --draft --base ${g.pullRequestBase ?? g.baseRef} --head ${g.branch}\`, a clear title and a description following the repository's pull request template if it has one. Never merge it.`,
    );
  } else {
    rules.push("Do not open a pull request.");
  }
  rules.push(
    "Never force-push, delete or rename branches or tags, run `git reset --hard` or `git clean`, or discard changes you did not make. These are blocked by policy anyway.",
  );
  return rules;
}

export function buildBrief(input: BriefInput): string {
  const readOnly = input.mode === "read_only";
  const where: string[] = [];
  if (readOnly) {
    where.push(
      `The repository to work on is \`${input.repository}\`. It is READ-ONLY for you: it is mounted read-only in your sandbox and file writes there are denied. Read it with absolute paths (for git: \`git -C ${input.repository} …\`).`,
      `Your current directory \`${input.workspace}\` is an empty scratch directory. Nothing you leave there is delivered: put everything the lead needs into your final report.`,
    );
  } else if (input.git?.worktree) {
    where.push(
      `Your workspace (current directory) is \`${input.workspace}\`: a git worktree of \`${input.repository}\` created for this task. Make all changes here, never in \`${input.repository}\` itself.`,
    );
  } else {
    where.push(`Your workspace (current directory) is \`${input.repository}\`. Make all changes here.`);
  }
  if (input.referenceDirectories.length > 0) {
    where.push(
      `Reference directories you may read but never modify: ${input.referenceDirectories.map((d) => `\`${d}\``).join(", ")}.`,
    );
  }

  const rules = [
    "Stay within the task. Make local implementation decisions yourself, but do not change the established architecture, public interfaces, project conventions or dependencies beyond what the task needs. If the task requires such a decision, stop and report it as a blocker with the exact question.",
    "Before you change anything, read the repository's own instructions when they exist (README, CONTRIBUTING.md, CLAUDE.md, AGENTS.md, GEMINI.md, docs/) and follow its code style and conventions.",
    readOnly
      ? "Do not try to modify any file. Your output is your report: findings, answers, proposed changes (as diffs or exact file contents in the report when the task asks for them)."
      : "Only touch files inside your workspace. Do not install global tools or change global or system configuration.",
    ...gitRules(input),
    readOnly
      ? "Run only read-only commands."
      : "Verify your work with the repository's existing checks that apply (tests, lint, type check, build: look at package.json scripts, a Makefile, the CI configuration). Fix the failures your change causes. If a check fails for reasons unrelated to your change, say so instead of changing unrelated code.",
    "Report honestly. Never claim a check passed unless you ran it and saw it pass; list every command you ran under `tests` with its real outcome. A clear `blocked` or `partial` report is better than a guess presented as done.",
    "Never print, copy or commit secrets (tokens, keys, passwords, .env contents).",
    "When something is unclear, investigate the code and docs first, then take safe, reversible steps. Escalate only decisions that are outside the task.",
    readOnly
      ? "Shell commands run in a sandbox where the repository is read-only, and only reading commands are allowed. A command denied by policy is a decision, not an obstacle: do not look for a workaround, report it."
      : "Shell commands run in a sandbox. Commands that need the network or the repository's shared .git directory (git commit, git push, gh, dependency installs) are pre-approved to run outside it: if one fails because of the sandbox, run it again with BypassSandbox. A command denied by policy is a decision, not an obstacle: do not look for a workaround, report it.",
  ];

  const sections = [
    "# Delegated task (Relay Bridge)",
    "You are a senior software engineer working as a delegated executor for Claude, the tech lead and orchestrator of this work. Claude owns the architecture and the integration and will review everything you deliver. Work autonomously until the task is done or you are genuinely blocked.",
  ];

  if (input.revision) {
    sections.push(
      `## Revision ${input.revision.number}`,
      input.revision.sameConversation
        ? "This continues your previous work on this task (same conversation). The lead reviewed it and asks for the changes below."
        : "This revises earlier work on this task by a previous run. The lead reviewed it and asks for the changes below.",
      "### Requested changes",
      input.revision.instructions,
      "### Previous result",
      input.revision.previousSummary,
      "### Facts verified by Relay Bridge after the previous run",
      input.revision.verifiedFacts,
      ...(input.revision.sameConversation
        ? []
        : ["### Previous report", "```json", input.revision.previousReport, "```"]),
      "Continue on the same branch with new commits.",
    );
  }

  sections.push(
    input.revision ? "## Original task" : "## Task",
    input.task,
    "## Where you work",
    bullets(where),
    "## Rules",
    bullets(rules),
    "## Final answer",
    "When you are done — or blocked — answer with the JSON report the output schema requires and nothing else. Use empty strings and empty lists for what does not apply. `findings` carries the substance of analysis and review tasks. `review_checklist` tells the lead what to verify before integrating.",
  );
  return sections.join("\n\n");
}
