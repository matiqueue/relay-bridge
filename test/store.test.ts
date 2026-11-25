import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newTaskId, isTaskId, TaskStore } from "../src/tasks/store.js";
import { emptyProgress, type TaskRecord } from "../src/tasks/types.js";
import { cleanupAll, tempDir } from "./helpers.js";

afterEach(cleanupAll);

function record(id: string, createdAt = new Date().toISOString()): TaskRecord {
  return {
    schemaVersion: 1,
    id,
    provider: "antigravity",
    model: { alias: "neon", id: "gemini-4-neon-medium", label: "Gemini 4 Neon (Medium)" },
    effort: "medium",
    title: "t",
    task: "task",
    mode: "read_only",
    isolation: "read_only",
    workingDirectory: "/w",
    workspace: "/w",
    referenceDirectories: [],
    git: undefined,
    timeoutMinutes: 5,
    createdAt,
    revisionOf: undefined,
    revisionNumber: 0,
    revisionInstructions: undefined,
    resumeConversationId: undefined,
    snapshotBefore: undefined,
    status: "queued",
    updatedAt: createdAt,
    startedAt: undefined,
    finishedAt: undefined,
    ownerPid: undefined,
    process: undefined,
    conversationId: undefined,
    cancelRequested: undefined,
    progress: emptyProgress(),
    outcome: undefined,
    report: undefined,
    verification: undefined,
    warnings: [],
  };
}

describe("task ids", () => {
  it("are dated, unique and validated", () => {
    const ids = new Set(Array.from({ length: 500 }, () => newTaskId(new Date("2026-11-23T10:00:00Z"))));
    expect(ids.size).toBe(500);
    for (const id of ids) expect(id).toMatch(/^rb-20261123-[a-z0-9]{6}$/);
    expect(isTaskId("../../etc")).toBe(false);
  });
});

describe("TaskStore", () => {
  it("persists records with owner-only permissions and lists them newest first", async () => {
    const store = new TaskStore(path.join(tempDir(), "tasks"));
    const older = record(newTaskId(), "2026-11-20T10:00:00.000Z");
    const newer = record(newTaskId(), "2026-11-23T10:00:00.000Z");
    await store.create(older);
    await store.create(newer);
    expect((await store.list()).map((r) => r.id)).toEqual([newer.id, older.id]);
    expect(statSync(store.paths(older.id).record).mode & 0o777).toBe(0o600);
    expect(statSync(store.paths(older.id).dir).mode & 0o777).toBe(0o700);
  });

  it("survives a restart: a new store over the same directory sees the same tasks", async () => {
    const dir = path.join(tempDir(), "tasks");
    const r = record(newTaskId());
    await new TaskStore(dir).create(r);
    expect((await new TaskStore(dir).get(r.id)).title).toBe("t");
  });

  it("serialises concurrent updates instead of losing them", async () => {
    const store = new TaskStore(path.join(tempDir(), "tasks"));
    const r = record(newTaskId());
    await store.create(r);
    await Promise.all(
      Array.from({ length: 25 }, (_, i) => store.update(r.id, (rec) => void rec.warnings.push(`w${i}`))),
    );
    expect((await store.get(r.id)).warnings).toHaveLength(25);
    expect(existsSync(`${store.paths(r.id).record}.tmp`)).toBe(false);
  });

  it("rejects ids that could escape the task directory", () => {
    const store = new TaskStore(path.join(tempDir(), "tasks"));
    expect(() => store.paths("../outside")).toThrow(/not a Relay Bridge task id/);
  });

  it("gives supervision to one live process and takes over a stale lock", async () => {
    const store = new TaskStore(path.join(tempDir(), "tasks"));
    const r = record(newTaskId());
    await store.create(r);

    const other = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"]);
    try {
      expect(await store.tryAcquire(r.id, other.pid)).toBe(true);
      expect(await store.tryAcquire(r.id)).toBe(false);
    } finally {
      other.kill("SIGKILL");
      await new Promise((resolve) => other.once("exit", resolve));
    }
    // Its holder is gone: the lock is stale
    expect(await store.tryAcquire(r.id)).toBe(true);
    expect(await store.lockHolder(r.id)).toBe(process.pid);
    await store.release(r.id);
    expect(await store.lockHolder(r.id)).toBeUndefined();
  });
});
