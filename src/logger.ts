import type { Logger } from "./tasks/manager.js";

/**
 * Diagnostics go to stderr: stdout carries the MCP protocol. Claude Code shows a server's stderr in its MCP logs.
 * RELAY_BRIDGE_LOG=quiet silences informational lines.
 */
export function stderrLogger(env: NodeJS.ProcessEnv = process.env): Logger {
  const quiet = env.RELAY_BRIDGE_LOG === "quiet";
  const write = (level: string, message: string) => process.stderr.write(`[relay-bridge] ${level} ${message}\n`);
  return {
    info: (message) => {
      if (!quiet) write("info", message);
    },
    warn: (message) => write("warn", message),
    error: (message) => write("error", message),
  };
}
