#!/usr/bin/env node
/**
 * A stand-in for the Antigravity CLI in tests. It speaks the same headless protocol (stream-json events on stdout,
 * diagnostics on stderr, the documented exit codes) and does real work in its working directory when asked: creating
 * files and git commits, so the task manager's verification runs against real repositories.
 *
 * The scenario comes from markers in the prompt, e.g. [[fake:commit]], [[fake:sleep:5]], [[fake:conv:missing]];
 * the last scenario marker wins (a revision's brief contains the original task and the new instructions).
 * FAKE_AGY_RECORD_DIR: every run writes its arguments there as <pid>.json.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The shape of a current account's `agy models` (1.5.16): Argon and the orchestrators are listed but never used
const MODELS = [
  ["gemini-4-neon-high", "Gemini 4 Neon (High)"],
  ["gemini-4-neon-xhigh", "Gemini 4 Neon (XHigh)"],
  ["gemini-4-neon-medium", "Gemini 4 Neon (Medium)"],
  ["gemini-4-neon-low", "Gemini 4 Neon (Low)"],
  ["gemini-3-neon-high", "Gemini 3 Neon (High)"],
  ["gemini-4-carbon-medium", "Gemini 4 Carbon (Medium)"],
  ["gemini-4-carbon-high", "Gemini 4 Carbon (High)"],
  ["gemini-4-carbon-low", "Gemini 4 Carbon (Low)"],
  ["gemini-4-argon-medium", "Gemini 4 Argon (Medium)"],
  ["gemini-4-argon-high", "Gemini 4 Argon (High)"],
  ["gemini-4-argon-low", "Gemini 4 Argon (Low)"],
  ["gemini-4-hydrogen-high", "Gemini 4 Hydrogen (High)"],
  ["gemini-4-hydrogen-xhigh", "Gemini 4 Hydrogen (XHigh)"],
  ["gemini-4-hydrogen-medium", "Gemini 4 Hydrogen (Medium)"],
  ["gemini-4-hydrogen-low", "Gemini 4 Hydrogen (Low)"],
  ["gemini-pro-orchestrator-neon", "Orchestrator (Neon)"],
  ["gemini-pro-orchestrator", "Orchestrator (Carbon)"],
  ["gemini-pro-orchestrator-argon", "Orchestrator (Argon)"],
  ["gemini-3.8-flash-high", "Gemini 3.8 Flash (High)"],
];

if (args[0] === "--version") {
  process.stdout.write("1.5.15-fake\n");
  process.exit(0);
}

if (args[0] === "models") {
  if (process.env.FAKE_AGY_MODELS_FAIL === "auth") {
    process.stderr.write("error: authentication required: run agy to sign in\n");
    process.exit(1);
  }
  process.stdout.write("Fetching available models...\n");
  for (const [id, label] of MODELS) {
    if (process.env.FAKE_AGY_NO_CARBON === "1" && id.includes("carbon")) continue;
    process.stdout.write(`${id}\t${label}\n`);
  }
  process.exit(0);
}

const prompt = flag("-p");
if (prompt === undefined) {
  process.stderr.write("fake-agy: only -p is supported\n");
  process.exit(2);
}

const model = flag("--model") ?? "gemini-4-neon-medium";

if (prompt === "/effort") {
  const available = /carbon|argon/.test(model) ? ["low", "medium", "high"] : ["low", "medium", "high", "xhigh"];
  const current = model.split("-").pop();
  emit({
    conversation_id: "",
    status: "SUCCESS",
    response: `${current}\n`,
    command: { name: "effort", data: { adjustable: true, current, available } },
  });
  process.exit(0);
}

if (process.env.FAKE_AGY_RECORD_DIR) {
  mkdirSync(process.env.FAKE_AGY_RECORD_DIR, { recursive: true });
  writeFileSync(
    path.join(process.env.FAKE_AGY_RECORD_DIR, `${process.pid}.json`),
    JSON.stringify({
      args,
      cwd: process.cwd(),
      env: { claude: Object.keys(process.env).filter((k) => k.startsWith("CLAUDE")) },
    }),
  );
}

// A continuation after a denied command: carry on (or end at a denial again with FAKE_AGY_ALWAYS_DENY=1)
const continuation = prompt.startsWith("Relay Bridge: your last turn ended");
const markers = [...prompt.matchAll(/\[\[fake:([a-z-]+)(?::([^\]]+))?\]\]/g)];
const scenarioMarkers = markers.filter((m) => m[1] !== "conv");
const scenario = continuation
  ? process.env.FAKE_AGY_ALWAYS_DENY === "1"
    ? "autodeny"
    : process.env.FAKE_AGY_ALWAYS_NOREPORT === "1"
      ? "noreport"
      : "continued"
  : (scenarioMarkers.at(-1)?.[1] ?? "commit");
const scenarioArg = scenarioMarkers.at(-1)?.[2];
const resume = flag("--conversation");
const conversationId =
  resume ?? (markers.some((m) => m[1] === "conv" && m[2] === "missing") ? `missing-${randomUUID()}` : randomUUID());

let step = 0;
const usage = { input_tokens: 1200, output_tokens: 80, thinking_tokens: 40, cache_read_tokens: 0, total_tokens: 1280 };
const result = (fields) => ({
  event: "result",
  result: { conversation_id: conversationId, num_turns: resume ? 2 : 1, duration_seconds: 0.4, usage, ...fields },
});
const tool = (name, parameters, output, error) =>
  emit({
    event: "step_update",
    step_update: {
      conversation_id: conversationId,
      step_index: step++,
      state: "DONE",
      step_type: "tool",
      tool_name: name,
      tool_info: { name, parameters, output, ...(error ? { error: { type: "permission", message: error } } : {}) },
    },
  });

if (resume?.startsWith("missing-")) {
  emit(result({ status: "ERROR", response: "", error: `conversation ${resume} not found` }));
  process.stderr.write(`error: conversation ${resume} not found\n`);
  process.exit(1);
}

emit({
  event: "init",
  conversation_id: conversationId,
  init: { model, cwd: process.cwd(), tools: ["run_command", "write_to_file"], permission_mode: "request-review" },
});
emit({
  event: "step_update",
  step_update: { conversation_id: conversationId, step_index: step++, state: "DONE", step_type: "user_input" },
});

const git = (gitArgs) => execFileSync("git", gitArgs, { cwd: process.cwd(), encoding: "utf8" }).trim();

const report = (fields) => ({
  status: "completed",
  summary: "Did the fake work.",
  work_done: ["Pretended to work"],
  files_changed: [],
  branch: "",
  commits: [],
  pushed: false,
  pull_request_url: "",
  tests: [{ command: "npm test", outcome: "not_run", details: "fake" }],
  findings: [],
  known_issues: [],
  review_checklist: ["Check the fake file"],
  blocker: "",
  needed_to_continue: "",
  notes_for_lead: "",
  ...fields,
});

const succeed = (structured) => {
  emit({
    event: "step_update",
    step_update: {
      conversation_id: conversationId,
      step_index: step++,
      state: "ACTIVE",
      step_type: "agent_response",
      text_delta: "Working on ",
    },
  });
  emit({
    event: "step_update",
    step_update: {
      conversation_id: conversationId,
      step_index: step - 1,
      state: "DONE",
      step_type: "agent_response",
      text_delta: "it. Done.",
    },
  });
  emit(result({ status: "SUCCESS", response: `${JSON.stringify(structured)}\n`, structured_output: structured }));
  process.exit(0);
};

switch (scenario) {
  case "commit":
  case "liar": {
    const n = readdirSync(process.cwd()).filter((f) => f.startsWith("relay-fake-")).length + 1;
    const file = `relay-fake-${n}.txt`;
    writeFileSync(path.join(process.cwd(), file), `fake change ${n}\n`);
    tool("write_to_file", { TargetFile: path.join(process.cwd(), file) }, "created");
    git(["add", file]);
    git(["commit", "-q", "-m", `feat: add fake change ${n}`]);
    tool(
      "run_command",
      { CommandLine: `git add ${file} && git commit -m "feat: add fake change ${n}"` },
      "Command exited with code 0.",
    );
    const sha = git(["rev-parse", "HEAD"]);
    const branch = git(["branch", "--show-current"]);
    succeed(
      scenario === "liar"
        ? report({
            branch,
            commits: [{ sha: "deadbeefcafe1234", message: "feat: imaginary" }],
            pushed: true,
            files_changed: [{ path: "nowhere.txt", change: "added", description: "" }],
          })
        : report({
            branch,
            commits: [{ sha, message: `feat: add fake change ${n}` }],
            files_changed: [{ path: file, change: "added", description: "the fake file" }],
          }),
    );
    break;
  }
  case "write-repo": {
    // Read-only tasks: try to write into the repository named in the brief (the sandbox would stop the real agent)
    const repo = /The repository to work on is `([^`]+)`/.exec(prompt)?.[1];
    if (repo && existsSync(repo)) writeFileSync(path.join(repo, "sneaky.txt"), "written by a read-only task\n");
    succeed(report({ summary: "Tried to write.", findings: ["wrote sneaky.txt"] }));
    break;
  }
  case "analyze": {
    tool("view_file", { AbsolutePath: path.join(process.cwd(), "README.md") }, "# readme");
    tool("run_command", { CommandLine: "git log --oneline -5" }, "abc123 init");
    succeed(report({ summary: "Analysed the repository.", findings: ["It has a README.", `cwd=${process.cwd()}`] }));
    break;
  }
  case "denied": {
    tool(
      "run_command",
      { CommandLine: "git push --force origin x" },
      "",
      'permission check failed for command "git push --force origin x": Permission denied for command(git push --force origin x). Matches user-configured deny rule.',
    );
    succeed(report({ status: "blocked", summary: "A force push was denied.", blocker: "force push denied" }));
    break;
  }
  case "secret": {
    tool("run_command", { CommandLine: "cat config" }, "token=ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    succeed(report({ summary: "Printed ghp_abcdefghijklmnopqrstuvwxyz0123456789 by mistake." }));
    break;
  }
  case "autodeny": {
    // agy 1.5.15: a command needing approval in headless mode ends the turn with SUCCESS and no response
    tool(
      "run_command",
      { CommandLine: "touch /somewhere/file" },
      'permission check failed for command "touch /somewhere/file": user denied permission to run command:',
    );
    emit(result({ status: "SUCCESS", response: "" }));
    process.stderr.write(
      'jetski: no output produced — a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied.\n',
    );
    process.exit(0);
    break;
  }
  case "continued": {
    succeed(report({ summary: "Finished after the continuation.", known_issues: ["touch was denied"] }));
    break;
  }
  case "noreport": {
    emit(result({ status: "SUCCESS", response: "I did it, trust me.\n" }));
    process.exit(0);
    break;
  }
  case "fail": {
    emit(result({ status: "ERROR", response: "", error: "model request failed: quota exhausted" }));
    process.stderr.write("error: model request failed: quota exhausted\n");
    process.exit(1);
    break;
  }
  case "timeout": {
    emit(
      result({
        status: "ERROR",
        response: "partial",
        error: "print timeout after 1m with the turn still in progress; the response is partial",
        finished_reason: "print_timeout",
      }),
    );
    process.stderr.write('AGY_ERROR: {"status":"DEADLINE_EXCEEDED","reason":"print_timeout"}\n');
    process.exit(3);
    break;
  }
  case "waiting": {
    emit(result({ status: "WAITING", response: "Which database should I use?" }));
    process.exit(0);
    break;
  }
  case "sleep":
  case "stubborn": {
    const seconds = Number(scenarioArg ?? 30);
    if (scenario === "sleep") {
      process.on("SIGINT", () => {
        emit(result({ status: "ERROR", response: "", error: "interrupted", finished_reason: "interrupted" }));
        process.stderr.write("error: interrupted\n");
        process.exit(1);
      });
    } else {
      process.on("SIGINT", () => undefined);
    }
    tool("run_command", { CommandLine: "sleep" }, "");
    const until = Date.now() + seconds * 1000;
    while (Date.now() < until) await sleep(100);
    succeed(report({ summary: `Slept ${seconds}s.` }));
    break;
  }
  default:
    process.stderr.write(`fake-agy: unknown scenario ${scenario}\n`);
    process.exit(2);
}
