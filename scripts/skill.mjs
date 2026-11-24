#!/usr/bin/env node
/**
 * Installs the Claude Code skill skills/relay-bridge as a personal skill: a symlink
 * ~/.claude/skills/relay-bridge -> <this clone>/skills/relay-bridge, so every Claude Code session on the machine can
 * load it and it updates with the clone (git pull). Claude Code follows symlinked skill folders.
 *
 *   npm run skill:install
 *   npm run skill:uninstall
 *
 * It never overwrites or deletes anything that is not that symlink. CLAUDE_SKILLS_DIR overrides the target folder.
 */
import { lstatSync, mkdirSync, readlinkSync, realpathSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const source = realpathSync(fileURLToPath(new URL("../skills/relay-bridge", import.meta.url)));
const skillsDir = process.env.CLAUDE_SKILLS_DIR || path.join(homedir(), ".claude", "skills");
const target = path.join(skillsDir, "relay-bridge");
const command = process.argv[2];

function current() {
  try {
    const stat = lstatSync(target);
    if (!stat.isSymbolicLink()) return { kind: "other" };
    const link = path.resolve(path.dirname(target), readlinkSync(target));
    return { kind: "link", ours: link === source, link };
  } catch (error) {
    if (error.code === "ENOENT") return { kind: "none" };
    throw error;
  }
}

const state = current();

if (command === "install") {
  if (state.kind === "link" && state.ours) {
    console.log(`Already installed: ${target} -> ${source}`);
  } else if (state.kind === "none") {
    mkdirSync(skillsDir, { recursive: true });
    symlinkSync(source, target, "dir");
    console.log(`Installed: ${target} -> ${source}`);
  } else {
    console.error(
      `${target} already exists and is not a link to this clone${state.kind === "link" ? ` (it points to ${state.link})` : ""}. Nothing was changed; move it away yourself to install.`,
    );
    process.exit(1);
  }
} else if (command === "uninstall") {
  if (state.kind === "link" && state.ours) {
    unlinkSync(target);
    console.log(`Removed: ${target}`);
  } else if (state.kind === "none") {
    console.log(`Not installed: ${target} does not exist.`);
  } else {
    console.error(`${target} is not this clone's link. Nothing was removed.`);
    process.exit(1);
  }
} else {
  console.error("Usage: node scripts/skill.mjs install|uninstall");
  process.exit(2);
}
