import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { existsSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";
import { cleanupAll, harness } from "./helpers.js";

/**
 * The Claude Code skill (skills/relay-bridge) is documentation an orchestrator acts on: a tool or a parameter it names
 * that the server does not have is a bug. These tests read the skill and compare it with the live tool list.
 */
const dir = new URL("../skills/relay-bridge/", import.meta.url);
const skill = readFileSync(new URL("SKILL.md", dir), "utf8");
const reference = readFileSync(new URL("reference.md", dir), "utf8");
const READ_ONLY_TOOLS = ["list_available_models", "list_agent_tasks", "check_agent_status", "get_agent_result"];

function frontmatter(text: string): Record<string, string> {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match?.[1]) return {};
  const fields: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const field = /^([a-z_-]+):\s*(.*)$/.exec(line);
    if (field?.[1]) fields[field[1]] = field[2] ?? "";
  }
  return fields;
}

let tools: { name: string; properties: string[] }[] = [];

beforeAll(async () => {
  const h = await harness();
  const server = createServer(h.manager, h.store, h.providers);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "skill-test", version: "0.0.0" });
  await client.connect(clientSide);
  tools = (await client.listTools()).tools.map((t) => ({
    name: t.name,
    properties: Object.keys(t.inputSchema.properties ?? {}),
  }));
  await client.close();
});

afterAll(cleanupAll);

describe("the relay-bridge skill", () => {
  it("has the frontmatter Claude Code needs to list and trigger it", () => {
    const fields = frontmatter(skill);
    expect(fields.name).toBe("relay-bridge");
    expect(fields.description?.length).toBeGreaterThan(100);
    // Claude Code truncates description + when_to_use at 1,536 characters in the skill listing
    expect((fields.description ?? "").length + (fields.when_to_use ?? "").length).toBeLessThanOrEqual(1536);
    expect(fields.description).not.toMatch(/[<>]/);
  });

  it("pre-approves only the read-only tools", () => {
    const allowed = (frontmatter(skill)["allowed-tools"] ?? "").split(/[\s,]+/).filter(Boolean);
    expect(allowed.sort()).toEqual(READ_ONLY_TOOLS.map((t) => `mcp__relay-bridge__${t}`).sort());
  });

  it("names only tools the server has, and all of them", () => {
    const names = tools.map((t) => t.name);
    const referenced = [...`${skill}\n${reference}`.matchAll(/mcp__relay-bridge__([a-z_]+)/g)].map((m) => m[1]);
    for (const name of referenced) expect(names, `mcp__relay-bridge__${name}`).toContain(name);
    for (const name of names) expect(skill, name).toContain(name);
  });

  it("uses only parameters the tools accept in its examples", () => {
    const known = new Set(tools.flatMap((t) => t.properties));
    const examples = [
      ...[...reference.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1] ?? ""),
      ...[...`${skill}\n${reference}`.matchAll(/`(\{"[^`]*\})`/g)].map((m) => m[1] ?? ""),
    ];
    expect(examples.length).toBeGreaterThanOrEqual(6);
    for (const example of examples) {
      const parsed = JSON.parse(example.replaceAll("…", "x")) as Record<string, unknown>;
      for (const key of Object.keys(parsed)) expect(known, `${key} in ${example.slice(0, 60)}`).toContain(key);
    }
    const delegate = tools.find((t) => t.name === "delegate_task")?.properties ?? [];
    const table = [...reference.matchAll(/^\| `([a-z_]+)`\s*\|/gm)].map((m) => m[1]);
    for (const parameter of delegate) expect(table, parameter).toContain(parameter);
  });

  it("links files that exist", () => {
    for (const [, target] of `${skill}\n${reference}`.matchAll(/\]\(([^)#:]+\.md)\)/g)) {
      expect(existsSync(new URL(target ?? "", dir)), target).toBe(true);
    }
  });
});
