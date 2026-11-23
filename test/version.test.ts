import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/version.js";

describe("VERSION", () => {
  it("is the version Release Please tracks in its manifest", () => {
    const manifest = JSON.parse(readFileSync(new URL("../.release-please-manifest.json", import.meta.url), "utf8")) as
      Record<string, string> | undefined;
    expect(VERSION).toBe(manifest?.["."]);
  });

  it("is a SemVer version", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
  });
});
