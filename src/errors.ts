/**
 * Errors the orchestrator can act on. Every tool failure carries one of these codes and a message written for the
 * orchestrator: what went wrong and what to do about it.
 */
export type RelayErrorCode =
  | "INVALID_INPUT"
  | "PATH_NOT_ALLOWED"
  | "NOT_A_GIT_REPOSITORY"
  | "DIRTY_WORKING_TREE"
  | "BRANCH_EXISTS"
  | "BRANCH_PROTECTED"
  | "PROVIDER_UNAVAILABLE"
  | "NOT_AUTHENTICATED"
  | "QUOTA_EXHAUSTED"
  | "MODEL_UNAVAILABLE"
  | "EFFORT_UNSUPPORTED"
  | "TASK_NOT_FOUND"
  | "TASK_NOT_FINISHED"
  | "TASK_ALREADY_FINISHED"
  | "WORKTREE_NOT_CLEAN"
  | "GIT_FAILED"
  | "INTERNAL";

export class RelayError extends Error {
  readonly code: RelayErrorCode;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(code: RelayErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "RelayError";
    this.code = code;
    this.details = details;
  }
}

export function toRelayError(error: unknown): RelayError {
  if (error instanceof RelayError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new RelayError("INTERNAL", message);
}

const QUOTA_ERROR_PATTERN =
  /\bquota\b|rate[ -]?limit|resource[ _-]?exhausted|usage[ -]?limit|too many requests|\b429\b/i;

export function isQuotaError(text: string | undefined): boolean {
  return Boolean(text && QUOTA_ERROR_PATTERN.test(text));
}
