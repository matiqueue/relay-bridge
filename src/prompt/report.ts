import { z } from "zod";

/**
 * The report every delegated agent ends with. Antigravity enforces it with `--json-schema`, so the final answer
 * arrives as `structured_output`. Strings that do not apply are empty, never null: structured output is most
 * reliable with plain types. Relay Bridge compares the git-related fields with what it verifies itself.
 */
export const REPORT_JSON_SCHEMA = {
  type: "object",
  properties: {
    status: {
      type: "string",
      enum: ["completed", "partial", "blocked", "failed"],
      description:
        "completed: everything asked is done; partial: some of it; blocked: cannot continue without a decision or access; failed: could not do it",
    },
    summary: { type: "string", description: "Two to four sentences: what was done and the state it is in" },
    work_done: { type: "array", items: { type: "string" }, description: "What exactly was done, step by step" },
    files_changed: {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          change: { type: "string", enum: ["added", "modified", "deleted", "renamed"] },
          description: { type: "string" },
        },
        required: ["path", "change", "description"],
      },
    },
    branch: { type: "string", description: "The branch the work is on, empty for read-only tasks" },
    commits: {
      type: "array",
      items: {
        type: "object",
        properties: { sha: { type: "string" }, message: { type: "string" } },
        required: ["sha", "message"],
      },
    },
    pushed: { type: "boolean", description: "Whether the branch was pushed to the remote" },
    pull_request_url: { type: "string", description: "URL of the pull request you opened, empty if none" },
    tests: {
      type: "array",
      items: {
        type: "object",
        properties: {
          command: { type: "string" },
          outcome: { type: "string", enum: ["passed", "failed", "skipped", "not_run"] },
          details: { type: "string" },
        },
        required: ["command", "outcome", "details"],
      },
      description: "Every check you ran (tests, lint, typecheck, build) with its real outcome",
    },
    findings: {
      type: "array",
      items: { type: "string" },
      description: "For analysis and review tasks: the answers, findings or recommendations themselves",
    },
    known_issues: { type: "array", items: { type: "string" }, description: "Problems and limitations that remain" },
    review_checklist: {
      type: "array",
      items: { type: "string" },
      description: "What the lead should check before integrating this work",
    },
    blocker: { type: "string", description: "Why the task cannot continue, empty if not blocked" },
    needed_to_continue: { type: "string", description: "What is needed to continue, empty if nothing" },
    notes_for_lead: { type: "string", description: "Anything else the lead should know, empty if nothing" },
  },
  required: [
    "status",
    "summary",
    "work_done",
    "files_changed",
    "branch",
    "commits",
    "pushed",
    "pull_request_url",
    "tests",
    "findings",
    "known_issues",
    "review_checklist",
    "blocker",
    "needed_to_continue",
    "notes_for_lead",
  ],
} as const;

const text = z.string().catch("");
const list = z.array(z.string()).catch([]);

/** Lenient parsing: a missing or malformed field becomes empty rather than discarding the whole report. */
export const AgentReportSchema = z.object({
  status: z.enum(["completed", "partial", "blocked", "failed"]).catch("partial"),
  summary: text,
  work_done: list,
  files_changed: z
    .array(
      z.object({
        path: z.string(),
        change: z.enum(["added", "modified", "deleted", "renamed"]).catch("modified"),
        description: text,
      }),
    )
    .catch([]),
  branch: text,
  commits: z.array(z.object({ sha: z.string(), message: text })).catch([]),
  pushed: z.boolean().catch(false),
  pull_request_url: text,
  tests: z
    .array(
      z.object({
        command: z.string(),
        outcome: z.enum(["passed", "failed", "skipped", "not_run"]).catch("not_run"),
        details: text,
      }),
    )
    .catch([]),
  findings: list,
  known_issues: list,
  review_checklist: list,
  blocker: text,
  needed_to_continue: text,
  notes_for_lead: text,
});

export type AgentReport = z.infer<typeof AgentReportSchema>;

/** Reads the agent's report from structured output, or from a JSON response when the CLI returned it as text. */
export function parseReport(structuredOutput: unknown, response: string): AgentReport | undefined {
  const candidates: unknown[] = [structuredOutput];
  const trimmed = response.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)```$/.exec(trimmed);
  for (const textValue of [fenced?.[1], trimmed]) {
    if (!textValue) continue;
    try {
      candidates.push(JSON.parse(textValue));
    } catch {
      // not JSON
    }
  }
  for (const candidate of candidates) {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const parsed = AgentReportSchema.safeParse(candidate);
    if (parsed.success && (parsed.data.summary || parsed.data.work_done.length > 0)) return parsed.data;
  }
  return undefined;
}
