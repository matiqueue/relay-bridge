import { readFileSync } from "node:fs";

/**
 * The version of Relay Bridge, read from package.json (Release Please is the only writer of that field). Read once,
 * from the file next to src/ or dist/, so the MCP server reports the version it was built from.
 */
export const VERSION: string = (() => {
  const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
  const parsed = JSON.parse(raw) as { version?: unknown };
  if (typeof parsed.version !== "string") throw new Error("package.json has no version");
  return parsed.version;
})();
