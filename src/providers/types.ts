/**
 * The contract between the task manager and an agent provider. A provider knows how to discover its models, how to
 * start one delegated run as a detached process that writes its event stream to a file, and how to read that stream.
 * The task manager owns everything else: validation, worktrees, persistence, timeouts, verification.
 *
 * Only the Antigravity CLI implements it today; the boundary is here so another executor can be added as one more
 * implementation without touching the tools or the task manager.
 */

export const MODEL_ALIASES = ["neon", "argon"] as const;
export type ModelAlias = (typeof MODEL_ALIASES)[number];

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export type ExecutionMode = "read_only" | "modify";

export interface ModelVariant {
  /** The identifier the provider's CLI accepts, e.g. "gemini-4-neon-high". */
  readonly modelId: string;
  /** The provider's display name, e.g. "Gemini 4 Neon (High)". */
  readonly label: string;
  readonly effort: Effort;
}

export interface AliasResolution {
  readonly alias: ModelAlias;
  readonly available: boolean;
  /** Display name of the model family the alias resolved to, e.g. "Gemini 4 Neon". */
  readonly family: string | undefined;
  readonly variants: readonly ModelVariant[];
  /** Effort levels confirmed by the provider for this family (may be narrower than the variants list). */
  readonly efforts: readonly Effort[];
  /** Why the alias is unavailable, or a note about how efforts were determined. */
  readonly note: string | undefined;
}

export interface ProviderDescription {
  readonly provider: string;
  readonly displayName: string;
  readonly cliVersion: string | undefined;
  readonly aliases: Readonly<Record<ModelAlias, AliasResolution>>;
  /** Models the account has that Relay Bridge deliberately does not use (count and names, for transparency). */
  readonly otherModels: readonly string[];
  readonly checkedAt: string;
}

export interface ResolvedModel {
  readonly alias: ModelAlias;
  readonly modelId: string;
  readonly label: string;
  readonly effort: Effort;
}

/** Normalised events of a run's stream. */
export type ProviderEvent =
  | { readonly kind: "init"; readonly conversationId: string | undefined; readonly model: string | undefined }
  | {
      readonly kind: "step";
      readonly index: number;
      readonly done: boolean;
      readonly stepType: string;
      readonly toolName: string | undefined;
      readonly toolSummary: string | undefined;
      readonly toolError: string | undefined;
      readonly textDelta: string | undefined;
      readonly permissionDenied: string | undefined;
    }
  | {
      readonly kind: "result";
      readonly conversationId: string | undefined;
      readonly status: string;
      readonly response: string;
      readonly error: string | undefined;
      readonly finishedReason: string | undefined;
      readonly structuredOutput: unknown;
      readonly usage: TokenUsage | undefined;
      readonly durationSeconds: number | undefined;
    };

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly thinkingTokens: number;
  readonly totalTokens: number;
}

/** Everything a provider needs to start one run. Paths are absolute. */
export interface RunSpec {
  readonly taskId: string;
  /** The directory the agent runs in (a worktree, the repository itself, or an empty scratch directory). */
  readonly workspace: string;
  readonly brief: string;
  readonly reportSchemaPath: string;
  readonly model: ResolvedModel;
  readonly mode: ExecutionMode;
  readonly policy: AgentPolicy;
  readonly timeoutMinutes: number;
  readonly resumeConversationId: string | undefined;
  readonly eventsPath: string;
  readonly stderrPath: string;
}

/** Permission rules in the provider-neutral `action(target)` form Antigravity uses. */
export interface AgentPolicy {
  readonly allow: readonly string[];
  readonly deny: readonly string[];
}

export interface RunHandle {
  readonly pid: number;
  /** The command line without the brief (safe to store and show). */
  readonly displayCommand: readonly string[];
  readonly exited: Promise<{ readonly exitCode: number | null; readonly signal: NodeJS.Signals | null }>;
}

export interface AgentProvider {
  readonly id: string;
  readonly displayName: string;
  describe(options?: { readonly refresh?: boolean }): Promise<ProviderDescription>;
  /** Throws MODEL_UNAVAILABLE or EFFORT_UNSUPPORTED; never substitutes another model. */
  resolveModel(alias: ModelAlias, effort: Effort): Promise<ResolvedModel>;
  start(spec: RunSpec): Promise<RunHandle>;
  parseEventLine(line: string): ProviderEvent | undefined;
  /** A string that identifies the provider's process in `ps` output (used to detect PID reuse). */
  readonly processMarker: string;
}
