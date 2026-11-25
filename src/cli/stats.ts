#!/usr/bin/env node
import { loadConfig } from "../config.js";
import { computeStats, formatStatsTable, parseStatsArgs, STATS_HELP } from "../tasks/stats.js";
import { TaskStore } from "../tasks/store.js";
import { VERSION } from "../version.js";

/**
 * `relay-stats` / `npm run stats`: prints a compact local usage summary (model shares, tokens, completion rate,
 * durations) straight from `~/.relay-bridge/tasks`. Runs locally with zero model calls — useful both in a terminal
 * and inside Claude Code via `!relay-stats`.
 */
async function main(): Promise<number> {
  let options;
  try {
    options = parseStatsArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  if (options.help) {
    process.stdout.write(STATS_HELP);
    return 0;
  }

  const config = loadConfig(process.env);
  const store = new TaskStore(config.tasksDir);
  const records = await store.list();
  const stats = computeStats(records, { window: options.window });

  if (options.json) {
    process.stdout.write(`${JSON.stringify(stats, null, 2)}\n`);
  } else {
    process.stdout.write(formatStatsTable(stats, VERSION));
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
