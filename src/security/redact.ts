/**
 * Removes secrets from text before it is stored in a task record, written to a compacted log or returned to the
 * orchestrator. Pattern based: it catches the token formats that commonly leak through command output (GitHub,
 * Google, AWS, Slack, npm, OpenAI/Anthropic style keys, JWTs, private keys, credentials in URLs and assignments).
 * It cannot recognise every secret; the agent's sandbox (which hides .env and ~/.ssh) is the first line of defence.
 */
const PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[REDACTED PRIVATE KEY]"],
  [/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[REDACTED GITHUB TOKEN]"],
  [/\bAIza[0-9A-Za-z_-]{30,}\b/g, "[REDACTED GOOGLE API KEY]"],
  [/\bya29\.[0-9A-Za-z_-]{20,}/g, "[REDACTED GOOGLE OAUTH TOKEN]"],
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, "[REDACTED AWS KEY ID]"],
  [/\bxox[abprs]-[0-9A-Za-z-]{10,}\b/g, "[REDACTED SLACK TOKEN]"],
  [/\bnpm_[A-Za-z0-9]{30,}\b/g, "[REDACTED NPM TOKEN]"],
  [/\bsk-(ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g, "[REDACTED API KEY]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[REDACTED JWT]"],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/g, "$1 [REDACTED]"],
  // https://user:password@host
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:)[^@\s/]+@/gi, "$1[REDACTED]@"],
  // password=..., api_key: "...", TOKEN=...
  [
    /\b([A-Za-z0-9_]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret)[A-Za-z0-9_]*)(\s*[:=]\s*)(["']?)[^\s"'&]{6,}\3/gi,
    "$1$2$3[REDACTED]$3",
  ],
];

export function redact(text: string): string {
  let result = text;
  for (const [pattern, replacement] of PATTERNS) result = result.replace(pattern, replacement);
  return result;
}

/** Redacts every string inside a JSON-like value. */
export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redact(value) as T;
  if (Array.isArray(value)) return value.map((item: unknown) => redactDeep(item)) as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = redactDeep(item);
    return out as T;
  }
  return value;
}

/** Shortens text for summaries, keeping the start. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}
