/** Durable checkpoints for agents that may be interrupted by a catchable lifecycle event. */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { ensureSubagentsGitignore } from "./agent-history.js";
import type {
  AgentInvocation,
  AgentOwnership,
  AgentRecoveryRuntimeIdentity,
  AgentRecoverySessionState,
  WorktreeResumeState,
} from "./types.js";
import type { LifetimeUsage } from "./usage.js";

const SUBAGENTS_DIR = ".pi-subagents";
const CHECKPOINTS_DIR = "agent-checkpoints";
const CHECKPOINT_VERSION = 2;
const TERMINAL_STATUSES = new Set(["completed", "steered", "stopped", "aborted", "error"] as const);
const THINKING_LEVELS = new Set(["minimal", "low", "medium", "high", "xhigh", "max", "off"]);

type ActiveStatus = "running" | "queued";
type TerminalStatus = "completed" | "steered" | "stopped" | "aborted" | "error";
export type AgentRecoveryStatus = ActiveStatus | TerminalStatus;

export interface AgentRecoveryCheckpointV1 {
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
  /** Owning agent for a nested child. Survives reload so the roster keeps its tree. */
  parentAgentId?: string;
  /** Nesting depth of a nested child; absent on top-level agents. */
  depth?: number;
  /** Session this record belongs to. */
  sessionId?: string;
}

export interface AgentRecoveryCheckpointV2 {
  version: 2;
  id: string;
  type: string;
  description: string;
  status: AgentRecoveryStatus;
  startedAt: number;
  completedAt?: number;
  result?: string;
  error?: string;
  resultConsumed?: boolean;
  toolCallId?: string;
  toolUses: number;
  lifetimeUsage: LifetimeUsage;
  compactionCount: number;
  transcriptPath?: string;
  invocation?: AgentInvocation;
  runtime: AgentRecoveryRuntimeIdentity;
  session: AgentRecoverySessionState;
  ownership: AgentOwnership;
  worktree?: WorktreeResumeState;
}

/** Valid checkpoints. V1 is intentionally display/history-only. */
export type AgentRecoveryCheckpoint = AgentRecoveryCheckpointV1 | AgentRecoveryCheckpointV2;

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

function isSafeAbsolutePath(value: unknown): value is string {
  return isSafeString(value, 4096) && isAbsolute(value);
}

function isSafePrivateLocator(value: unknown): value is string {
  return typeof value === "string"
    && /^\.pi-subagents\/agent-sessions\/[A-Za-z0-9_-]+\.jsonl$/.test(value)
    && !value.includes("..")
    && !value.includes("\\")
    && !value.includes("\0");
}

function isRuntimeIdentity(value: unknown): value is AgentRecoveryRuntimeIdentity {
  if (!value || typeof value !== "object") return false;
  const runtime = value as Record<string, unknown>;
  if (!Number.isInteger(runtime.depth) || (runtime.depth as number) < 0) return false;
  if (!Number.isInteger(runtime.maxSubagentDepth) || (runtime.maxSubagentDepth as number) < 0) return false;
  if ((runtime.maxSubagentDepth as number) < (runtime.depth as number)) return false;
  return runtime.rootSessionId === undefined || isSafeString(runtime.rootSessionId, 256);
}

function isSessionState(value: unknown): value is AgentRecoverySessionState {
  if (!value || typeof value !== "object") return false;
  const session = value as Record<string, unknown>;
  if (session.kind === "pending") return true;
  if (session.kind !== "memory" && session.kind !== "explicit" && session.kind !== "private") return false;
  if (!isSafeAbsolutePath(session.artifactRootCwd)
    || !isSafeAbsolutePath(session.resourceCwd)
    || !isSafeAbsolutePath(session.originalExecutionCwd)) return false;
  if (session.kind !== "private") return true;
  return isSafePrivateLocator(session.locator)
    && isSafeString(session.sessionId, 256)
    && isSafeString(session.provider, 256)
    && isSafeString(session.modelId, 512)
    && typeof session.thinking === "string"
    && THINKING_LEVELS.has(session.thinking);
}

function isOwnership(value: unknown): value is AgentOwnership {
  if (!value || typeof value !== "object") return false;
  const ownership = value as Record<string, unknown>;
  if (ownership.kind === "top-level") return true;
  if (ownership.kind === "nested") {
    return isSafeString(ownership.parentAgentId, 256)
      && Number.isInteger(ownership.depth)
      && (ownership.depth as number) >= 0;
  }
  if (ownership.kind === "workflow") {
    return isSafeString(ownership.workflowId, 256)
      && (ownership.depth === undefined || (Number.isInteger(ownership.depth) && (ownership.depth as number) >= 0));
  }
  return false;
}

function isSafeTargetSubdirectory(value: unknown): value is string {
  if (typeof value !== "string" || value.includes("\\") || value.includes("\0") || value.includes("\r") || value.includes("\n") || isAbsolute(value)) return false;
  if (!value) return true;
  const segments = value.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function isCommitSha(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value);
}

function isWorktreeResumeState(value: unknown): value is WorktreeResumeState {
  if (!value || typeof value !== "object") return false;
  const worktree = value as Record<string, unknown>;
  return isSafeAbsolutePath(worktree.repoRoot)
    && isCommitSha(worktree.baseCommitSha)
    && (worktree.savedCommitSha === undefined || isCommitSha(worktree.savedCommitSha))
    && isSafeTargetSubdirectory(worktree.originalTargetSubdirectory);
}

function isCommonCheckpoint(value: Record<string, unknown>): boolean {
  if (!isSafeString(value.id, 256)
    || !isSafeString(value.type, 256)
    || !isSafeString(value.description, 4096)
    || typeof value.status !== "string"
    || !isFiniteTimestamp(value.startedAt)
    || !Number.isInteger(value.toolUses)
    || (value.toolUses as number) < 0
    || !isUsage(value.lifetimeUsage)
    || !Number.isInteger(value.compactionCount)
    || (value.compactionCount as number) < 0) return false;

  const status = value.status as AgentRecoveryStatus;
  if (!isActiveStatus(status) && !isTerminalStatus(status)) return false;
  if (value.completedAt !== undefined && !isFiniteTimestamp(value.completedAt)) return false;
  if (isTerminalStatus(status)
    && (value.completedAt === undefined || value.completedAt < (value.startedAt as number))) return false;
  if (isActiveStatus(status) && value.completedAt !== undefined) return false;
  if (value.result !== undefined && !isSafeString(value.result, 2_000_000)) return false;
  if (value.error !== undefined && !isSafeString(value.error, 64_000)) return false;
  if (value.transcriptPath !== undefined && !isSafeTranscriptPath(value.transcriptPath)) return false;
  if (value.invocation !== undefined && !isInvocation(value.invocation)) return false;
  return true;
}

/** Strict v1 reader used only for display/history recovery. */
export function isAgentRecoveryCheckpointV1(value: unknown): value is AgentRecoveryCheckpointV1 {
  if (!value || typeof value !== "object") return false;
  const checkpoint = value as Record<string, unknown>;
  if (checkpoint.version !== 1 || !isCommonCheckpoint(checkpoint)) return false;
  if (checkpoint.parentAgentId !== undefined && !isSafeString(checkpoint.parentAgentId, 256)) return false;
  if (checkpoint.sessionId !== undefined && !isSafeString(checkpoint.sessionId, 256)) return false;
  return checkpoint.depth === undefined
    || (Number.isInteger(checkpoint.depth) && (checkpoint.depth as number) >= 0);
}

/** Validate the executable-capable v2 envelope without opening any session. */
export function isAgentRecoveryCheckpointV2(value: unknown): value is AgentRecoveryCheckpointV2 {
  if (!value || typeof value !== "object") return false;
  const checkpoint = value as Record<string, unknown>;
  if (checkpoint.version !== CHECKPOINT_VERSION || !isCommonCheckpoint(checkpoint)) return false;
  if (checkpoint.resultConsumed !== undefined && typeof checkpoint.resultConsumed !== "boolean") return false;
  if (checkpoint.toolCallId !== undefined && !isSafeString(checkpoint.toolCallId, 512)) return false;
  return isRuntimeIdentity(checkpoint.runtime)
    && isSessionState(checkpoint.session)
    && isOwnership(checkpoint.ownership)
    && (checkpoint.worktree === undefined || isWorktreeResumeState(checkpoint.worktree));
}

/** Validate either supported checkpoint version. Future/corrupt values fail closed. */
export function isAgentRecoveryCheckpoint(value: unknown): value is AgentRecoveryCheckpoint {
  return isAgentRecoveryCheckpointV1(value) || isAgentRecoveryCheckpointV2(value);
}

function checkpointDirectory(cwd: string): string {
  return join(cwd, SUBAGENTS_DIR, CHECKPOINTS_DIR);
}

/** Return the on-disk path for an agent's single deduplicated checkpoint. */
export function agentRecoveryCheckpointPath(cwd: string, agentId: string): string {
  const safeId = agentId.replace(/[^A-Za-z0-9._-]+/g, "-") || "agent";
  return join(checkpointDirectory(cwd), `${safeId}.json`);
}

/** Remove one checkpoint, retaining the historical best-effort behavior. */
export function removeAgentRecoveryCheckpoint(cwd: string, agentId: string): boolean {
  try {
    unlinkSync(agentRecoveryCheckpointPath(cwd, agentId));
    return true;
  } catch {
    return false;
  }
}

/**
 * Atomically write one checkpoint. Repeated writes for the same agent replace
 * the same file; identical payloads are skipped, so shutdown + abort callbacks
 * cannot create duplicate recovery records.
 */
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

/** Load valid checkpoints, ignoring orphan, malformed, and future files. */
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
      // Ignore a partially written/corrupt/future checkpoint and continue indexing.
    }
  }
  return [...latest.values()];
}
