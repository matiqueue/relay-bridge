import { describe, expect, it } from "vitest";
import { buildBrief, type BriefInput } from "../src/prompt/brief.js";
import { parseReport, REPORT_JSON_SCHEMA } from "../src/prompt/report.js";

const modify: BriefInput = {
  task: "Implement the CSV export described in docs/export.md.",
  mode: "modify",
  workspace: "/state/worktrees/app-rb-1",
  repository: "/work/app",
  referenceDirectories: ["/work/other"],
  temporaryDirectory: "/state/tasks/rb-1/tmp",
  git: {
    branch: "flow/feature/012-csv-export",
    baseRef: "dev",
    baseSha: "0123456789abcdef0123",
    worktree: true,
    allowCommit: true,
    allowPush: true,
    allowPullRequest: false,
    pullRequestBase: "dev",
  },
  revision: undefined,
};

describe("buildBrief", () => {
  it("states the task, the workspace, the branch and the git permissions", () => {
    const brief = buildBrief(modify);
    expect(brief).toContain("Implement the CSV export described in docs/export.md.");
    expect(brief).toContain("`/state/worktrees/app-rb-1`: a git worktree of `/work/app`");
    expect(brief).toContain("Work only on the branch `flow/feature/012-csv-export`");
    expect(brief).toContain("git push -u origin flow/feature/012-csv-export");
    expect(brief).toContain("Do not open a pull request.");
    expect(brief).toContain("`/work/other`");
    expect(brief).toMatch(/Never force-push/);
  });

  it("forbids pushing and committing when not allowed, and offers a draft PR when allowed", () => {
    const noPush = buildBrief({ ...modify, git: { ...modify.git!, allowPush: false } });
    expect(noPush).toContain("Do not push.");
    const noCommit = buildBrief({ ...modify, git: { ...modify.git!, allowCommit: false, allowPush: false } });
    expect(noCommit).toContain("Do not commit.");
    const pr = buildBrief({ ...modify, git: { ...modify.git!, allowPullRequest: true } });
    expect(pr).toContain("gh pr create --draft --base dev --head flow/feature/012-csv-export");
    expect(pr).toContain("--body-file");
    expect(pr).toContain("a file in `/state/tasks/rb-1/tmp`");
  });

  it("tells a read-only agent where the repository is and that its output is the report", () => {
    const brief = buildBrief({
      ...modify,
      mode: "read_only",
      workspace: "/state/tasks/rb-1/workspace",
      git: undefined,
    });
    expect(brief).toContain("READ-ONLY");
    expect(brief).toContain("git -C /work/app");
    expect(brief).toContain("Run only read-only commands.");
    expect(brief).not.toContain("git push");
  });

  it("puts a revision's instructions and the verified facts first", () => {
    const brief = buildBrief({
      ...modify,
      revision: {
        number: 2,
        instructions: "Rename the flag to --format.",
        previousSummary: "Added the export.",
        previousReport: '{"status":"completed"}',
        verifiedFacts: "Commits since base: abc feat: export.",
        sameConversation: false,
      },
    });
    expect(brief.indexOf("## Revision 2")).toBeLessThan(brief.indexOf("## Original task"));
    expect(brief).toContain("Rename the flag to --format.");
    expect(brief).toContain("Commits since base: abc feat: export.");
    expect(brief).toContain('{"status":"completed"}');
  });
});

describe("report", () => {
  const full = {
    status: "completed",
    summary: "Done.",
    work_done: ["a"],
    files_changed: [{ path: "a.ts", change: "added", description: "new" }],
    branch: "relay/x",
    commits: [{ sha: "abc1234", message: "feat: a" }],
    pushed: false,
    pull_request_url: "",
    tests: [{ command: "npm test", outcome: "passed", details: "12 passed" }],
    findings: [],
    known_issues: [],
    review_checklist: ["check a.ts"],
    blocker: "",
    needed_to_continue: "",
    notes_for_lead: "",
  };

  it("requires every field in the schema given to the agent", () => {
    expect([...REPORT_JSON_SCHEMA.required].sort()).toEqual(Object.keys(full).sort());
  });

  it("reads structured output", () => {
    expect(parseReport(full, "")).toEqual(full);
  });

  it("falls back to a JSON (or fenced JSON) response", () => {
    expect(parseReport(undefined, JSON.stringify(full))?.summary).toBe("Done.");
    expect(parseReport(undefined, `\`\`\`json\n${JSON.stringify(full)}\n\`\`\``)?.branch).toBe("relay/x");
  });

  it("keeps what is valid when fields are missing or wrong", () => {
    const partial = parseReport({ status: "weird", summary: "Half done.", tests: "nope" }, "");
    expect(partial).toMatchObject({ status: "partial", summary: "Half done.", tests: [], commits: [] });
  });

  it("returns nothing for free text", () => {
    expect(parseReport(undefined, "I did it.")).toBeUndefined();
  });
});
