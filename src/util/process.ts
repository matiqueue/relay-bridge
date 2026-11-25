import { spawn } from "node:child_process";

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
}

export interface CommandOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  /** Output beyond this many bytes per stream is dropped (the command keeps running). */
  readonly maxOutputBytes?: number;
}

/**
 * Runs a program with an argument array — never through a shell, so no argument is ever interpreted as shell syntax.
 * Resolves with the exit status instead of rejecting on a non-zero exit; rejects only when the program cannot start.
 */
export function runCommand(
  file: string,
  args: readonly string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  const maxBytes = options.maxOutputBytes ?? 8 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;

    child.stdout.on("data", (chunk: Buffer) => {
      if (outBytes < maxBytes) out.push(chunk);
      outBytes += chunk.length;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (errBytes < maxBytes) err.push(chunk);
      errBytes += chunk.length;
    });
    child.once("error", (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
      if (timer) clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        exitCode,
        signal,
        timedOut,
      });
    });

    if (options.timeoutMs !== undefined && child.pid !== undefined) {
      const pid = child.pid;
      timer = setTimeout(() => {
        timedOut = true;
        signalProcessGroup(pid, "SIGTERM");
        setTimeout(() => signalProcessGroup(pid, "SIGKILL"), 2000).unref();
      }, options.timeoutMs);
      timer.unref();
    }
  });
}

/** True when a process with this PID exists (EPERM means it exists but belongs to someone else). */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Sends a signal to a process group started with `detached: true` (the group ID is the leader's PID), so the agent's
 * own children — shells, test runners, dev servers — stop with it. Falls back to the single process.
 */
export function signalProcessGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

/** The command line of a live process (ps), used to tell a reused PID from the agent that had it. */
export async function processCommandLine(pid: number): Promise<string | undefined> {
  if (!isProcessAlive(pid)) return undefined;
  try {
    const result = await runCommand("ps", ["-o", "command=", "-p", String(pid)], { timeoutMs: 5000 });
    const line = result.stdout.trim();
    return line === "" ? undefined : line;
  } catch {
    return undefined;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
