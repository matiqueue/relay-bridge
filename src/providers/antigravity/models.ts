import { EFFORTS, type AliasResolution, type Effort, type ModelAlias, type ModelVariant } from "../types.js";

/**
 * Model discovery for the Antigravity CLI. Nothing here hardcodes a model identifier: `agy models` lists the
 * account's models as "<id>\t<label>", and an alias is matched by the family name in both the id and the label
 * ("gemini-4-neon-high" / "Gemini 4 Neon (High)"). When the account has several generations of a family, the newest
 * one is used. Orchestrator variants ("Orchestrator (Neon)", "Orchestrator (Carbon)") are a different product (a
 * planner + executor pair) and are never matched; neither are families that are not an alias (Argon, Flash).
 */
export interface ListedModel {
  readonly id: string;
  readonly label: string;
}

export function parseModelList(stdout: string): ListedModel[] {
  const models: ListedModel[] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim() || /^fetching\b/i.test(line.trim())) continue;
    const tab = line.indexOf("\t");
    const [id, label] =
      tab >= 0
        ? [line.slice(0, tab).trim(), line.slice(tab + 1).trim()]
        : (line.trim().split(/\s{2,}/) as [string, string?]);
    if (!id || /\s/.test(id)) continue;
    models.push({ id, label: label?.trim() || id });
  }
  return models;
}

const EFFORT_BY_LABEL: Readonly<Record<string, Effort>> = {
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  "extra high": "xhigh",
  extra: "xhigh",
  max: "max",
};

interface Candidate extends ModelVariant {
  readonly version: number[];
  readonly familyLabel: string;
}

function parseCandidate(model: ListedModel, alias: ModelAlias): Candidate | undefined {
  const idMatch = new RegExp(`^gemini-(\\d+(?:\\.\\d+)*)-${alias}-(low|medium|high|xhigh|max)$`, "i").exec(model.id);
  const labelMatch = new RegExp(`^Gemini\\s+(\\d+(?:\\.\\d+)*)\\s+${alias}\\s*\\(([^)]+)\\)$`, "i").exec(model.label);
  if (!idMatch && !labelMatch) return undefined;
  const version = (idMatch?.[1] ?? labelMatch?.[1] ?? "0").split(".").map(Number);
  const effortText = (idMatch?.[2] ?? labelMatch?.[2] ?? "").toLowerCase();
  const effort = EFFORT_BY_LABEL[effortText];
  if (!effort) return undefined;
  const name = alias.charAt(0).toUpperCase() + alias.slice(1);
  return {
    modelId: model.id,
    label: model.label,
    effort,
    version,
    familyLabel: `Gemini ${version.join(".")} ${name}`,
  };
}

function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function effortRank(effort: Effort): number {
  return EFFORTS.indexOf(effort);
}

export function resolveAlias(models: readonly ListedModel[], alias: ModelAlias): AliasResolution {
  const candidates = models.map((model) => parseCandidate(model, alias)).filter((c): c is Candidate => c !== undefined);
  if (candidates.length === 0) {
    return {
      alias,
      available: false,
      family: undefined,
      variants: [],
      efforts: [],
      note: `No Gemini ${alias} model is available to the signed-in Antigravity account (agy models lists none).`,
    };
  }
  const newest = candidates.reduce((best, c) => (compareVersions(c.version, best.version) > 0 ? c : best));
  const family = candidates.filter((c) => compareVersions(c.version, newest.version) === 0);
  const byEffort = new Map<Effort, Candidate>();
  for (const c of family) if (!byEffort.has(c.effort)) byEffort.set(c.effort, c);
  const variants = [...byEffort.values()]
    .sort((a, b) => effortRank(a.effort) - effortRank(b.effort))
    .map(({ modelId, label, effort }) => ({ modelId, label, effort }));
  return {
    alias,
    available: true,
    family: newest.familyLabel,
    variants,
    efforts: variants.map((v) => v.effort),
    note: undefined,
  };
}

/** Models the account has that are neither alias, for transparency in list_available_models. */
export function otherModels(models: readonly ListedModel[], used: readonly AliasResolution[]): string[] {
  const usedIds = new Set(used.flatMap((r) => r.variants.map((v) => v.modelId)));
  return models.filter((m) => !usedIds.has(m.id)).map((m) => m.label);
}

/**
 * Parses `agy -p /effort --output-format json --model <id>`:
 * {"command":{"name":"effort","data":{"adjustable":true,"current":"high","available":["low","medium","high","xhigh"]}}}
 */
export function parseEffortProbe(stdout: string): { adjustable: boolean; available: Effort[] } | undefined {
  try {
    const parsed = JSON.parse(stdout.trim()) as {
      command?: { name?: string; data?: { adjustable?: unknown; available?: unknown } };
    };
    const data = parsed.command?.name === "effort" ? parsed.command.data : undefined;
    if (!data || !Array.isArray(data.available)) return undefined;
    const available = data.available.filter(
      (e): e is Effort => typeof e === "string" && (EFFORTS as readonly string[]).includes(e),
    );
    return { adjustable: data.adjustable === true, available };
  } catch {
    return undefined;
  }
}
