import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";
import { cleanupAll, harness, makeRepo } from "./helpers.js";

afterEach(cleanupAll);

async function connect() {
  const h = await harness();
  const server = createServer(h.manager, h.store, h.providers);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientSide);
  return { client, ...h };
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const first = result.content[0];
  const text = first?.type === "text" ? first.text : "";
  // The tools answer with JSON text; the tests read it loosely, as an orchestrator would
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { isError: result.isError === true, body: JSON.parse(text) as Record<string, any> };
}

describe("MCP server", () => {
  it("exposes the delegation tools with input schemas and instructions", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "cancel_agent_task",
      "check_agent_status",
      "cleanup_task_worktree",
      "delegate_task",
      "get_agent_result",
      "list_agent_tasks",
      "list_available_models",
      "request_task_revision",
    ]);
    const delegate = tools.find((t) => t.name === "delegate_task");
    expect(delegate?.inputSchema.required).toEqual(
      expect.arrayContaining(["task", "working_directory", "execution_mode"]),
    );
    expect(client.getInstructions()).toMatch(/"hydrogen".*"neon" \(default\).*"carbon"/);
    expect(client.getInstructions()).not.toMatch(/argon/);
  });

  it("lists hydrogen, neon and carbon with their real ids and efforts", async () => {
    const { client } = await connect();
    const { body } = await call(client, "list_available_models");
    const models = body.providers[0].models as {
      alias: string;
      available: boolean;
      efforts: string[];
      variants: { model_id: string }[];
    }[];
    expect(models.map((m) => [m.alias, m.available, m.efforts])).toEqual([
      ["hydrogen", true, ["low", "medium", "high", "xhigh"]],
      ["neon", true, ["low", "medium", "high", "xhigh"]],
      ["carbon", true, ["low", "medium", "high"]],
    ]);
    expect(models[1]?.variants.map((v) => v.model_id)).toContain("gemini-4-neon-xhigh");
    expect(models.flatMap((m) => m.variants.map((v) => v.model_id)).some((id) => id.includes("argon"))).toBe(false);
    expect(Object.keys(body.guidance as object)).toEqual(["hydrogen", "neon", "carbon"]);
    expect(body.providers[0].other_models_on_account_not_used).toBeGreaterThan(0);
  });

  it("runs a delegated task from start to verified result", async () => {
    const { client } = await connect();
    const repo = makeRepo();
    const started = await call(client, "delegate_task", {
      model: "neon",
      effort: "low",
      task: "Add a fake change and commit it. [[fake:commit]]",
      working_directory: repo,
      execution_mode: "modify",
      branch: "relay/mcp-test",
    });
    expect(started.isError).toBe(false);
    const id = started.body.task_id as string;
    expect(started.body.status).toMatch(/running|queued/);

    const status = await call(client, "check_agent_status", { task_id: id, wait_seconds: 20 });
    expect(status.body.status).toBe("completed");
    expect(status.body.progress.tool_calls).toBeGreaterThan(0);

    const result = await call(client, "get_agent_result", { task_id: id, log_tail: 3 });
    expect(result.body.report.summary).toBe("Did the fake work.");
    expect(result.body.verified.branch).toBe("relay/mcp-test");
    expect(result.body.verified.commits).toHaveLength(1);
    expect(result.body.verified.new_commits_in_this_run).toBe(1);
    expect(result.body.verified.report_mismatches).toEqual([]);
    expect(result.body.log_tail).toHaveLength(3);

    const listed = await call(client, "list_agent_tasks", { status: ["completed"] });
    expect((listed.body.tasks as { task_id: string }[]).map((t) => t.task_id)).toContain(id);

    const revision = await call(client, "request_task_revision", {
      task_id: id,
      instructions: "One more change please. [[fake:commit]]",
    });
    expect(revision.body.revision_of).toBe(id);
    const revised = await call(client, "check_agent_status", { task_id: revision.body.task_id, wait_seconds: 20 });
    expect(revised.body.status).toBe("completed");

    const cleanup = await call(client, "cleanup_task_worktree", { task_id: revision.body.task_id });
    expect(cleanup.body.branch_kept).toBe("relay/mcp-test");
  });

  it("returns errors as tool errors with a code and an actionable message", async () => {
    const { client } = await connect();
    const unsupported = await call(client, "delegate_task", {
      model: "carbon",
      effort: "xhigh",
      task: "A task long enough to pass validation.",
      working_directory: makeRepo(),
      execution_mode: "modify",
    });
    expect(unsupported.isError).toBe(true);
    expect(unsupported.body.error).toBe("EFFORT_UNSUPPORTED");
    expect(unsupported.body.message).toMatch(/Supported: low, medium, high/);

    const missing = await call(client, "check_agent_status", { task_id: "rb-20260101-zzzzzz" });
    expect(missing.body.error).toBe("TASK_NOT_FOUND");

    const relative = await call(client, "delegate_task", {
      task: "A task long enough to pass validation.",
      working_directory: "relative/path",
      execution_mode: "read_only",
    });
    expect(relative.body.error).toBe("INVALID_INPUT");

    const quota = await call(client, "delegate_task", {
      task: "Trigger a quota exhaustion failure. [[fake:fail]]",
      working_directory: makeRepo(),
      execution_mode: "read_only",
    });
    const quotaStatus = await call(client, "check_agent_status", { task_id: quota.body.task_id, wait_seconds: 20 });
    expect(quotaStatus.body.status).toBe("failed");
    expect(quotaStatus.body.error_code).toBe("QUOTA_EXHAUSTED");
    expect(quotaStatus.body.next).toMatch(/Quota or rate limit was exhausted/);
    const quotaResult = await call(client, "get_agent_result", { task_id: quota.body.task_id });
    expect(quotaResult.body.outcome.error_code).toBe("QUOTA_EXHAUSTED");
  });

  it("no longer accepts the retired argon alias", async () => {
    const { client } = await connect();
    const result = (await client.callTool({
      name: "delegate_task",
      arguments: {
        model: "argon",
        task: "A task long enough to pass validation.",
        working_directory: makeRepo(),
        execution_mode: "read_only",
      },
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    const first = result.content[0];
    expect(first?.type === "text" ? first.text : "").toMatch(/hydrogen.*neon.*carbon/s);
  });

  it("cancels through the tool", async () => {
    const { client } = await connect();
    const started = await call(client, "delegate_task", {
      task: "Sleep for a long while. [[fake:sleep:30]]",
      working_directory: makeRepo(),
      execution_mode: "modify",
    });
    const cancelled = await call(client, "cancel_agent_task", { task_id: started.body.task_id });
    expect(cancelled.body.status).toBe("cancelled");
  });
});
