import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, type RelayConfig } from "../src/config.js";
import { AntigravityProvider } from "../src/providers/antigravity/provider.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { TaskManager, type DelegateRequest, type Logger } from "../src/tasks/manager.js";
import { TaskStore } from "../src/tasks/store.js";

export const FAKE_AGY = fileURLToPath(new URL("./fixtures/fake-agy.mjs", import.meta.url));

const cleanups: (() => void | Promise<void>)[] = [];

export async function cleanupAll(): Promise<void> {
  while (cleanups.length > 0) await cleanups.pop()?.();
}

export function tempDir(prefix = "rb-test-"): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** A real repository with one commit on `main` and a local identity. */
export function makeRepo(name = "repo"): string {
  const dir = path.join(tempDir(), name);
  execFileSync("mkdir", ["-p", dir]);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "user.email", "test@example.invalid");
  git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(path.join(dir, "README.md"), "# test repo\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

export const silentLogger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

export function testConfig(env: Record<string, string> = {}): RelayConfig {
  return loadConfig({
    RELAY_BRIDGE_HOME: path.join(tempDir("rb-home-"), "relay"),
    RELAY_BRIDGE_AGY_PATH: FAKE_AGY,
    RELAY_BRIDGE_POLL_MS: "50",
    RELAY_BRIDGE_KILL_GRACE_MS: "400",
    RELAY_BRIDGE_MAX_CONCURRENCY: "3",
    ...env,
  });
}

export interface Harness {
  readonly config: RelayConfig;
  readonly store: TaskStore;
  readonly providers: ProviderRegistry;
  readonly manager: TaskManager;
}

export async function harness(config = testConfig()): Promise<Harness> {
  const store = new TaskStore(config.tasksDir);
  const providers = new ProviderRegistry().register(new AntigravityProvider(config));
  const manager = new TaskManager(config, store, providers, silentLogger);
  await manager.start();
  cleanups.push(() => manager.stop());
  return { config, store, providers, manager };
}

export function request(
  overrides: Partial<DelegateRequest> & Pick<DelegateRequest, "workingDirectory">,
): DelegateRequest {
  return {
    provider: "antigravity",
    model: "neon",
    effort: "medium",
    task: "Add a small change to the repository and commit it. [[fake:commit]]",
    title: undefined,
    mode: "modify",
    isolation: undefined,
    branch: undefined,
    baseRef: undefined,
    referenceDirectories: [],
    commit: undefined,
    push: undefined,
    openPullRequest: undefined,
    pullRequestBase: undefined,
    timeoutMinutes: undefined,
    ...overrides,
  };
}

export async function waitUntil(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 15_000,
  what = "condition",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${what}`);
}
