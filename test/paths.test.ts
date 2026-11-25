import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { RelayError } from "../src/errors.js";
import { slugify, validateBranchName, validateDirectory } from "../src/security/paths.js";
import { cleanupAll, tempDir } from "./helpers.js";

afterEach(cleanupAll);

function config(extra: Record<string, string> = {}) {
  return loadConfig({ RELAY_BRIDGE_HOME: path.join(tempDir(), "home"), ...extra });
}

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return error instanceof RelayError ? error.code : "OTHER";
  }
}

describe("validateDirectory", () => {
  it("returns the canonical path of a project directory", () => {
    const dir = tempDir();
    const link = path.join(tempDir(), "link");
    symlinkSync(dir, link);
    expect(validateDirectory(link, "working_directory", config())).toBe(dir);
  });

  it("rejects relative, missing and non-directory paths", () => {
    const file = path.join(tempDir(), "file.txt");
    writeFileSync(file, "x");
    expect(codeOf(() => validateDirectory("relative/dir", "working_directory", config()))).toBe("INVALID_INPUT");
    expect(codeOf(() => validateDirectory("/definitely/not/here", "working_directory", config()))).toBe(
      "INVALID_INPUT",
    );
    expect(codeOf(() => validateDirectory(file, "working_directory", config()))).toBe("INVALID_INPUT");
    expect(codeOf(() => validateDirectory("/tmp/a\0b", "working_directory", config()))).toBe("INVALID_INPUT");
  });

  it("refuses roots, the home directory and system or credential locations", () => {
    const c = config();
    for (const denied of ["/", homedir(), "/usr", "/usr/bin", "/etc"]) {
      expect(
        codeOf(() => validateDirectory(denied, "working_directory", c)),
        denied,
      ).toBe("PATH_NOT_ALLOWED");
    }
  });

  it("refuses Relay Bridge's own state but allows its task worktrees", () => {
    const c = config();
    mkdirSync(path.join(c.tasksDir, "x"), { recursive: true });
    mkdirSync(path.join(c.worktreesDir, "repo-rb-1"), { recursive: true });
    expect(codeOf(() => validateDirectory(path.join(c.tasksDir, "x"), "working_directory", c))).toBe(
      "PATH_NOT_ALLOWED",
    );
    expect(validateDirectory(path.join(c.worktreesDir, "repo-rb-1"), "working_directory", c)).toContain("repo-rb-1");
  });

  it("enforces RELAY_BRIDGE_ALLOWED_ROOTS when set", () => {
    const allowed = tempDir();
    const inside = path.join(allowed, "project");
    mkdirSync(inside);
    const c = config({ RELAY_BRIDGE_ALLOWED_ROOTS: allowed });
    expect(validateDirectory(inside, "working_directory", c)).toBe(inside);
    expect(codeOf(() => validateDirectory(tempDir(), "working_directory", c))).toBe("PATH_NOT_ALLOWED");
  });
});

describe("validateBranchName", () => {
  it.each(["relay/rb-1-change", "flow/feature/012-progress-in-status", "fix_bug.2"])("accepts %s", (name) => {
    expect(validateBranchName(name)).toBe(name);
  });

  it.each(["-x", "a..b", "a//b", "feature/", "x.lock", "a b", "a;rm -rf /", "a@{1}", "feature/.hidden", ""])(
    "rejects %j",
    (name) => {
      expect(codeOf(() => validateBranchName(name))).toBe("INVALID_INPUT");
    },
  );

  it.each(["main", "master", "dev", "prod", "Main", "HEAD"])("protects %s", (name) => {
    expect(codeOf(() => validateBranchName(name))).toBe("BRANCH_PROTECTED");
  });
});

describe("slugify", () => {
  it("makes short ascii slugs", () => {
    expect(slugify("Dodaj obsługę żółwi! (PL)")).toBe("dodaj-obsluge-zolwi-pl");
    expect(slugify("   ")).toBe("task");
    expect(slugify("a".repeat(80), 10)).toBe("aaaaaaaaaa");
  });
});
