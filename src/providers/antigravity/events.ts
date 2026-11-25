import { redact, redactDeep, truncate } from "../../security/redact.js";
import type { ProviderEvent, TokenUsage } from "../types.js";

/**
 * Reads one line of `agy --output-format stream-json` (documented at antigravity.google/docs/cli/headless):
 *   {"event":"init","conversation_id":"…","init":{"model":"…","cwd":"…","tools":[…],"permission_mode":"…"}}
 *   {"event":"step_update","step_update":{"step_index":4,"state":"DONE","step_type":"tool","tool_name":"run_command",
 *     "tool_info":{"name":"run_command","parameters":{"CommandLine":"…"},"output":"…","error":{…}}}}
 *   {"event":"result","result":{"conversation_id":"…","status":"SUCCESS","response":"…","error":"…",
 *     "finished_reason":"interrupted","structured_output":{…},"usage":{…},"duration_seconds":6.88}}
 * Unknown events and malformed lines return undefined: a newer CLI must not break an older Relay Bridge.
 */
type Json = Record<string, unknown>;

function obj(value: unknown): Json | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function usage(value: unknown): TokenUsage | undefined {
  const u = obj(value);
  if (!u) return undefined;
  return {
    inputTokens: num(u.input_tokens) ?? 0,
    outputTokens: num(u.output_tokens) ?? 0,
    thinkingTokens: num(u.thinking_tokens) ?? 0,
    totalTokens: num(u.total_tokens) ?? 0,
  };
}

const PATH_KEYS = [
  "Path",
  "path",
  "AbsolutePath",
  "TargetFile",
  "File",
  "file",
  "DirectoryPath",
  "SearchPath",
  "Url",
  "url",
];

/** A one-line, redacted description of a tool call: the command it ran or the file it touched. */
export function summarizeTool(name: string | undefined, parameters: unknown): string | undefined {
  const params = obj(parameters);
  if (!params) return name;
  const command = str(params.CommandLine) ?? str(params.command) ?? str(params.Command);
  if (command) return truncate(redact(command.replace(/\s+/g, " ").trim()), 200);
  for (const key of PATH_KEYS) {
    const value = str(params[key]);
    if (value) return truncate(redact(value), 200);
  }
  const query = str(params.Query) ?? str(params.query) ?? str(params.Pattern) ?? str(params.pattern);
  if (query) return truncate(redact(query), 120);
  return name;
}

const DENIAL = /permission (?:check failed|denied)[^\n]*|Matches user-configured deny rule[^\n]*|soft-denied[^\n]*/i;

function permissionDenial(...texts: (string | undefined)[]): string | undefined {
  for (const text of texts) {
    if (!text) continue;
    const match = DENIAL.exec(text);
    if (match) return truncate(redact(match[0]), 300);
  }
  return undefined;
}

export function parseAgyEventLine(line: string): ProviderEvent | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return undefined;
  let parsed: Json | undefined;
  try {
    parsed = obj(JSON.parse(trimmed));
  } catch {
    return undefined;
  }
  if (!parsed) return undefined;
  const event = str(parsed.event);

  if (event === "init") {
    const init = obj(parsed.init);
    return { kind: "init", conversationId: str(parsed.conversation_id), model: str(init?.model) };
  }

  if (event === "step_update") {
    const step = obj(parsed.step_update);
    if (!step) return undefined;
    const toolInfo = obj(step.tool_info);
    const toolName = str(step.tool_name) ?? str(toolInfo?.name);
    const errorObj = obj(toolInfo?.error);
    const toolError = str(errorObj?.message) ?? str(toolInfo?.error);
    const output = str(toolInfo?.output);
    return {
      kind: "step",
      index: num(step.step_index) ?? -1,
      done: str(step.state) === "DONE",
      stepType: str(step.step_type) ?? "unknown",
      toolName,
      toolSummary: toolInfo ? summarizeTool(toolName, toolInfo.parameters) : undefined,
      toolError: toolError ? truncate(redact(toolError), 500) : undefined,
      textDelta: str(step.text_delta),
      permissionDenied: toolInfo ? permissionDenial(toolError, output) : undefined,
    };
  }

  if (event === "result") {
    const result = obj(parsed.result);
    if (!result) return undefined;
    return {
      kind: "result",
      conversationId: str(result.conversation_id),
      status: str(result.status) ?? "UNKNOWN",
      response: str(result.response) ?? "",
      error: str(result.error),
      finishedReason: str(result.finished_reason),
      structuredOutput: result.structured_output,
      usage: usage(result.usage),
      durationSeconds: num(result.duration_seconds),
    };
  }
  return undefined;
}

function compactParameters(parameters: unknown, max: number): unknown {
  const clean = redactDeep(parameters ?? {});
  const text = JSON.stringify(clean);
  return text.length <= max ? clean : truncate(text, max);
}

/**
 * Shrinks a finished run's raw event log for long-term storage: drops streaming text fragments, keeps one line per
 * finished step with tool outputs cut to `maxOutput` characters, and redacts every string.
 */
export function compactEventLine(line: string, maxOutput = 2000): string | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return undefined;
  let parsed: Json | undefined;
  try {
    parsed = obj(JSON.parse(trimmed));
  } catch {
    return undefined;
  }
  if (!parsed) return undefined;
  if (parsed.event === "init") {
    const init = obj(parsed.init) ?? {};
    return JSON.stringify({
      event: "init",
      conversation_id: parsed.conversation_id,
      init: { ...init, tools: undefined },
    });
  }
  if (parsed.event === "step_update") {
    const step = obj(parsed.step_update);
    if (!step || step.state !== "DONE") return undefined;
    const toolInfo = obj(step.tool_info);
    const compactTool = toolInfo
      ? {
          name: toolInfo.name,
          parameters: compactParameters(toolInfo.parameters, maxOutput),
          output: typeof toolInfo.output === "string" ? truncate(redact(toolInfo.output), maxOutput) : undefined,
          error: toolInfo.error,
        }
      : undefined;
    return JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: step.step_index,
        step_type: step.step_type,
        tool_name: step.tool_name,
        duration_seconds: step.duration_seconds,
        tool_info: compactTool,
        text: typeof step.text_delta === "string" ? truncate(redact(step.text_delta), maxOutput) : undefined,
      },
    });
  }
  if (parsed.event === "result") return redact(trimmed);
  return undefined;
}
