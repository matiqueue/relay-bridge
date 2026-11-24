import { describe, expect, it } from "vitest";
import { redact, redactDeep, truncate } from "../src/security/redact.js";

describe("redact", () => {
  it.each([
    ["ghp_0123456789abcdefghijABCDEFGHIJ012345", "GITHUB"],
    ["github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz", "GITHUB"],
    ["AIzaSyA1234567890abcdefghijklmnopqrstuv", "GOOGLE API KEY"],
    ["ya29.a0AfH6SMBabcdefghijklmnopqrstuvwxyz", "GOOGLE OAUTH"],
    ["AKIAIOSFODNN7EXAMPLE", "AWS"],
    ["xoxb-123456789012-abcdefghijkl", "SLACK"],
    ["npm_abcdefghijklmnopqrstuvwxyz0123456789", "NPM"],
    ["sk-ant-api03-abcdefghijklmnopqrstuvwxyz", "API KEY"],
  ])("removes %s", (secret, kind) => {
    const out = redact(`value: ${secret} end`);
    expect(out).not.toContain(secret);
    expect(out).toContain(kind);
  });

  it("removes credentials in URLs, assignments, bearer headers and private keys", () => {
    expect(redact("https://user:hunter2secret@github.com/o/r.git")).toBe("https://user:[REDACTED]@github.com/o/r.git");
    expect(redact('API_KEY="abcdef123456" PASSWORD=supersecret')).toBe('API_KEY="[REDACTED]" PASSWORD=[REDACTED]');
    expect(redact("Authorization: Bearer abcdefghijklmnop1234567890")).toBe("Authorization: Bearer [REDACTED]");
    expect(redact("-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----")).toBe(
      "[REDACTED PRIVATE KEY]",
    );
  });

  it("leaves ordinary text, paths, commit hashes and short values alone", () => {
    const text = "Committed 723ccf9a1b2c3d4e5f60718293a4b5c6d7e8f901 in src/token-store.ts; npm run build; token=abc";
    expect(redact(text)).toBe(text);
  });

  it("redacts nested values", () => {
    expect(redactDeep({ a: ["ghp_0123456789abcdefghijABCDEFGHIJ012345"], n: 1 })).toEqual({
      a: ["[REDACTED GITHUB TOKEN]"],
      n: 1,
    });
  });
});

describe("truncate", () => {
  it("keeps short text and marks cut text", () => {
    expect(truncate("abc", 5)).toBe("abc");
    expect(truncate("abcdef", 4)).toBe("abc…");
  });
});
