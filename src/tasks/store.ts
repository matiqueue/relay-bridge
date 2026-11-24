import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { RelayError } from "../errors.js";
import { isProcessAlive } from "../util/process.js";
import type { TaskRecord } from "./types.js";

/**
 * Local task history: one directory per task under <home>/tasks/<id>/ with
 *   task.json            the record (atomic writes: write a temporary file, then rename)
 *   events.ndjson        the agent's event stream (raw while running, compacted and redacted afterwards)
 *   stderr.log           the agent's diagnostics (redacted afterwards)
 *   brief.md             what the agent was asked
 *   report.schema.json   the report schema passed to the agent
 *   agent-settings.json  the run's permission policy
 *   owner.lock           which Relay Bridge process supervises the task
 *   workspace/           the empty scratch directory of read-only tasks
 *   tmp/                 temporary files of the agent (removed with the task directory)
 * Everything is created with owner-only permissions. Repositories are never copied here.
 */
export interface TaskPaths {
  readonly dir: string;
  readonly record: string;
  readonly events: string;
  readonly stderr: string;
  readonly brief: string;
  readonly schema: string;
  readonly lock: string;
  readonly scratch: string;
  /** Temporary files of the run (a pull request description…), writable by the agent's file tools. */
  readonly tmp: string;
}

const ID_PATTERN = /^rb-\d{8}-[a-z0-9]{6}$/;

export function newTaskId(now = new Date()): string {
  const date = now.toISOString().slice(0, 10).replaceAll("-", "");
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  const suffix = [...randomBytes(6)].map((byte) => alphabet[byte % alphabet.length]).join("");
  return `rb-${date}-${suffix}`;
}

export function isTaskId(value: string): boolean {
  return ID_PATTERN.test(value);
}

export class TaskStore {
  /** Serialises writes to one record within this process. */
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(private readonly root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
  }

  paths(id: string): TaskPaths {
    if (!isTaskId(id)) throw new RelayError("TASK_NOT_FOUND", `"${id}" is not a Relay Bridge task id.`);
    const dir = path.join(this.root, id);
    return {
      dir,
      record: path.join(dir, "task.json"),
      events: path.join(dir, "events.ndjson"),
      stderr: path.join(dir, "stderr.log"),
      brief: path.join(dir, "brief.md"),
      schema: path.join(dir, "report.schema.json"),
      lock: path.join(dir, "owner.lock"),
      scratch: path.join(dir, "workspace"),
      tmp: path.join(dir, "tmp"),
    };
  }

  async create(record: TaskRecord): Promise<TaskPaths> {
    const paths = this.paths(record.id);
    await mkdir(paths.dir, { recursive: false, mode: 0o700 });
    await this.write(record);
    return paths;
  }

  async get(id: string): Promise<TaskRecord> {
    const paths = this.paths(id);
    try {
      return JSON.parse(await readFile(paths.record, "utf8")) as TaskRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new RelayError("TASK_NOT_FOUND", `Task ${id} does not exist. list_agent_tasks shows the known tasks.`);
      }
      throw error;
    }
  }

  async list(): Promise<TaskRecord[]> {
    const entries = await readdir(this.root, { withFileTypes: true });
    const records = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && isTaskId(entry.name))
        .map(async (entry) => {
          try {
            return await this.get(entry.name);
          } catch {
            return undefined;
          }
        }),
    );
    return records
      .filter((record): record is TaskRecord => record !== undefined)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  private async write(record: TaskRecord): Promise<void> {
    const paths = this.paths(record.id);
    const tmp = `${paths.record}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, paths.record);
  }

  /** Reads the latest record, applies `mutate` and writes it back; writes to one task never interleave in-process. */
  update(id: string, mutate: (record: TaskRecord) => void): Promise<TaskRecord> {
    const previous = this.chains.get(id) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        const record = await this.get(id);
        mutate(record);
        record.updatedAt = new Date().toISOString();
        await this.write(record);
        return record;
      });
    this.chains.set(id, next);
    const forget = () => {
      if (this.chains.get(id) === next) this.chains.delete(id);
    };
    next.then(forget, forget);
    return next;
  }

  /**
   * Takes over supervision of a task. Succeeds when nobody holds the lock or its holder is no longer running, so
   * exactly one live Relay Bridge instance supervises each task even when several Claude Code sessions run at once.
   */
  async tryAcquire(id: string, pid = process.pid): Promise<boolean> {
    const { lock } = this.paths(id);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await open(lock, "wx", 0o600);
        await handle.writeFile(String(pid));
        await handle.close();
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const holder = Number.parseInt((await readFile(lock, "utf8").catch(() => "")).trim(), 10);
        if (holder === pid) return true;
        if (Number.isInteger(holder) && isProcessAlive(holder)) return false;
        // Stale: its holder exited. Remove it and try once more (another instance may win the race)
        await rm(lock, { force: true });
      }
    }
    return false;
  }

  async lockHolder(id: string): Promise<number | undefined> {
    const holder = Number.parseInt((await readFile(this.paths(id).lock, "utf8").catch(() => "")).trim(), 10);
    return Number.isInteger(holder) ? holder : undefined;
  }

  async release(id: string, pid = process.pid): Promise<void> {
    if ((await this.lockHolder(id)) === pid) await rm(this.paths(id).lock, { force: true });
  }
}
