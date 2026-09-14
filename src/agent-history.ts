/** Durable, project-local transcript storage for subagents. */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

const SUBAGENTS_DIR = ".pi-subagents";
const TRANSCRIPTS_DIR = "agent-transcripts";
const MAX_HISTORY_BYTES = 20 * 1024 * 1024;

/**
 * Ensure project-local subagent artifacts are ignored by git.
 *
 * The rule is appended instead of rewriting the file. This preserves any
 * existing user-owned rules and makes concurrent callers harmless (duplicate
 * `*` rules are semantically equivalent).
 */
export function ensureSubagentsGitignore(cwd: string): string {
  const directory = join(cwd, SUBAGENTS_DIR);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, ".gitignore");
  let content = "";
  try {
    content = readFileSync(path, "utf8");
  } catch {
    // The append below also creates a missing file.
  }
  if (!content.split(/\r?\n/).some((line) => line.trim() === "*")) {
    const separator = content.length > 0 && !/[\r\n]$/.test(content) ? "\n" : "";
    appendFileSync(path, `${separator}*\n`, "utf8");
  }
  return path;
}

/** Return the durable transcript path for an agent. */
export function createAgentHistoryPath(cwd: string, agentId: string): string {
  ensureSubagentsGitignore(cwd);
  const directory = join(cwd, SUBAGENTS_DIR, TRANSCRIPTS_DIR);
  mkdirSync(directory, { recursive: true });
  const safeId = agentId.replace(/[^A-Za-z0-9._-]+/g, "-") || "agent";
  return join(directory, `${safeId}.jsonl`);
}

/** Return the project-relative path stored in the parent session record. */
export function agentHistoryLocator(cwd: string, historyPath: string): string {
  return relative(cwd, historyPath).split(sep).join("/");
}

/** Resolve only paths in this package's project-local transcript namespace. */
export function resolveAgentHistoryPath(cwd: string, locator: string): string | undefined {
  // Locators are persisted data, not arbitrary paths. Reject traversal syntax
  // before resolving so a path which normalizes back inside the namespace is
  // still not accepted as an unsafe locator.
  if (!locator || isAbsolute(locator) || locator.includes("\0") || locator.includes("\\")) return undefined;
  const segments = locator.split("/");
  if (segments.some((segment) => segment === ".." || segment === "")) return undefined;
  const root = resolve(cwd, SUBAGENTS_DIR, TRANSCRIPTS_DIR);
  const candidate = resolve(cwd, locator);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) return undefined;
  return candidate;
}

/** Return true only when a valid project-local transcript file exists. */
export function hasAgentHistory(cwd: string, locator: string | undefined): boolean {
  if (!locator) return false;
  const path = resolveAgentHistoryPath(cwd, locator);
  return path !== undefined && existsSync(path);
}

/**
 * Read persisted transcript entries into the message shape used by the live
 * conversation viewer. Malformed lines and unknown records are skipped so one
 * damaged entry cannot hide the rest of a history.
 */
export function readAgentHistory(cwd: string, locator: string): AgentSession["messages"] | undefined {
  const path = resolveAgentHistoryPath(cwd, locator);
  if (!path || !existsSync(path)) return undefined;

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  if (raw.length > MAX_HISTORY_BYTES) raw = raw.slice(0, MAX_HISTORY_BYTES);

  const messages: AgentSession["messages"] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const entry: unknown = JSON.parse(line);
      const message = (entry as { message?: unknown } | null)?.message;
      if (!message || typeof message !== "object") continue;
      const role = (message as { role?: unknown }).role;
      if (typeof role !== "string") continue;
      messages.push(message as AgentSession["messages"][number]);
    } catch {
      // Ignore malformed/truncated JSONL records.
    }
  }
  return messages.length > 0 ? messages : undefined;
}
