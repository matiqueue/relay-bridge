import { describe, expect, it } from "vitest";
import { otherModels, parseEffortProbe, parseModelList, resolveAlias } from "../src/providers/antigravity/models.js";
import { MODEL_ALIASES } from "../src/providers/types.js";

// The format of `agy models` (1.5.16): a progress line, then "<id>\t<label>", in the CLI's own order
const LISTING = `Fetching available models...
gemini-4-neon-high\tGemini 4 Neon (High)
gemini-4-neon-xhigh\tGemini 4 Neon (XHigh)
gemini-4-neon-medium\tGemini 4 Neon (Medium)
gemini-4-neon-low\tGemini 4 Neon (Low)
gemini-4-carbon-medium\tGemini 4 Carbon (Medium)
gemini-4-carbon-high\tGemini 4 Carbon (High)
gemini-4-carbon-low\tGemini 4 Carbon (Low)
gemini-4-argon-medium\tGemini 4 Argon (Medium)
gemini-4-argon-high\tGemini 4 Argon (High)
gemini-4-argon-low\tGemini 4 Argon (Low)
gemini-4-hydrogen-high\tGemini 4 Hydrogen (High)
gemini-4-hydrogen-xhigh\tGemini 4 Hydrogen (XHigh)
gemini-4-hydrogen-medium\tGemini 4 Hydrogen (Medium)
gemini-4-hydrogen-low\tGemini 4 Hydrogen (Low)
gemini-pro-orchestrator-neon\tOrchestrator (Neon)
gemini-pro-orchestrator\tOrchestrator (Carbon)
gemini-pro-orchestrator-argon\tOrchestrator (Argon)
gemini-3.8-flash-high\tGemini 3.8 Flash (High)
claude-opus-5-5-high\tClaude Opus 5.5 (High)
`;

describe("parseModelList", () => {
  it("reads ids and labels and skips the progress line", () => {
    const models = parseModelList(LISTING);
    expect(models).toHaveLength(19);
    expect(models[0]).toEqual({ id: "gemini-4-neon-high", label: "Gemini 4 Neon (High)" });
  });

  it("also reads space-aligned columns", () => {
    expect(parseModelList("gemini-4-neon-low            Gemini 4 Neon (Low)\n")).toEqual([
      { id: "gemini-4-neon-low", label: "Gemini 4 Neon (Low)" },
    ]);
  });
});

describe("resolveAlias", () => {
  const models = parseModelList(LISTING);

  it("maps neon to its variants ordered by effort, never to the orchestrator", () => {
    const neon = resolveAlias(models, "neon");
    expect(neon.available).toBe(true);
    expect(neon.family).toBe("Gemini 4 Neon");
    expect(neon.efforts).toEqual(["low", "medium", "high", "xhigh"]);
    expect(neon.variants.map((v) => v.modelId)).toEqual([
      "gemini-4-neon-low",
      "gemini-4-neon-medium",
      "gemini-4-neon-high",
      "gemini-4-neon-xhigh",
    ]);
    expect(neon.variants.some((v) => v.modelId.includes("orchestrator"))).toBe(false);
  });

  it("maps hydrogen and carbon to their own families and the levels the account has", () => {
    const hydrogen = resolveAlias(models, "hydrogen");
    expect(hydrogen.family).toBe("Gemini 4 Hydrogen");
    expect(hydrogen.efforts).toEqual(["low", "medium", "high", "xhigh"]);
    expect(hydrogen.variants.every((v) => v.modelId.startsWith("gemini-4-hydrogen-"))).toBe(true);
    const carbon = resolveAlias(models, "carbon");
    expect(carbon.family).toBe("Gemini 4 Carbon");
    expect(carbon.efforts).toEqual(["low", "medium", "high"]);
    expect(carbon.variants.map((v) => v.modelId)).toEqual([
      "gemini-4-carbon-low",
      "gemini-4-carbon-medium",
      "gemini-4-carbon-high",
    ]);
  });

  it("never maps an alias to Argon or to the Carbon orchestrator", () => {
    const ids = MODEL_ALIASES.flatMap((alias) => resolveAlias(models, alias).variants.map((v) => v.modelId));
    expect(ids.some((id) => id.includes("argon"))).toBe(false);
    expect(ids).not.toContain("gemini-pro-orchestrator");
  });

  it("uses the newest generation when several are listed", () => {
    const mixed = parseModelList(
      "gemini-4-neon-high\tGemini 4 Neon (High)\ngemini-5-neon-medium\tGemini 5 Neon (Medium)\n",
    );
    const neon = resolveAlias(mixed, "neon");
    expect(neon.family).toBe("Gemini 5 Neon");
    expect(neon.efforts).toEqual(["medium"]);
  });

  it("matches by label when the id format changes", () => {
    const renamed = parseModelList("neon-2027-preview\tGemini 4.5 Neon (High)\n");
    expect(resolveAlias(renamed, "neon").variants).toEqual([
      { modelId: "neon-2027-preview", label: "Gemini 4.5 Neon (High)", effort: "high" },
    ]);
  });

  it("reports an unavailable alias instead of substituting another model", () => {
    const withoutCarbon = models.filter((m) => !m.id.includes("carbon"));
    const carbon = resolveAlias(withoutCarbon, "carbon");
    expect(carbon.available).toBe(false);
    expect(carbon.variants).toEqual([]);
    expect(carbon.note).toMatch(/No Gemini carbon model/);
  });

  it("lists the remaining models for transparency", () => {
    const used = MODEL_ALIASES.map((alias) => resolveAlias(models, alias));
    expect(otherModels(models, used)).toEqual([
      "Gemini 4 Argon (Medium)",
      "Gemini 4 Argon (High)",
      "Gemini 4 Argon (Low)",
      "Orchestrator (Neon)",
      "Orchestrator (Carbon)",
      "Orchestrator (Argon)",
      "Gemini 3.8 Flash (High)",
      "Claude Opus 5.5 (High)",
    ]);
  });
});

describe("parseEffortProbe", () => {
  it("reads the levels from `agy -p /effort --output-format json`", () => {
    const out =
      '{"conversation_id":"","status":"SUCCESS","response":"high\\n","command":{"name":"effort","data":{"adjustable":true,"current":"high","available":["low","medium","high","xhigh"]}}}';
    expect(parseEffortProbe(out)).toEqual({ adjustable: true, available: ["low", "medium", "high", "xhigh"] });
  });

  it("ignores unknown levels and malformed output", () => {
    expect(
      parseEffortProbe('{"command":{"name":"effort","data":{"adjustable":true,"available":["low","turbo"]}}}'),
    ).toEqual({
      adjustable: true,
      available: ["low"],
    });
    expect(parseEffortProbe("not json")).toBeUndefined();
    expect(parseEffortProbe('{"command":{"name":"model"}}')).toBeUndefined();
  });
});
