import { describe, expect, it } from "vitest";
import { otherModels, parseEffortProbe, parseModelList, resolveAlias } from "../src/providers/antigravity/models.js";

// The format of `agy models` (1.5.15): a progress line, then "<id>\t<label>"
const LISTING = `Fetching available models...
gemini-4-neon-high\tGemini 4 Neon (High)
gemini-4-neon-xhigh\tGemini 4 Neon (XHigh)
gemini-4-neon-medium\tGemini 4 Neon (Medium)
gemini-4-neon-low\tGemini 4 Neon (Low)
gemini-4-carbon-medium\tGemini 4 Carbon (Medium)
gemini-4-argon-medium\tGemini 4 Argon (Medium)
gemini-4-argon-high\tGemini 4 Argon (High)
gemini-4-argon-low\tGemini 4 Argon (Low)
gemini-pro-orchestrator-neon\tOrchestrator (Neon)
gemini-pro-orchestrator-argon\tOrchestrator (Argon)
gemini-3.8-flash-high\tGemini 3.8 Flash (High)
claude-opus-5-5-high\tClaude Opus 5.5 (High)
`;

describe("parseModelList", () => {
  it("reads ids and labels and skips the progress line", () => {
    const models = parseModelList(LISTING);
    expect(models).toHaveLength(12);
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

  it("maps argon to the levels the account has", () => {
    expect(resolveAlias(models, "argon").efforts).toEqual(["low", "medium", "high"]);
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
    const withoutArgon = models.filter((m) => !m.id.includes("argon"));
    const argon = resolveAlias(withoutArgon, "argon");
    expect(argon.available).toBe(false);
    expect(argon.variants).toEqual([]);
    expect(argon.note).toMatch(/No Gemini argon model/);
  });

  it("lists the remaining models for transparency", () => {
    const used = [resolveAlias(models, "neon"), resolveAlias(models, "argon")];
    expect(otherModels(models, used)).toEqual([
      "Gemini 4 Carbon (Medium)",
      "Orchestrator (Neon)",
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
