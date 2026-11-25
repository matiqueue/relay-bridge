#!/usr/bin/env node
import { loadConfig } from "../config.js";
import { computeStats, formatStatsTable, formatTaskDetail, parseStatsArgs, STATS_HELP } from "../tasks/stats.js";
import { TaskStore } from "../tasks/store.js";
import { VERSION } from "../version.js";

/**
 * `relay-stats` / `npm run stats`: prints local usage views (model shares, sessions/tasks, projects, daily activity,
 * or a single task card) straight from `~/.relay-bridge/tasks` with zero LLM calls — useful both in a terminal and
 * inside Claude Code via `!relay-stats`.
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

  if (options.taskId) {
    const record = await store.get(options.taskId);
    if (options.json) {
      const stats = computeStats([record]);
      process.stdout.write(`${JSON.stringify(stats.tasks[0] ?? null, null, 2)}\n`);
    } else {
      process.stdout.write(formatTaskDetail(record, VERSION));
    }
    return 0;
  }

  const records = await store.list();
  const stats = computeStats(records, {
    window: options.window,
    filters: options.filters,
    sort: options.sort,
  });

  if (options.json) {
    process.stdout.write(`${JSON.stringify(stats, null, 2)}\n`);
  } else {
    process.stdout.write(formatStatsTable(stats, VERSION, options.view, options.limit));
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
