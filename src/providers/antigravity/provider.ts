import { spawn } from "node:child_process";
import { closeSync, openSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { RelayConfig } from "../../config.js";
import { RelayError } from "../../errors.js";
import { redact, truncate } from "../../security/redact.js";
import { runCommand } from "../../util/process.js";
import {
  MODEL_ALIASES,
  type AgentProvider,
  type AliasResolution,
  type Effort,
  type ModelAlias,
  type ProviderDescription,
  type ProviderEvent,
  type ResolvedModel,
  type RunHandle,
  type RunSpec,
} from "../types.js";
import { parseAgyEventLine } from "./events.js";
import { otherModels, parseEffortProbe, parseModelList, resolveAlias } from "./models.js";
import { buildSessionSettings } from "./policy.js";

const AUTH_HINT = /auth|sign[ -]?in|log[ -]?in|credential|unauthori[sz]ed|401/i;

/** Variables of the orchestrator's own environment that the delegated agent has no business seeing. */
const HIDDEN_ENV = /^(CLAUDE|ANTHROPIC_|RELAY_BRIDGE_|MCP_|npm_)/;

export function agentEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) if (!HIDDEN_ENV.test(key)) clean[key] = value;
  return clean;
}

/** The command line flags of one run (exported for tests). The brief and the settings file are given separately. */
export function buildRunArgs(spec: RunSpec, settingsPath: string): string[] {
  const args = [
    "-p",
    spec.brief,
    "--model",
    spec.model.modelId,
    "--output-format",
    "stream-json",
    "--json-schema",
    spec.reportSchemaPath,
    "--print-timeout",
    `${spec.timeoutMinutes}m`,
    "--settings",
    settingsPath,
    "--sandbox",
    "--disable-slash-commands",
  ];
  // Headless runs end their turn at any approval they cannot ask for: edits in the workspace are pre-approved
  args.push("--mode", "accept-edits");
  if (spec.resumeConversationId) args.push("--conversation", spec.resumeConversationId);
  return args;
}

export class AntigravityProvider implements AgentProvider {
  readonly id = "antigravity";
  readonly displayName = "Gemini via Google Antigravity CLI";
  readonly processMarker: string;
  private cache: { value: ProviderDescription; at: number } | undefined;
  private inflight: Promise<ProviderDescription> | undefined;

  constructor(private readonly config: RelayConfig) {
    this.processMarker = path.basename(config.agyPath);
  }

  private async agy(args: readonly string[], timeoutMs: number) {
    try {
      return await runCommand(this.config.agyPath, args, { timeoutMs, env: agentEnvironment() });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      throw new RelayError(
        "PROVIDER_UNAVAILABLE",
        code === "ENOENT"
          ? `The Antigravity CLI (${this.config.agyPath}) was not found. Install it (antigravity.google/docs/getting-started) or set RELAY_BRIDGE_AGY_PATH.`
          : `The Antigravity CLI could not be started: ${(error as Error).message}`,
      );
    }
  }

  async describe(options: { readonly refresh?: boolean } = {}): Promise<ProviderDescription> {
    const fresh = this.cache && Date.now() - this.cache.at < this.config.modelCacheTtlMs;
    if (fresh && !options.refresh && this.cache) return this.cache.value;
    this.inflight ??= this.discover().finally(() => {
      this.inflight = undefined;
    });
    const value = await this.inflight;
    this.cache = { value, at: Date.now() };
    return value;
  }

  private async discover(): Promise<ProviderDescription> {
    const versionResult = await this.agy(["--version"], 15_000);
    const cliVersion = versionResult.exitCode === 0 ? versionResult.stdout.trim().split("\n")[0] : undefined;

    const listed = await this.agy(["models"], 90_000);
    if (listed.exitCode !== 0) {
      const output = truncate(redact((listed.stderr || listed.stdout).trim()), 600);
      if (AUTH_HINT.test(output)) {
        throw new RelayError(
          "NOT_AUTHENTICATED",
          `The Antigravity CLI is not signed in. Run \`agy\` once in a terminal and sign in with your Google account. (${output})`,
        );
      }
      throw new RelayError("PROVIDER_UNAVAILABLE", `\`agy models\` failed (exit ${listed.exitCode}): ${output}`);
    }
    const models = parseModelList(listed.stdout);
    const resolutions = await Promise.all(
      MODEL_ALIASES.map((alias) => this.confirmEfforts(resolveAlias(models, alias))),
    );
    const aliases = Object.fromEntries(resolutions.map((r) => [r.alias, r])) as Record<ModelAlias, AliasResolution>;
    return {
      provider: this.id,
      displayName: this.displayName,
      cliVersion,
      aliases,
      otherModels: otherModels(models, resolutions),
      checkedAt: new Date().toISOString(),
    };
  }

  /**
   * Asks the CLI which effort levels the family really accepts (`agy -p /effort` answers locally, without a model
   * call) and keeps the levels that also have a variant id.
   */
  private async confirmEfforts(resolution: AliasResolution): Promise<AliasResolution> {
    const probeVariant = resolution.variants[0];
    if (!resolution.available || !probeVariant) return resolution;
    const probe = await this.agy(["-p", "/effort", "--output-format", "json", "--model", probeVariant.modelId], 30_000);
    const parsed = probe.exitCode === 0 ? parseEffortProbe(probe.stdout) : undefined;
    if (!parsed) {
      return {
        ...resolution,
        note: "Effort levels taken from the model list (the CLI's /effort probe gave no answer).",
      };
    }
    const confirmed = resolution.efforts.filter((effort) => parsed.available.includes(effort));
    const unlisted = parsed.available.filter((effort) => !resolution.efforts.includes(effort));
    return {
      ...resolution,
      efforts: confirmed,
      variants: resolution.variants.filter((v) => confirmed.includes(v.effort)),
      note:
        unlisted.length > 0
          ? `The CLI also reports ${unlisted.join(", ")} for this family, but no model id for it is listed; those levels are not offered.`
          : undefined,
    };
  }

  async resolveModel(alias: ModelAlias, effort: Effort): Promise<ResolvedModel> {
    const description = await this.describe();
    const resolution = description.aliases[alias];
    if (!resolution.available) {
      const available = MODEL_ALIASES.filter((a) => description.aliases[a].available);
      throw new RelayError(
        "MODEL_UNAVAILABLE",
        `${resolution.note ?? `Model "${alias}" is not available.`} Relay Bridge does not fall back to another model. Available aliases: ${available.join(", ") || "none"}.`,
        { alias, available },
      );
    }
    const variant = resolution.variants.find((v) => v.effort === effort);
    if (!variant) {
      throw new RelayError(
        "EFFORT_UNSUPPORTED",
        `${resolution.family ?? alias} does not support effort "${effort}". Supported: ${resolution.efforts.join(", ")}.`,
        { alias, effort, supported: resolution.efforts },
      );
    }
    return { alias, modelId: variant.modelId, label: variant.label, effort };
  }

  start(spec: RunSpec): Promise<RunHandle> {
    const settingsPath = path.join(path.dirname(spec.reportSchemaPath), "agent-settings.json");
    const settings = {
      ...buildSessionSettings(spec.mode, spec.policy),
      agentMode: "accept-edits",
    };
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });

    const args = buildRunArgs(spec, settingsPath);
    const out = openSync(spec.eventsPath, "a", 0o600);
    const err = openSync(spec.stderrPath, "a", 0o600);
    return new Promise((resolve, reject) => {
      let settled = false;
      try {
        const child = spawn(this.config.agyPath, args, {
          cwd: spec.workspace,
          env: agentEnvironment(),
          detached: true,
          shell: false,
          stdio: ["ignore", out, err],
        });
        const exited = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((done) => {
          child.once("exit", (exitCode, signal) => done({ exitCode, signal }));
        });
        child.once("error", (error) => {
          if (settled) return;
          settled = true;
          reject(
            new RelayError(
              "PROVIDER_UNAVAILABLE",
              (error as NodeJS.ErrnoException).code === "ENOENT"
                ? `The Antigravity CLI (${this.config.agyPath}) was not found.`
                : `The Antigravity CLI could not be started: ${error.message}`,
            ),
          );
        });
        child.once("spawn", () => {
          if (settled || child.pid === undefined) return;
          settled = true;
          // The run outlives this server: another Relay Bridge instance (or this one after a restart) adopts it
          child.unref();
          const displayCommand = [
            this.config.agyPath,
            ...args.map((arg, i) => (args[i - 1] === "-p" ? "<brief>" : arg)),
          ];
          resolve({ pid: child.pid, displayCommand, exited });
        });
      } catch (error) {
        settled = true;
        reject(error instanceof Error ? error : new Error(String(error)));
      } finally {
        closeSync(out);
        closeSync(err);
      }
    });
  }

  parseEventLine(line: string): ProviderEvent | undefined {
    return parseAgyEventLine(line);
  }
}
