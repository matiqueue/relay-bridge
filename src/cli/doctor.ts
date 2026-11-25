#!/usr/bin/env node
import { accessSync, constants, mkdirSync } from "node:fs";
import { createApp } from "../app.js";
import { toRelayError } from "../errors.js";
import { runCommand } from "../util/process.js";
import { VERSION } from "../version.js";

/**
 * `npm run doctor`: checks everything Relay Bridge needs, the way the MCP server will see it — Node, git, the
 * Antigravity CLI and its sign-in, the Hydrogen, Neon and Carbon models and their effort levels, and the data directory.
 * Prints no secrets and no account details beyond what `agy models` lists.
 */
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };

function line(ok: boolean | "warn", label: string, detail: string): void {
  const mark = ok === "warn" ? "!" : ok ? "✓" : "✗";
  process.stdout.write(`${mark} ${label.padEnd(22)} ${detail}\n`);
}

async function main(): Promise<number> {
  let failures = 0;
  const app = createApp(process.env, quiet);
  process.stdout.write(`Relay Bridge ${VERSION} — doctor\n\n`);

  const major = Number(process.versions.node.split(".")[0]);
  line(major >= 22, "Node.js", process.versions.node + (major >= 22 ? "" : " (needs 22 or newer)"));
  if (major < 22) failures++;

  const git = await runCommand("git", ["--version"]).catch(() => undefined);
  line(git?.exitCode === 0, "git", git?.stdout.trim() ?? "not found");
  if (git?.exitCode !== 0) failures++;

  const gh = await runCommand("gh", ["--version"]).catch(() => undefined);
  line(
    gh?.exitCode === 0 ? true : "warn",
    "GitHub CLI (optional)",
    gh?.exitCode === 0 ? (gh.stdout.split("\n")[0] ?? "") : "not found: agents cannot open pull requests",
  );

  try {
    mkdirSync(app.config.home, { recursive: true, mode: 0o700 });
    accessSync(app.config.home, constants.W_OK);
    line(true, "Data directory", app.config.home);
  } catch {
    line(false, "Data directory", `${app.config.home} is not writable`);
    failures++;
  }

  for (const provider of app.providers.all()) {
    try {
      const description = await provider.describe({ refresh: true });
      line(true, provider.displayName, `CLI ${description.cliVersion ?? "(version unknown)"}, signed in`);
      for (const alias of Object.values(description.aliases)) {
        line(
          alias.available,
          `  ${alias.alias}`,
          alias.available
            ? `${alias.family ?? ""} — efforts: ${alias.efforts.join(", ")} (${alias.variants.map((v) => v.modelId).join(", ")})${alias.note ? ` — ${alias.note}` : ""}`
            : (alias.note ?? "unavailable"),
        );
        if (!alias.available) failures++;
      }
    } catch (error) {
      const relay = toRelayError(error);
      line(false, provider.displayName, `${relay.code}: ${relay.message}`);
      failures++;
    }
  }

  const tasks = await app.store.list();
  const active = tasks.filter((t) => t.status === "running" || t.status === "queued").length;
  line(true, "Task history", `${tasks.length} task(s), ${active} active`);

  process.stdout.write(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) failed.\n`);
  return failures === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
