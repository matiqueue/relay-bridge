#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createApp } from "./app.js";
import { stderrLogger } from "./logger.js";
import { createServer } from "./server.js";
import { VERSION } from "./version.js";

/**
 * The MCP server over stdio. Claude Code starts one per session; every instance shares the task directory, so a
 * task started in one session can be checked from another, and tasks keep running when a session ends.
 */
async function main(): Promise<void> {
  const log = stderrLogger();
  const app = createApp(process.env, log);
  await app.manager.start();
  const server = createServer(app.manager, app.store, app.providers);
  const transport = new StdioServerTransport();

  let closing = false;
  const shutdown = async (why: string) => {
    if (closing) return;
    closing = true;
    log.info(`shutting down (${why}); running agents continue and are adopted by the next instance`);
    await app.manager.stop().catch(() => undefined);
    await server.close().catch(() => undefined);
    process.exit(0);
  };
  process.stdin.on("close", () => void shutdown("stdin closed"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await server.connect(transport);
  log.info(`relay-bridge ${VERSION} ready (data: ${app.config.home})`);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `[relay-bridge] fatal ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});
