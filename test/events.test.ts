import { describe, expect, it } from "vitest";
import { compactEventLine, parseAgyEventLine, summarizeTool } from "../src/providers/antigravity/events.js";

// Lines in the shape `agy --output-format stream-json` emits (abbreviated from a real run)
const INIT =
  '{"event":"init","conversation_id":"b487171f-af79-4f26-bf6d-de607eb9e971","init":{"model":"gemini-4-neon-low","cwd":"/work","tools":["run_command","write_file"],"permission_mode":"request-review"}}';
const TOOL =
  '{"event":"step_update","step_update":{"conversation_id":"b487","step_index":4,"state":"DONE","step_type":"tool","tool_name":"run_command","duration_seconds":3.0,"tool_info":{"name":"run_command","parameters":{"CommandLine":"git add hello.txt && git commit -m \\"test: add hello file\\""},"output":"Command exited with code 0."}}}';
const DENIED =
  '{"event":"step_update","step_update":{"step_index":5,"state":"DONE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"git reset --hard HEAD~1"},"error":{"type":"permission","message":"permission check failed for command \\"git reset --hard HEAD~1\\": Permission denied for command(git reset --hard HEAD~1). Matches user-configured deny rule."}}}}';
const DELTA =
  '{"event":"step_update","step_update":{"step_index":8,"state":"ACTIVE","step_type":"agent_response","text_delta":"Created hello"}}';
const RESULT =
  '{"event":"result","result":{"conversation_id":"b487","status":"SUCCESS","response":"{\\"status\\":\\"completed\\"}\\n","duration_seconds":37.08,"num_turns":1,"structured_output":{"status":"completed"},"usage":{"input_tokens":25770,"output_tokens":718,"thinking_tokens":339,"cache_read_tokens":50676,"total_tokens":26488}}}';
const INTERRUPTED =
  '{"event":"result","result":{"conversation_id":"3a4e","status":"ERROR","response":"","error":"interrupted","finished_reason":"interrupted","duration_seconds":7.38,"num_turns":1}}';

describe("parseAgyEventLine", () => {
  it("reads the conversation id and model from init", () => {
    expect(parseAgyEventLine(INIT)).toEqual({
      kind: "init",
      conversationId: "b487171f-af79-4f26-bf6d-de607eb9e971",
      model: "gemini-4-neon-low",
    });
  });

  it("summarises a tool step by the command it ran", () => {
    const event = parseAgyEventLine(TOOL);
    expect(event).toMatchObject({ kind: "step", index: 4, done: true, stepType: "tool", toolName: "run_command" });
    expect(event?.kind === "step" && event.toolSummary).toBe(
      'git add hello.txt && git commit -m "test: add hello file"',
    );
  });

  it("recognises a permission denial", () => {
    const event = parseAgyEventLine(DENIED);
    expect(event?.kind === "step" && event.permissionDenied).toMatch(
      /Permission denied for command\(git reset --hard HEAD~1\)/,
    );
    expect(event?.kind === "step" && event.toolError).toMatch(/deny rule/);
  });

  it("keeps streaming text deltas", () => {
    expect(parseAgyEventLine(DELTA)).toMatchObject({ kind: "step", done: false, textDelta: "Created hello" });
  });

  it("reads the result with structured output and usage", () => {
    expect(parseAgyEventLine(RESULT)).toMatchObject({
      kind: "result",
      status: "SUCCESS",
      structuredOutput: { status: "completed" },
      usage: { inputTokens: 25770, outputTokens: 718, thinkingTokens: 339, totalTokens: 26488 },
      durationSeconds: 37.08,
    });
    expect(parseAgyEventLine(INTERRUPTED)).toMatchObject({
      kind: "result",
      status: "ERROR",
      finishedReason: "interrupted",
      error: "interrupted",
    });
  });

  it("ignores unknown events and malformed lines", () => {
    expect(parseAgyEventLine('{"event":"future_thing","x":1}')).toBeUndefined();
    expect(parseAgyEventLine("warning: something")).toBeUndefined();
    expect(parseAgyEventLine('{"event":"step_update"')).toBeUndefined();
  });
});

describe("summarizeTool", () => {
  it("uses the file path for file tools and redacts secrets in commands", () => {
    expect(summarizeTool("write_to_file", { TargetFile: "/work/src/a.ts", CodeContent: "…" })).toBe("/work/src/a.ts");
    expect(
      summarizeTool("run_command", {
        CommandLine: "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456' x",
      }),
    ).toBe("curl -H 'Authorization: Bearer [REDACTED]' x");
  });
});

describe("compactEventLine", () => {
  it("drops streaming fragments and the tool list, keeps finished steps and the result", () => {
    expect(compactEventLine(DELTA)).toBeUndefined();
    expect(JSON.parse(compactEventLine(INIT) ?? "{}")).toEqual({
      event: "init",
      conversation_id: "b487171f-af79-4f26-bf6d-de607eb9e971",
      init: { model: "gemini-4-neon-low", cwd: "/work", permission_mode: "request-review" },
    });
    expect(compactEventLine(TOOL)).toContain("git add hello.txt");
    expect(compactEventLine(RESULT)).toContain('"status":"SUCCESS"');
  });

  it("cuts long tool output and redacts it", () => {
    const long = JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: 1,
        state: "DONE",
        step_type: "tool",
        tool_info: { name: "run_command", parameters: {}, output: `token=ghp_${"a".repeat(36)} ${"x".repeat(5000)}` },
      },
    });
    const compact = compactEventLine(long, 200) ?? "";
    expect(compact.length).toBeLessThan(600);
    expect(compact).not.toContain("ghp_");
  });
});
