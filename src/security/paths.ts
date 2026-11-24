import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { RelayConfig } from "../config.js";
import { RelayError } from "../errors.js";

/**
 * Directories an agent must never get as a workspace or a reference directory: the filesystem and home roots
 * (handing those over means the whole disk or the whole account), system locations, and the places that hold
 * credentials or the configuration of the agents themselves.
 */
function deniedExact(): string[] {
  const home = homedir();
  return [
    "/",
    home,
    "/Users",
    "/home",
    "/private",
    "/var",
    "/private/var",
    "/tmp",
    "/private/tmp",
    "/Volumes",
    "/opt",
    path.join(home, "Projects"),
    path.join(home, "Documents"),
    path.join(home, "Desktop"),
    path.join(home, "Downloads"),
  ];
}

function deniedPrefixes(config: RelayConfig): string[] {
  const home = homedir();
  return [
    "/System",
    "/Library",
    "/Applications",
    "/bin",
    "/sbin",
    "/usr",
    "/etc",
    "/private/etc",
    "/dev",
    "/cores",
    "/proc",
    "/sys",
    "/boot",
    "/root",
    path.join(home, "Library"),
    path.join(home, ".ssh"),
    path.join(home, ".gnupg"),
    path.join(home, ".aws"),
    path.join(home, ".azure"),
    path.join(home, ".kube"),
    path.join(home, ".docker"),
    path.join(home, ".config", "gcloud"),
    path.join(home, ".config", "gh"),
    path.join(home, ".gemini"),
    path.join(home, ".claude"),
    path.join(home, ".codex"),
    config.home,
  ];
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function canonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

export type DirectoryPurpose = "working_directory" | "reference_directory";

/**
 * Validates a directory an agent will work in or read, and returns its canonical (symlink-free) absolute path.
 * Rejects relative paths, missing or non-directory paths, the deny list above, and — when RELAY_BRIDGE_ALLOWED_ROOTS
 * is set — anything outside the allowed roots. Task worktrees inside Relay Bridge's own home are allowed, so a task
 * can be started on another task's worktree.
 */
export function validateDirectory(input: string, purpose: DirectoryPurpose, config: RelayConfig): string {
  if (typeof input !== "string" || input.trim() === "") {
    throw new RelayError("INVALID_INPUT", `${purpose} must be a non-empty absolute path.`);
  }
  if (input.includes("\0")) throw new RelayError("INVALID_INPUT", `${purpose} contains a NUL byte.`);
  if (!path.isAbsolute(input)) {
    throw new RelayError("INVALID_INPUT", `${purpose} must be an absolute path, got "${input}".`);
  }

  let resolved: string;
  try {
    resolved = realpathSync(input);
  } catch {
    throw new RelayError("INVALID_INPUT", `${purpose} "${input}" does not exist.`);
  }
  if (!statSync(resolved).isDirectory()) {
    throw new RelayError("INVALID_INPUT", `${purpose} "${input}" is not a directory.`);
  }

  const worktrees = canonical(config.worktreesDir);
  const insideOwnWorktree = isInside(resolved, worktrees) && resolved !== worktrees;

  const exact = deniedExact().map(canonical);
  if (exact.includes(resolved)) {
    throw new RelayError(
      "PATH_NOT_ALLOWED",
      `${purpose} "${input}" is too broad: pass the repository or project directory itself, not a root or a folder of projects.`,
    );
  }
  if (!insideOwnWorktree) {
    for (const prefix of deniedPrefixes(config).map(canonical)) {
      if (isInside(resolved, prefix)) {
        throw new RelayError(
          "PATH_NOT_ALLOWED",
          `${purpose} "${input}" is inside a protected location (${prefix}). Agents never work in system, credential or agent configuration directories.`,
        );
      }
    }
  }

  if (config.allowedRoots.length > 0 && !insideOwnWorktree) {
    const roots = config.allowedRoots.map(canonical);
    if (!roots.some((root) => isInside(resolved, root))) {
      throw new RelayError(
        "PATH_NOT_ALLOWED",
        `${purpose} "${input}" is outside RELAY_BRIDGE_ALLOWED_ROOTS (${roots.join(", ")}).`,
      );
    }
  }
  return resolved;
}

/** Branches an agent never works on directly, whatever the repository's conventions are. */
export const PROTECTED_BRANCHES: readonly string[] = [
  "main",
  "master",
  "dev",
  "develop",
  "development",
  "prod",
  "production",
  "trunk",
  "staging",
  "release",
  "HEAD",
];

const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._\-/]*$/;

/**
 * Validates a branch name for a delegated task: git's ref-format rules that matter here, no option-like or shell
 * meta characters (it is always passed as a separate argument anyway), and none of the protected integration
 * branches.
 */
export function validateBranchName(name: string): string {
  const branch = name.trim();
  const invalid = (why: string) => new RelayError("INVALID_INPUT", `Branch name "${name}" is invalid: ${why}.`);
  if (branch.length === 0 || branch.length > 200) throw invalid("it must have 1 to 200 characters");
  if (!BRANCH_PATTERN.test(branch)) throw invalid("use letters, digits, '.', '_', '-' and '/' only");
  if (branch.includes("..") || branch.includes("//") || branch.includes("@{"))
    throw invalid("it contains '..', '//' or '@{'");
  if (branch.endsWith("/") || branch.endsWith(".") || branch.endsWith(".lock")) {
    throw invalid("it ends with '/', '.' or '.lock'");
  }
  if (branch.split("/").some((part) => part.startsWith(".") || part === ""))
    throw invalid("a component starts with '.'");
  if (PROTECTED_BRANCHES.some((protectedName) => protectedName.toLowerCase() === branch.toLowerCase())) {
    throw new RelayError(
      "BRANCH_PROTECTED",
      `"${branch}" is an integration branch. Delegated agents work on their own task branch; integrate their work yourself.`,
    );
  }
  return branch;
}

/** A short, filesystem- and branch-safe slug of free text. */
export function slugify(text: string, maxLength = 40): string {
  const slug = text
    .replace(/[łŁ]/g, "l")
    .replace(/[đĐ]/g, "d")
    .replace(/[øØ]/g, "o")
    .replace(/ß/g, "ss")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
  return slug || "task";
}
