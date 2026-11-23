#!/usr/bin/env node
/**
 * Creates or updates the repository labels from .github/labels.json through the GitHub CLI (`gh`, signed in with
 * write access to the repository). Labels that are not in the file are left alone; pass --prune to delete GitHub's
 * default labels that the taxonomy replaces (bug, enhancement, documentation…).
 *
 *   npm run labels                    # the repository of the current checkout
 *   npm run labels -- --repo owner/x  # another repository
 *   npm run labels -- --prune
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const repoIndex = args.indexOf("--repo");
const repo = repoIndex >= 0 ? args[repoIndex + 1] : undefined;
const prune = args.includes("--prune");
const repoArgs = repo ? ["--repo", repo] : [];

const wanted = JSON.parse(readFileSync(new URL("../.github/labels.json", import.meta.url), "utf8"));
const gh = (ghArgs) => execFileSync("gh", [...ghArgs, ...repoArgs], { encoding: "utf8" });

const existing = JSON.parse(gh(["label", "list", "--limit", "200", "--json", "name"])).map((l) => l.name);

for (const label of wanted) {
  gh(["label", "create", label.name, "--color", label.color, "--description", label.description, "--force"]);
  console.log(`${existing.includes(label.name) ? "updated" : "created"}  ${label.name}`);
}

const DEFAULTS = [
  "bug",
  "documentation",
  "duplicate",
  "enhancement",
  "good first issue",
  "help wanted",
  "invalid",
  "question",
  "wontfix",
];
if (prune) {
  for (const name of existing.filter((n) => DEFAULTS.includes(n))) {
    gh(["label", "delete", name, "--yes"]);
    console.log(`deleted  ${name}`);
  }
}
