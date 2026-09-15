/** Durable checkpoints for agents that may be interrupted by a catchable lifecycle event. */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureSubagentsGitignore } from "./agent-history.js";
import type { AgentInvocation } from "./types.js";
import type { LifetimeUsage } from "./usage.js";

const SUBAGENTS_DIR = ".pi-subagents";
const CHECKPOINTS_DIR = "agent-checkpoints";
const CHECKPOINT_VERSION = 1;
const TERMINAL_STATUSES = new Set(["completed", "steered", "stopped", "aborted", "error"] as const);
const THINKING_LEVELS = new Set(["minimal", "low", "medium", "high", "xhigh", "max", "off"]);

type ActiveStatus = "running" | "queued";
type TerminalStatus = "completed" | "steered" | "stopped" | "aborted" | "error";
export type AgentRecoveryStatus = ActiveStatus | TerminalStatus;

export interface AgentRecoveryCheckpoint {
  version: 1;
  id: string;
  type: string;
  description: string;
  status: AgentRecoveryStatus;
  startedAt: number;
  completedAt?: number;
  result?: string;
  error?: string;
  toolUses: number;
  lifetimeUsage: LifetimeUsage;
  compactionCount: number;
  transcriptPath?: string;
  invocation?: AgentInvocation;
}

function isSafeString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength && !/[\0\r\n]/.test(value);
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

function isUsage(value: unknown): value is LifetimeUsage {
  if (!value || typeof value !== "object") return false;
  const usage = value as Record<string, unknown>;
  return ["input", "output", "cacheWrite"].every((key) => {
    const n = usage[key];
    return typeof n === "number" && Number.isFinite(n) && n >= 0;
  });
}

function isInvocation(value: unknown): value is AgentInvocation {
  if (!value || typeof value !== "object") return false;
  const invocation = value as Record<string, unknown>;
  for (const key of ["modelName", "effectiveModelName"]) {
    if (invocation[key] !== undefined && !isSafeString(invocation[key], 512)) return false;
  }
  for (const key of ["thinking", "effectiveThinking"]) {
    if (invocation[key] !== undefined && (typeof invocation[key] !== "string" || !THINKING_LEVELS.has(invocation[key]))) return false;
  }
  if (invocation.maxTurns !== undefined && (!Number.isInteger(invocation.maxTurns) || (invocation.maxTurns as number) < 0)) return false;
  for (const key of ["isolated", "inheritContext", "runInBackground"]) {
    if (invocation[key] !== undefined && typeof invocation[key] !== "boolean") return false;
  }
  return invocation.isolation === undefined || invocation.isolation === "worktree";
}

function isActiveStatus(value: AgentRecoveryStatus): value is ActiveStatus {
  return value === "running" || value === "queued";
}

function isTerminalStatus(value: AgentRecoveryStatus): value is TerminalStatus {
  return TERMINAL_STATUSES.has(value as TerminalStatus);
}

function isSafeTranscriptPath(value: unknown): value is string {
  return typeof value === "string"
    && /^\.pi-subagents\/agent-transcripts\/[^/]+\.jsonl$/.test(value)
    && !value.includes("..")
    && !value.includes("\\")
    && !value.includes("\0");
}

/** Validate untrusted JSON before it can enter the manager or UI. */
export function isAgentRecoveryCheckpoint(value: unknown): value is AgentRecoveryCheckpoint {
  if (!value || typeof value !== "object") return false;
  const checkpoint = value as Record<string, unknown>;
  if (checkpoint.version !== CHECKPOINT_VERSION
    || !isSafeString(checkpoint.id, 256)
    || !isSafeString(checkpoint.type, 256)
    || !isSafeString(checkpoint.description, 4096)
    || typeof checkpoint.status !== "string"
    || !isFiniteTimestamp(checkpoint.startedAt)
    || !Number.isInteger(checkpoint.toolUses)
    || (checkpoint.toolUses as number) < 0
    || !isUsage(checkpoint.lifetimeUsage)
    || !Number.isInteger(checkpoint.compactionCount)
    || (checkpoint.compactionCount as number) < 0) return false;

  const status = checkpoint.status as AgentRecoveryStatus;
  if (!isActiveStatus(status) && !isTerminalStatus(status)) return false;
  if (checkpoint.completedAt !== undefined && !isFiniteTimestamp(checkpoint.completedAt)) return false;
  if (isTerminalStatus(status)
    && (checkpoint.completedAt === undefined || checkpoint.completedAt < checkpoint.startedAt)) return false;
  if (isActiveStatus(status) && checkpoint.completedAt !== undefined) return false;
  if (checkpoint.result !== undefined && !isSafeString(checkpoint.result, 2_000_000)) return false;
  if (checkpoint.error !== undefined && !isSafeString(checkpoint.error, 64_000)) return false;
  if (checkpoint.transcriptPath !== undefined && !isSafeTranscriptPath(checkpoint.transcriptPath)) return false;
  if (checkpoint.invocation !== undefined && !isInvocation(checkpoint.invocation)) return false;
  return true;
}

function checkpointDirectory(cwd: string): string {
  return join(cwd, SUBAGENTS_DIR, CHECKPOINTS_DIR);
}

/** Return the on-disk path for an agent's single deduplicated checkpoint. */
export function agentRecoveryCheckpointPath(cwd: string, agentId: string): string {
  const safeId = agentId.replace(/[^A-Za-z0-9._-]+/g, "-") || "agent";
  return join(checkpointDirectory(cwd), `${safeId}.json`);
}

/**
 * Atomically write one checkpoint. Repeated writes for the same agent replace
 * the same file; identical payloads are skipped, so shutdown + abort callbacks
 * cannot create duplicate recovery records.
 */
export function removeAgentRecoveryCheckpoint(cwd: string, agentId: string): boolean {
  try {
    unlinkSync(agentRecoveryCheckpointPath(cwd, agentId));
    return true;
  } catch {
    return false;
  }
}

export function writeAgentRecoveryCheckpoint(cwd: string, checkpoint: AgentRecoveryCheckpoint): boolean {
  if (!isAgentRecoveryCheckpoint(checkpoint)) return false;
  try {
    ensureSubagentsGitignore(cwd);
    const directory = checkpointDirectory(cwd);
    mkdirSync(directory, { recursive: true });
    const path = agentRecoveryCheckpointPath(cwd, checkpoint.id);
    const contents = `${JSON.stringify(checkpoint)}\n`;
    try {
      if (readFileSync(path, "utf8") === contents) return false;
    } catch {
      // The file is new, missing, or unreadable; replace it below.
    }
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, contents, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, path);
    return true;
  } catch {
    // Recovery must never make a spawn or shutdown fail. A later checkpoint
    // gets another chance to persist if the filesystem becomes available.
    return false;
  }
}

/** Load valid checkpoints, ignoring orphan, malformed, and corrupt files. */
export function readAgentRecoveryCheckpoints(cwd: string): AgentRecoveryCheckpoint[] {
  const directory = checkpointDirectory(cwd);
  if (!existsSync(directory)) return [];
  let names: string[];
  try {
    names = readdirSync(directory).filter((name) => /^[A-Za-z0-9._-]+\.json$/.test(name));
  } catch {
    return [];
  }

  const latest = new Map<string, AgentRecoveryCheckpoint>();
  for (const name of names) {
    try {
      const value: unknown = JSON.parse(readFileSync(join(directory, name), "utf8"));
      if (!isAgentRecoveryCheckpoint(value)) continue;
      latest.set(value.id, value);
    } catch {
      // Ignore a partially written/corrupt checkpoint and continue indexing.
    }
  }
  return [...latest.values()];
}
