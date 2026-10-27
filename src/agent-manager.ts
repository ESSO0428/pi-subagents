/**
 * agent-manager.ts — Tracks agents, background execution, resume support.
 *
 * Background agents are subject to a configurable concurrency limit (default: 4).
 * Excess agents are queued and auto-started as running agents complete.
 * Foreground agents bypass the queue (they block the parent anyway).
 */

import { randomUUID } from "node:crypto";
import { existsSync, realpathSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { agentHistoryLocator, createAgentHistoryPath, readAgentHistory } from "./agent-history.js";
import {
  type AgentRecoveryCheckpoint,
  type AgentRecoveryStatus,
  agentRecoveryCheckpointPath,
  readAgentRecoveryCheckpoints,
  removeAgentRecoveryCheckpoint,
  writeAgentRecoveryCheckpoint,
} from "./agent-recovery.js";
import {
  type AgentResumeRuntimeFactory,
  type AgentSessionMetadata,
  type PreparedChildSession,
  resumeAgent,
  runAgent,
  type ToolActivity,
} from "./agent-runner.js";
import {
  canonicalArtifactRootCwd,
  ResumeStorageError,
  resolvePrivateSessionLocator,
} from "./agent-session-storage.js";
import { getMaxSubagentDepth, type NestedSpawnOptions } from "./nested-tools.js";
import { streamToOutputFile, writeInitialEntry } from "./output-file.js";
import type {
  AgentInvocation,
  AgentOwnership,
  AgentRecord,
  AgentRecoveryRuntimeIdentity,
  AgentRecoverySessionState,
  IsolationMode,
  SubagentType,
  ThinkingLevel,
  WorktreeResumeState,
} from "./types.js";
import { addUsage } from "./usage.js";
import {
  cleanupWorktree,
  createDetachedWorktree,
  createWorktree,
  getCanonicalRepoRoot,
  pruneWorktrees,
  removeWorktree,
  validateWorktreeTargetPath,
  verifyCommitSha,
  WorktreeError,
  type WorktreeInfo,
} from "./worktree.js";

export interface ReconstructedWorktree {
  worktree: WorktreeInfo;
  executionCwd: string;
}

export type OnAgentComplete = (record: AgentRecord) => void;
export type OnAgentStart = (record: AgentRecord) => void;
export type OnAgentCompact = (record: AgentRecord, info: CompactionInfo) => void;
export type CompactionInfo = { reason: "manual" | "threshold" | "overflow"; tokensBefore: number };

/** Default max concurrent background agents. */
const DEFAULT_MAX_CONCURRENT = 4;
const RESTORABLE_STATUSES = new Set(["completed", "steered", "stopped", "aborted", "error"] as const);
const THINKING_LEVELS = new Set(["minimal", "low", "medium", "high", "xhigh", "max", "off"]);

type RestorableAgentStatus = "completed" | "steered" | "stopped" | "aborted" | "error";

/** Narrow persisted strings before putting them into runtime/UI state. */
function isSafePersistedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength && !/[\0\r\n]/.test(value);
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

function isValidUsage(value: unknown): value is { input: number; output: number; cacheWrite: number } {
  if (!value || typeof value !== "object") return false;
  const usage = value as Record<string, unknown>;
  return ["input", "output", "cacheWrite"].every((key) => {
    const n = usage[key];
    return typeof n === "number" && Number.isFinite(n) && n >= 0;
  });
}

function isSafeTranscriptLocator(value: unknown): value is string {
  return typeof value === "string"
    && /^\.pi-subagents\/agent-transcripts\/[^/]+\.jsonl$/.test(value)
    && !value.includes("..")
    && !value.includes("\\")
    && !value.includes("\0");
}

function isSafeInvocation(value: unknown): value is AgentInvocation {
  if (!value || typeof value !== "object") return false;
  const invocation = value as Record<string, unknown>;
  for (const key of ["modelName", "effectiveModelName"]) {
    if (invocation[key] !== undefined && !isSafePersistedString(invocation[key], 512)) return false;
  }
  for (const key of ["thinking", "effectiveThinking"]) {
    if (invocation[key] !== undefined && (typeof invocation[key] !== "string" || !THINKING_LEVELS.has(invocation[key]))) return false;
  }
  if (invocation.maxTurns !== undefined && (!Number.isInteger(invocation.maxTurns) || (invocation.maxTurns as number) < 0)) return false;
  for (const key of ["isolated", "inheritContext", "runInBackground"]) {
    if (invocation[key] !== undefined && typeof invocation[key] !== "boolean") return false;
  }
  if (invocation.isolation !== undefined && invocation.isolation !== "worktree") return false;
  return true;
}

function cloneInvocation(value: AgentInvocation | undefined): AgentInvocation | undefined {
  return value ? {
    modelName: value.modelName,
    effectiveModelName: value.effectiveModelName,
    thinking: value.thinking,
    effectiveThinking: value.effectiveThinking,
    maxTurns: value.maxTurns,
    isolated: value.isolated,
    inheritContext: value.inheritContext,
    runInBackground: value.runInBackground,
    isolation: value.isolation,
  } : undefined;
}

/** Validate one persisted terminal record without constructing runtime handles. */
export function isRestorableAgentRecord(value: unknown): value is {
  id: string;
  type: string;
  description: string;
  status: RestorableAgentStatus;
  startedAt: number;
  completedAt: number;
  result?: string;
  error?: string;
  toolUses?: number;
  lifetimeUsage?: { input: number; output: number; cacheWrite: number };
  transcriptPath?: string;
  invocation?: AgentInvocation;
} {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (!isSafePersistedString(record.id, 256)
    || !isSafePersistedString(record.type, 256)
    || !isSafePersistedString(record.description, 4096)
    || typeof record.status !== "string"
    || !RESTORABLE_STATUSES.has(record.status as RestorableAgentStatus)
    || !isFiniteTimestamp(record.startedAt)
    || !isFiniteTimestamp(record.completedAt)
    || record.completedAt < record.startedAt) return false;
  if (record.result !== undefined && !isSafePersistedString(record.result, 2_000_000)) return false;
  if (record.error !== undefined && !isSafePersistedString(record.error, 64_000)) return false;
  if (record.toolUses !== undefined && (!Number.isInteger(record.toolUses) || (record.toolUses as number) < 0)) return false;
  if (record.lifetimeUsage !== undefined && !isValidUsage(record.lifetimeUsage)) return false;
  if (record.transcriptPath !== undefined && !isSafeTranscriptLocator(record.transcriptPath)) return false;
  if (record.invocation !== undefined && !isSafeInvocation(record.invocation)) return false;
  return true;
}

/**
 * Validate a caller-supplied SpawnOptions.cwd. `undefined`/`null` mean "unset"
 * (parent cwd). Anything else must be an absolute path to an existing
 * directory — curated errors instead of TypeErrors from path/fs internals
 * (RPC callers send arbitrary JSON: null, numbers, file paths).
 */
function assertValidSpawnCwd(cwd: unknown): asserts cwd is string | undefined | null {
  if (cwd == null) return;
  if (typeof cwd !== "string" || !isAbsolute(cwd)) {
    throw new Error(`SpawnOptions.cwd must be an absolute path: "${String(cwd)}"`);
  }
  let isDirectory = false;
  try {
    isDirectory = statSync(cwd).isDirectory();
  } catch {
    throw new Error(`SpawnOptions.cwd does not exist: "${cwd}"`);
  }
  if (!isDirectory) {
    throw new Error(`SpawnOptions.cwd is not a directory: "${cwd}"`);
  }
}

interface SpawnArgs {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  type: SubagentType;
  prompt: string;
  options: SpawnOptions;
}

export type ResumeAuthority =
  | { kind: "top-level"; artifactRootCwd: string }
  | { kind: "nested"; artifactRootCwd: string; parentAgentId: string }
  | { kind: "workflow"; artifactRootCwd: string; workflowId: string; runtimeAgentId: string };

export type AgentResumeErrorCode =
  | "resume-checkpoint-missing"
  | "resume-checkpoint-invalid"
  | "resume-session-locator-invalid"
  | "resume-session-missing"
  | "resume-session-corrupt"
  | "resume-session-incompatible"
  | "resume-model-unavailable"
  | "resume-invalid-options"
  | "resume-busy"
  | "resume-worktree-missing-cwd"
  | "resume-worktree-invalid-ref"
  | "resume-ownership-denied";

export class AgentResumeError extends Error {
  constructor(public readonly code: AgentResumeErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "AgentResumeError";
  }
}

export interface ResumeOptions {
  /** Whether the resumed turn runs detached and produces a completion notification. */
  isBackground?: boolean;
  /** Abort only this resumed turn. */
  signal?: AbortSignal;
  /** The originating Agent tool call, committed only after preflight succeeds. */
  toolCallId?: string;
}

export interface SpawnOptions extends Partial<Omit<NestedSpawnOptions, "description" | "signal" | "onAssistantUsage" | "onSessionCreated">> {
  /** Overrides the session stamp applied at spawn (used by restore paths). */
  sessionId?: string;
  description: string;
  model?: Model<any>;
  maxTurns?: number;
  isolated?: boolean;
  inheritContext?: boolean;
  thinkingLevel?: ThinkingLevel;
  isBackground?: boolean;
  /**
   * Skip the maxConcurrent queue check for this spawn — start immediately even
   * if the configured concurrency limit would otherwise queue it. Used by the
   * scheduler so a fired job can't be deferred past its trigger window.
   */
  bypassQueue?: boolean;
  /** Isolation mode — "worktree" creates a temp git worktree for the agent. */
  isolation?: IsolationMode;
  /**
   * Working directory for the agent (absolute path). Default: parent session
   * cwd. The agent's tools operate here, but .pi config (extensions, skills,
   * settings, memory) still loads from the parent session's project — the
   * target directory's `.pi` extensions never execute. With isolation:
   * "worktree", the worktree is created FROM this directory and the result
   * branch lands in that repo.
   */
  cwd?: string;
  /** Stable project root for durable artifacts and private native sessions. */
  artifactRootCwd?: string;
  /** Persisted owner used by resume authority checks. */
  ownership?: AgentOwnership;
  /** Resolved invocation snapshot captured for UI display. */
  invocation?: AgentInvocation;
  /** Parent abort signal — when aborted, the subagent is also stopped. */
  signal?: AbortSignal;
  /** Called on tool start/end with activity info (for streaming progress to UI). */
  onToolActivity?: (activity: ToolActivity) => void;
  /** Called on streaming text deltas from the assistant response. */
  onTextDelta?: (delta: string, fullText: string) => void;
  /** Called when the agent session is created (for accessing session stats). */
  onSessionCreated?: (session: AgentSession) => void;
  /** Called at the end of each agentic turn with the cumulative count. */
  onTurnEnd?: (turnCount: number) => void;
  /** Called once per assistant message_end with that message's usage delta. */
  onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number }) => void;
  /** Called when nested delegation is refused, for observability. */
  onNestedIssue?: (issue: string) => void;
  /** Called when the session successfully compacts. */
  onCompaction?: (info: CompactionInfo) => void;
  /** Called synchronously after the record exists, before it is queued or started. */
  onSpawned?: (id: string) => void;
}

export class AgentManager {
  private agents = new Map<string, AgentRecord>();
  private cleanupInterval: ReturnType<typeof setInterval>;
  private onComplete?: OnAgentComplete;
  private onStart?: OnAgentStart;
  private onCompact?: OnAgentCompact;
  private maxConcurrent: number;
  /** Base repos worktrees were created from — so dispose() can prune them all,
   *  not just the parent repo (caller-supplied cwd can target other repos). */
  private worktreeRepos = new Set<string>();
  /** Project cwd for each record's durable checkpoint. */
  private recoveryCwds = new Map<string, string>();
  /** Legacy v1 checkpoints are display-only and must never be rewritten as v2. */
  private displayOnlyCheckpointIds = new Set<string>();

  /** Queue of background agents waiting to start. */
  private queue: { id: string; args: SpawnArgs }[] = [];
  /** Number of currently running background agents. */
  private runningBackground = 0;
  /** Prevent late promise settlement from decrementing a replacement run. */
  private runningBackgroundIds = new Set<string>();
  /** Fresh resume worktrees awaiting later runtime preparation or cleanup. */
  private reconstructedWorktrees = new Map<string, { repoRoot: string; worktree: WorktreeInfo }>();

  constructor(
    onComplete?: OnAgentComplete,
    maxConcurrent = DEFAULT_MAX_CONCURRENT,
    onStart?: OnAgentStart,
    onCompact?: OnAgentCompact,
  ) {
    this.onComplete = onComplete;
    this.onStart = onStart;
    this.onCompact = onCompact;
    this.maxConcurrent = maxConcurrent;
    // Cleanup completed agents after 10 minutes (but keep sessions for resume)
    this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
    this.cleanupInterval.unref();
  }

  /** Update the max concurrent background agents limit. */
  setMaxConcurrent(n: number) {
    this.maxConcurrent = Math.max(1, n);
    // Start queued agents if the new limit allows
    this.drainQueue();
  }

  getMaxConcurrent(): number {
    return this.maxConcurrent;
  }

  /** Reconstruct a fresh worktree; policy and ownership remain in the manager. */
  reconstructResumeWorktree(state: WorktreeResumeState | undefined, agentId: string): ReconstructedWorktree {
    if (!state) throw new WorktreeError("resume-worktree-missing-cwd", "worktree state is missing");
    this.removeReconstructedWorktree(agentId);

    const repoRoot = getCanonicalRepoRoot(state.repoRoot, "resume-worktree-missing-cwd", true);
    const baseSha = verifyCommitSha(repoRoot, state.baseCommitSha);
    const sourceSha = state.savedCommitSha === undefined
      ? baseSha
      : verifyCommitSha(repoRoot, state.savedCommitSha);
    validateWorktreeTargetPath(repoRoot, state.originalTargetSubdirectory);
    const worktree = createDetachedWorktree(repoRoot, sourceSha, state.originalTargetSubdirectory, agentId);
    try {
      const requestedExecutionCwd = join(worktree.path, state.originalTargetSubdirectory.split("/").join(sep));
      const executionCwd = realpathSync(requestedExecutionCwd);
      if (!statSync(executionCwd).isDirectory()) {
        throw new WorktreeError("resume-worktree-missing-cwd", "fresh execution cwd is not a directory");
      }
      const executionRelative = relative(realpathSync(worktree.path), executionCwd);
      if (executionRelative.startsWith(`..${sep}`) || executionRelative === ".." || isAbsolute(executionRelative)) {
        throw new WorktreeError("resume-worktree-missing-cwd", "fresh execution cwd escaped the worktree");
      }
      const reconstructed = { worktree, executionCwd };
      this.reconstructedWorktrees.set(agentId, { repoRoot, worktree });
      return reconstructed;
    } catch (error) {
      removeWorktree(repoRoot, worktree);
      if (error instanceof WorktreeError) throw error;
      throw new WorktreeError("resume-worktree-missing-cwd", "fresh execution cwd is unavailable");
    }
  }

  /** Idempotently remove a fresh resume worktree after preparation failure. */
  removeReconstructedWorktree(agentId: string): void {
    const tracked = this.reconstructedWorktrees.get(agentId);
    if (!tracked) return;
    try {
      removeWorktree(tracked.repoRoot, tracked.worktree);
    } finally {
      this.reconstructedWorktrees.delete(agentId);
    }
  }

  private finishBackground(id: string): void {
    if (!this.runningBackgroundIds.delete(id)) return;
    this.runningBackground = Math.max(0, this.runningBackground - 1);
  }

  private checkpointStatus(record: AgentRecord): AgentRecoveryStatus {
    return record.status;
  }

  private makeCheckpoint(record: AgentRecord): AgentRecoveryCheckpoint {
    const depth = record.runtimeIdentity?.depth ?? record.depth ?? 1;
    const runtime: AgentRecoveryRuntimeIdentity = {
      depth,
      maxSubagentDepth: record.runtimeIdentity?.maxSubagentDepth ?? record.maxSubagentDepth ?? depth,
      ...(record.runtimeIdentity?.rootSessionId ?? record.rootSessionId
        ? { rootSessionId: record.runtimeIdentity?.rootSessionId ?? record.rootSessionId }
        : {}),
    };
    const ownership: AgentOwnership = record.ownership ?? (record.parentAgentId
      ? { kind: "nested", parentAgentId: record.parentAgentId, depth }
      : { kind: "top-level" });
    const session: AgentRecoverySessionState = record.sessionState ?? { kind: "pending" };
    return {
      version: 2,
      id: record.id,
      type: record.type,
      description: record.description,
      status: this.checkpointStatus(record),
      startedAt: record.startedAt,
      toolUses: record.toolUses,
      lifetimeUsage: { ...record.lifetimeUsage },
      compactionCount: record.compactionCount,
      ...(record.completedAt !== undefined && { completedAt: record.completedAt }),
      // A durable transcript is the source of truth for partial/full output.
      // Avoid duplicating potentially sensitive or very large result text.
      ...(!record.transcriptPath && record.result !== undefined && { result: record.result }),
      ...(record.error !== undefined && { error: record.error }),
      ...(record.resultConsumed !== undefined && { resultConsumed: record.resultConsumed }),
      ...(record.toolCallId !== undefined && { toolCallId: record.toolCallId }),
      ...(record.transcriptPath !== undefined && { transcriptPath: record.transcriptPath }),
      ...(record.invocation !== undefined && { invocation: cloneInvocation(record.invocation) }),
      runtime,
      session,
      ownership,
      ...(record.worktreeResume !== undefined && { worktree: record.worktreeResume }),
    };
  }

  private checkpoint(record: AgentRecord): void {
    if (this.displayOnlyCheckpointIds.has(record.id)) return;
    const cwd = this.recoveryCwds.get(record.id);
    if (!cwd) return;
    writeAgentRecoveryCheckpoint(cwd, this.makeCheckpoint(record));
  }

  private flushOutput(record: AgentRecord): void {
    if (!record.outputCleanup) return;
    try { record.outputCleanup(); } catch { /* recovery must remain best effort */ }
    record.outputCleanup = undefined;
  }

  private applyWorktreeCleanup(record: AgentRecord, result: ReturnType<typeof cleanupWorktree>): void {
    record.worktreeResult = result;
    if (result.savedCommitSha && record.worktreeResume) {
      record.worktreeResume.savedCommitSha = result.savedCommitSha;
    }
  }

  /**
   * Attach the project-local transcript before any caller can observe a spawn.
   * The manager owns this invariant so queued, scheduled, RPC, workflow, and
   * nested agents all get the same recoverable opening snapshot.
   */
  private attachDurableHistory(record: AgentRecord, prompt: string, cwd: string): void {
    if (!record.historyFile) {
      const historyFile = createAgentHistoryPath(cwd, record.id);
      record.historyFile = historyFile;
      record.transcriptPath = agentHistoryLocator(cwd, historyFile);
      let shouldWriteInitial = !existsSync(historyFile);
      if (!shouldWriteInitial) {
        try {
          shouldWriteInitial = statSync(historyFile).size === 0;
        } catch {
          shouldWriteInitial = true;
        }
      }
      if (shouldWriteInitial) writeInitialEntry(historyFile, record.id, prompt, cwd);
    }
    this.recoveryCwds.set(record.id, cwd);
    this.checkpoint(record);
  }

  /** Stream every session message to durable history and, when configured, `.output`. */
  private attachTranscriptStream(record: AgentRecord, session: AgentSession, cwd: string, startAt = 1): void {
    if (record.outputCleanup || !record.historyFile) return;
    const outputPath = record.outputFile ?? record.historyFile;
    const historyPath = record.outputFile ? record.historyFile : undefined;
    record.outputCleanup = streamToOutputFile(session, outputPath, record.id, cwd, historyPath, startAt);
  }

  /** Set the durable transcript locator and checkpoint the current state. */
  setTranscript(id: string, historyFile: string, transcriptPath: string, cwd?: string): void {
    const record = this.agents.get(id);
    if (!record) return;
    record.historyFile = historyFile;
    record.transcriptPath = transcriptPath;
    if (cwd) this.recoveryCwds.set(id, cwd);
    this.checkpoint(record);
  }

  /** Checkpoint one record explicitly (used after transcript setup). */
  checkpointRecord(id: string): void {
    const record = this.agents.get(id);
    if (record) this.checkpoint(record);
  }

  /**
   * Reload durable records from this project's checkpoint directory. A
   * running/queued checkpoint means the process was killed before it could
   * write its stopped state; treat it as stopped and retain its transcript.
   * SIGKILL cannot run a final flush/checkpoint, so this active snapshot is
   * necessarily the last recoverable state.
   */
  restoreRecovered(cwd: string, sessionId?: string): void {
    for (const checkpoint of readAgentRecoveryCheckpoints(cwd)) {
      if (checkpoint.version === 1) this.displayOnlyCheckpointIds.add(checkpoint.id);
      else this.displayOnlyCheckpointIds.delete(checkpoint.id);
      const hasTranscript = checkpoint.transcriptPath !== undefined
        && readAgentHistory(cwd, checkpoint.transcriptPath) !== undefined;
      // V1 is display/history-only. A valid v2 private checkpoint has an
      // independent executable native session and must survive without a
      // transcript file; every other transcript-less record remains hidden.
      if (!hasTranscript && !(checkpoint.version === 2 && checkpoint.session.kind === "private")) continue;
      const status: RestorableAgentStatus = checkpoint.status === "running" || checkpoint.status === "queued"
        ? "stopped"
        : checkpoint.status;
      const completedAt = checkpoint.completedAt ?? Date.now();
      const existing = this.agents.get(checkpoint.id);
      if (existing) {
        // Parent-branch records can still carry an unread in-memory result.
        // Never replace that richer record with the checkpoint's transcript
        // stub during the same session. Merge only durable locator metadata.
        if (!existing.transcriptPath && checkpoint.transcriptPath) {
          existing.transcriptPath = checkpoint.transcriptPath;
        }
        if (checkpoint.version === 2 && !existing.session) {
          existing.sessionState = checkpoint.session;
          existing.ownership = checkpoint.ownership;
          existing.runtimeIdentity = checkpoint.runtime;
          existing.artifactRootCwd = checkpoint.session.kind === "pending" ? undefined : checkpoint.session.artifactRootCwd;
          existing.resourceCwd = checkpoint.session.kind === "pending" ? undefined : checkpoint.session.resourceCwd;
          existing.originalExecutionCwd = checkpoint.session.kind === "pending" ? undefined : checkpoint.session.originalExecutionCwd;
          existing.worktreeResume = checkpoint.worktree;
          existing.parentAgentId = checkpoint.ownership.kind === "nested"
            ? checkpoint.ownership.parentAgentId
            : checkpoint.ownership.kind === "workflow"
              ? checkpoint.ownership.workflowId
              : existing.parentAgentId;
          existing.depth = checkpoint.runtime.depth;
          existing.maxSubagentDepth = checkpoint.runtime.maxSubagentDepth;
          existing.rootSessionId = checkpoint.runtime.rootSessionId;
        }
        this.recoveryCwds.set(checkpoint.id, cwd);
        continue;
      }
      const restored = checkpoint.version === 2
        ? {
            ...checkpoint,
            status,
            completedAt,
            parentAgentId: checkpoint.ownership.kind === "nested"
              ? checkpoint.ownership.parentAgentId
              : checkpoint.ownership.kind === "workflow"
                ? checkpoint.ownership.workflowId
                : undefined,
            depth: checkpoint.runtime.depth,
            maxSubagentDepth: checkpoint.runtime.maxSubagentDepth,
            rootSessionId: checkpoint.runtime.rootSessionId,
            sessionState: checkpoint.session,
            ownership: checkpoint.ownership,
            runtimeIdentity: checkpoint.runtime,
            artifactRootCwd: checkpoint.session.kind === "pending" ? undefined : checkpoint.session.artifactRootCwd,
            resourceCwd: checkpoint.session.kind === "pending" ? undefined : checkpoint.session.resourceCwd,
            originalExecutionCwd: checkpoint.session.kind === "pending" ? undefined : checkpoint.session.originalExecutionCwd,
            worktreeResume: checkpoint.worktree,
            ...(sessionId !== undefined && checkpoint.runtime.rootSessionId === sessionId
              ? { sessionId }
              : {}),
          }
        : {
            ...checkpoint,
            status,
            completedAt,
          };
      // Checkpoint files are project-level and mix every session that ever ran
      // in this directory. Only a v2 root session or the original v1 session
      // identity that exactly matches the active runtime session enters the
      // current-session projection; older or unknown records remain history-only.
      this.agents.set(checkpoint.id, this.createRestoredRecord(restored));
      this.recoveryCwds.set(checkpoint.id, cwd);
    }
  }

  /**
   * Spawn an agent and return its ID immediately (for background use).
   * If the concurrency limit is reached, the agent is queued.
   */
  spawn(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: SubagentType,
    prompt: string,
    options: SpawnOptions,
  ): string {
    // Validate before the queue branch — a queued spawn should fail at the
    // call, not minutes later at drain. Throw (not warn): programmatic callers
    // can fix and retry; the RPC layer converts throws into error envelopes.
    assertValidSpawnCwd(options.cwd);

    const id = randomUUID().slice(0, 17);
    const abortController = new AbortController();
    const artifactRootCwd = canonicalArtifactRootCwd(options.artifactRootCwd ?? ctx.cwd);
    const depth = options.depth ?? 1;
    const maxDepth = options.maxSubagentDepth ?? getMaxSubagentDepth();
    const runtimeIdentity: AgentRecoveryRuntimeIdentity = {
      depth,
      maxSubagentDepth: maxDepth,
      ...(options.rootSessionId ?? ctx.sessionManager?.getSessionId?.()
        ? { rootSessionId: options.rootSessionId ?? ctx.sessionManager?.getSessionId?.() }
        : {}),
    };
    const ownership: AgentOwnership = options.ownership ?? (options.parentAgentId
      ? { kind: "nested", parentAgentId: options.parentAgentId, depth }
      : { kind: "top-level" });
    const record: AgentRecord = {
      id,
      type,
      description: options.description,
      status: options.isBackground ? "queued" : "running",
      toolUses: 0,
      startedAt: Date.now(),
      abortController,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
      compactionCount: 0,
      // Raw tri-state (not coerced to a boolean): true = background, false =
      // foreground (has an inline tool-result surface), undefined = caller never
      // declared it (e.g. a cross-extension RPC spawn). The widget's background-
      // only filter excludes only explicit `false`, so undefined agents — which
      // have no inline surface — stay visible instead of vanishing.
      isBackground: options.isBackground,
      invocation: options.invocation,
      depth,
      parentAgentId: options.parentAgentId,
      ownership,
      runtimeIdentity,
      artifactRootCwd,
      resourceCwd: options.configCwd ?? ctx.cwd,
      originalExecutionCwd: options.cwd ?? ctx.cwd,
      parentDescription: options.parentAgentId ? this.agents.get(options.parentAgentId)?.description : undefined,
      maxSubagentDepth: maxDepth,
      rootSessionId: options.rootSessionId ?? ctx.sessionManager?.getSessionId?.(),
      sessionId: options.sessionId ?? ctx.sessionManager?.getSessionId?.(),
      sessionState: { kind: "pending" },
      liveActivity: {
        activeTools: new Map(),
        responseText: "",
        turnCount: 0,
        maxTurns: options.maxTurns,
        session: undefined,
      },
    };
    this.agents.set(id, record);
    this.recoveryCwds.set(id, artifactRootCwd);
    // Durable history is a manager invariant: it exists before queue/start and
    // before the external callback can expose the id to another subsystem.
    try {
      this.attachDurableHistory(record, prompt, artifactRootCwd);
      options.onSpawned?.(id);
    } catch (err) {
      this.agents.delete(id);
      this.recoveryCwds.delete(id);
      removeAgentRecoveryCheckpoint(artifactRootCwd, id);
      throw err;
    }

    const args: SpawnArgs = { pi, ctx, type, prompt, options };

    // Nested children never consume or wait for a top-level concurrency slot;
    // queueing behind the parent would deadlock an inline nested spawn.
    if (options.isBackground && ownership.kind === "top-level" && !options.bypassQueue && this.runningBackground >= this.maxConcurrent) {
      // Queue it — will be started when a running agent completes
      this.queue.push({ id, args });
      return id;
    }

    // startAgent can throw (e.g. strict worktree-isolation failure) — clean
    // up the record so callers don't see an orphan in `listAgents()`.
    try {
      this.startAgent(id, record, args);
    } catch (err) {
      this.agents.delete(id);
      this.recoveryCwds.delete(id);
      removeAgentRecoveryCheckpoint(artifactRootCwd, id);
      throw err;
    }
    return id;
  }

  /** Actually start an agent (called immediately or from queue drain). */
  private startAgent(id: string, record: AgentRecord, { pi, ctx, type, prompt, options }: SpawnArgs) {
    // Re-validate a caller-supplied cwd: queued spawns can start minutes after
    // spawn()'s check, and the directory may be gone by then (TOCTOU). Same
    // curated errors; drainQueue parks a throw on the record as an error.
    assertValidSpawnCwd(options.cwd);
    // Single resolution point for the caller-supplied cwd — the worktree base
    // repo and both cleanup calls below MUST agree on this value forever.
    const customCwd = options.cwd ?? undefined; // null (RPC "unset") → undefined
    const baseCwd = customCwd ?? ctx.cwd;

    // Worktree isolation: try to create a temporary git worktree. Strict —
    // fail loud if not possible (no silent fallback to main tree). Done
    // BEFORE state mutation so a throw doesn't leave the record half-running.
    let worktreeCwd: string | undefined;
    if (options.isolation === "worktree") {
      const wt = createWorktree(baseCwd, id);
      if (!wt) {
        throw new Error(
          'Cannot run with isolation: "worktree" — not a git repo, no commits yet, or `git worktree add` failed. ' +
          'Initialize git and commit at least once, or omit `isolation`.',
        );
      }
      record.worktree = wt;
      if (typeof wt.repoRoot === "string" && typeof wt.originalTargetSubdirectory === "string") {
        record.worktreeResume = {
          repoRoot: wt.repoRoot,
          baseCommitSha: wt.baseSha,
          originalTargetSubdirectory: customCwd !== undefined ? wt.originalTargetSubdirectory : "",
        };
      }
      // workPath preserves subdirectory scoping for caller-supplied cwds: a
      // cwd deep in a monorepo maps to the same subdir inside the copy, not
      // the copied repo's root. Plain worktree spawns keep the historical
      // behavior (agent at the copy's root) — moving them to workPath would
      // also move .pi config discovery when the parent session sits in a repo
      // subdirectory, silently dropping extensions/skills.
      worktreeCwd = customCwd !== undefined ? wt.workPath : wt.path;
      this.worktreeRepos.add(wt.repoRoot ?? baseCwd);
    }

    record.status = "running";
    record.startedAt = Date.now();
    this.checkpoint(record);
    if (options.isBackground && this.persistedOwnership(record).kind === "top-level") {
      this.runningBackground++;
      this.runningBackgroundIds.add(id);
    }
    this.onStart?.(record);

    // Wire parent abort signal to stop the subagent when the parent is interrupted
    let detachParentSignal: (() => void) | undefined;
    if (options.signal) {
      const onParentAbort = () => this.abort(id);
      options.signal.addEventListener("abort", onParentAbort, { once: true });
      detachParentSignal = () => options.signal!.removeEventListener("abort", onParentAbort);
    }
    const detach = () => { detachParentSignal?.(); detachParentSignal = undefined; };

    let agentPromise: ReturnType<typeof runAgent>;
    try {
      agentPromise = runAgent(ctx, type, prompt, {
      pi,
      agentId: id,
      model: options.model,
      maxTurns: options.maxTurns,
      isolated: options.isolated,
      inheritContext: options.inheritContext,
      thinkingLevel: options.thinkingLevel,
      // Worktree wins for the working dir (the agent must run in the copy —
      // which, with a custom cwd, was created from that target). Config stays
      // with the parent project when a caller-supplied cwd is in play; it must
      // stay undefined otherwise so plain worktree runs keep resolving config
      // (incl. relative extension paths and memory) inside the worktree copy.
      cwd: worktreeCwd ?? customCwd,
      configCwd: customCwd !== undefined ? (record.resourceCwd ?? ctx.cwd) : undefined,
      artifactRootCwd: record.artifactRootCwd ?? ctx.cwd,
      originalExecutionCwd: record.originalExecutionCwd ?? customCwd ?? ctx.cwd,
      runtimeIdentity: record.runtimeIdentity ?? {
        depth: record.depth ?? 1,
        maxSubagentDepth: record.maxSubagentDepth ?? record.depth ?? 1,
        ...(record.rootSessionId ? { rootSessionId: record.rootSessionId } : {}),
      },
      ownership: record.ownership ?? (record.parentAgentId
        ? { kind: "nested", parentAgentId: record.parentAgentId, depth: record.depth ?? 1 }
        : { kind: "top-level" }),
      rootSessionId: record.rootSessionId,
      onSessionMetadata: (metadata: AgentSessionMetadata) => {
        const persistedMetadata = record.worktree
          ? {
              ...metadata,
              resourceCwd: ctx.cwd,
              sessionState: metadata.sessionState.kind === "pending"
                ? metadata.sessionState
                : { ...metadata.sessionState, resourceCwd: ctx.cwd },
            }
          : metadata;
        record.sessionState = persistedMetadata.sessionState;
        record.runtimeIdentity = persistedMetadata.runtimeIdentity;
        record.ownership = persistedMetadata.ownership;
        record.artifactRootCwd = persistedMetadata.artifactRootCwd;
        record.resourceCwd = persistedMetadata.resourceCwd;
        record.originalExecutionCwd = persistedMetadata.originalExecutionCwd;
        this.checkpoint(record);
      },
      signal: record.abortController!.signal,
      onToolActivity: (activity) => {
        const live = record.liveActivity;
        if (live) {
          if (activity.type === "start") {
            live.activeTools.set(`${activity.toolName}:${Date.now()}:${live.activeTools.size}`, activity.toolName);
          } else {
            for (const [key, name] of live.activeTools) {
              if (name === activity.toolName) { live.activeTools.delete(key); break; }
            }
          }
        }
        if (activity.type === "end") record.toolUses++;
        options.onToolActivity?.(activity);
      },
      onTurnEnd: (turnCount) => {
        if (record.liveActivity) record.liveActivity.turnCount = turnCount;
        options.onTurnEnd?.(turnCount);
      },
      onTextDelta: (delta, fullText) => {
        if (record.liveActivity) record.liveActivity.responseText = fullText;
        options.onTextDelta?.(delta, fullText);
      },
      onAssistantUsage: (usage) => {
        addUsage(record.lifetimeUsage, usage);
        options.onAssistantUsage?.(usage);
      },
      onCompaction: (info) => {
        record.compactionCount++;
        this.onCompact?.(record, info);
        options.onCompaction?.(info);
      },
      onNestedIssue: (issue) => {
        record.nestedIssue = issue;
        options.onNestedIssue?.(issue);
      },
      nestedRuntime: {
        manager: this,
        parentAgentId: id,
        depth: record.depth ?? 1,
        maxSubagentDepth: record.runtimeIdentity?.maxSubagentDepth ?? options.maxSubagentDepth,
        rootSessionId: record.runtimeIdentity?.rootSessionId ?? record.rootSessionId,
      },
      nestedSession: record.ownership?.kind === "nested" || options.parentAgentId !== undefined,
      onSessionCreated: (session) => {
        record.session = session;
        if (record.liveActivity) record.liveActivity.session = session;
        const model = session.model;
        record.invocation = {
          ...(record.invocation ?? {}),
          ...(model && { effectiveModelName: model.name ?? model.id }),
          effectiveThinking: session.thinkingLevel,
        };
        // Flush any steers that arrived before the session was ready
        if (record.pendingSteers?.length) {
          for (const msg of record.pendingSteers) {
            session.steer(msg).catch(() => {});
          }
          record.pendingSteers = undefined;
        }
        // Subscribe before the external callback so history does not depend on
        // any particular adapter's callback ordering or output setting.
        this.attachTranscriptStream(record, session, record.artifactRootCwd ?? ctx.cwd);
        options.onSessionCreated?.(session);
        this.checkpoint(record);
      },
      });
    } catch (err) {
      detach();
      if (record.worktree) {
        try {
          const cleanupCwd = record.worktreeResume?.repoRoot ?? record.worktree.repoRoot ?? baseCwd;
          const wtResult = cleanupWorktree(cleanupCwd, record.worktree, options.description);
          this.applyWorktreeCleanup(record, wtResult);
        } catch { /* ignore cleanup errors */ }
      }
      if (options.isBackground && this.persistedOwnership(record).kind === "top-level") this.finishBackground(id);
      throw err;
    }

    const promise = agentPromise
      .then(({ responseText, session, aborted, steered, failure }) => {
        // A disposed manager no longer owns this run. Avoid late callbacks
        // mutating a dead session or emitting completion side effects.
        if (this.agents.get(id) !== record) return responseText;
        // Don't overwrite status if externally stopped via abort()
        if (record.status !== "stopped") {
          // Precedence: a hard abort keeps "aborted"; then a failed final turn
          // (provider error that pi resolved instead of rejecting, #144) is an
          // honest "error" — not a completion with an empty or stale result.
          if (aborted) {
            record.status = "aborted";
          } else if (failure) {
            record.status = "error";
            record.error = failure;
          } else {
            record.status = steered ? "steered" : "completed";
          }
        }
        record.result = responseText;
        record.session = session;
        record.completedAt ??= Date.now();

        detach();

        // Flush durable history and optional `.output` before the terminal checkpoint.
        this.flushOutput(record);

        // Clean up worktree if used
        if (record.worktree) {
          const cleanupCwd = record.worktreeResume?.repoRoot ?? record.worktree.repoRoot ?? baseCwd;
          const wtResult = cleanupWorktree(cleanupCwd, record.worktree, options.description);
          this.applyWorktreeCleanup(record, wtResult);
          if (wtResult.hasChanges && wtResult.branch) {
            // With a caller-supplied cwd the branch lives in THAT repo, not the
            // parent session's — say so, or the orchestrator merges in the wrong repo.
            const repoNote = customCwd !== undefined ? ` in \`${baseCwd}\`` : "";
            record.result = (record.result ?? "") +
              `\n\n---\nChanges saved to branch \`${wtResult.branch}\`${repoNote}. Merge with: \`git merge ${wtResult.branch}\`${customCwd !== undefined ? ` (run in \`${baseCwd}\`)` : ""}`;
          }
        }
        this.checkpoint(record);

        // Fire onComplete for foreground agents too — lifecycle symmetry.
        // Mark resultConsumed so the callback skips notifications (result returned inline).
        if (!options.isBackground) {
          record.resultConsumed = true;
          try { this.onComplete?.(record); } catch { /* ignore completion side-effect errors */ }
        } else {
          this.finishBackground(id);
          try { this.onComplete?.(record); } catch { /* ignore completion side-effect errors */ }
          this.drainQueue();
        }
        return responseText;
      })
      .catch((err) => {
        // A disposed manager no longer owns this run. Avoid late callbacks
        // mutating a dead session or emitting completion side effects.
        if (this.agents.get(id) !== record) return "";
        // Don't overwrite status if externally stopped via abort()
        if (record.status !== "stopped") {
          record.status = "error";
        }
        record.error = err instanceof Error ? err.message : String(err);
        record.completedAt ??= Date.now();

        detach();

        // Flush durable history and optional `.output` before the terminal checkpoint.
        this.flushOutput(record);

        // Best-effort worktree cleanup on error
        if (record.worktree) {
          try {
            const cleanupCwd = record.worktreeResume?.repoRoot ?? record.worktree.repoRoot ?? baseCwd;
            const wtResult = cleanupWorktree(cleanupCwd, record.worktree, options.description);
            this.applyWorktreeCleanup(record, wtResult);
          } catch { /* ignore cleanup errors */ }
        }
        this.checkpoint(record);

        // Fire onComplete for foreground agents too — lifecycle symmetry.
        // Mark resultConsumed so the callback skips notifications (result returned inline).
        if (!options.isBackground) {
          record.resultConsumed = true;
          this.onComplete?.(record);
        } else {
          this.finishBackground(id);
          this.onComplete?.(record);
          this.drainQueue();
        }
        return "";
      });

    record.promise = promise;
  }

  /** Start queued agents up to the concurrency limit. */
  private drainQueue() {
    while (this.queue.length > 0 && this.runningBackground < this.maxConcurrent) {
      const next = this.queue.shift()!;
      const record = this.agents.get(next.id);
      if (!record || record.status !== "queued") continue;
      try {
        this.startAgent(next.id, record, next.args);
      } catch (err) {
        // Late failure (e.g. strict worktree-isolation) — surface on the record
        // so the user/agent can see it via /agents, then keep draining.
        record.status = "error";
        record.error = err instanceof Error ? err.message : String(err);
        record.completedAt = Date.now();
        this.flushOutput(record);
        this.checkpoint(record);
        this.onComplete?.(record);
      }
    }
  }

  private persistedOwnership(record: AgentRecord): AgentOwnership {
    return record.ownership ?? (record.parentAgentId
      ? { kind: "nested", parentAgentId: record.parentAgentId, depth: record.depth ?? 1 }
      : { kind: "top-level" });
  }

  private persistedArtifactRoot(record: AgentRecord): string | undefined {
    const state = record.sessionState;
    return record.artifactRootCwd
      ?? (state && state.kind !== "pending" ? state.artifactRootCwd : undefined);
  }

  /** Final owner gate. No checkpoint, locator, model, or worktree access precedes this. */
  private assertResumeAuthority(record: AgentRecord, authority: ResumeAuthority): string {
    let callerRoot: string;
    try {
      callerRoot = canonicalArtifactRootCwd(authority.artifactRootCwd);
    } catch {
      throw new AgentResumeError("resume-ownership-denied", "caller artifact root is invalid");
    }
    const persistedRoot = this.persistedArtifactRoot(record);
    if (!persistedRoot) {
      throw new AgentResumeError("resume-ownership-denied", "record has no persisted artifact root");
    }
    let recordRoot: string;
    try {
      recordRoot = canonicalArtifactRootCwd(persistedRoot);
    } catch {
      throw new AgentResumeError("resume-ownership-denied", "record artifact root is invalid");
    }
    if (callerRoot !== recordRoot) {
      throw new AgentResumeError("resume-ownership-denied", "caller artifact root does not own this record");
    }

    const owner = this.persistedOwnership(record);
    const owns = authority.kind === "top-level"
      ? owner.kind === "top-level"
      : authority.kind === "nested"
        ? owner.kind === "nested" && owner.parentAgentId === authority.parentAgentId
        : owner.kind === "workflow" && owner.workflowId === authority.workflowId
          && authority.runtimeAgentId.length > 0;
    if (!owns) {
      throw new AgentResumeError("resume-ownership-denied", "record owner does not match resume authority");
    }
    return callerRoot;
  }

  private assertCheckpointAuthority(
    checkpoint: Extract<AgentRecoveryCheckpoint, { version: 2 }>,
    authority: ResumeAuthority,
    callerRoot: string,
  ): void {
    if (checkpoint.session.kind === "pending" || checkpoint.session.artifactRootCwd === undefined) {
      throw new AgentResumeError("resume-checkpoint-invalid", "private checkpoint session state is missing");
    }
    let persistedRoot: string;
    try {
      persistedRoot = canonicalArtifactRootCwd(checkpoint.session.artifactRootCwd);
    } catch {
      throw new AgentResumeError("resume-checkpoint-invalid", "private checkpoint artifact root is invalid");
    }
    if (persistedRoot !== callerRoot) {
      throw new AgentResumeError("resume-ownership-denied", "checkpoint artifact root does not match caller");
    }
    const owner = checkpoint.ownership;
    const owns = authority.kind === "top-level"
      ? owner.kind === "top-level"
      : authority.kind === "nested"
        ? owner.kind === "nested" && owner.parentAgentId === authority.parentAgentId
        : owner.kind === "workflow" && owner.workflowId === authority.workflowId
          && authority.runtimeAgentId.length > 0;
    if (!owns) {
      throw new AgentResumeError("resume-ownership-denied", "checkpoint owner does not match resume authority");
    }
  }

  private requirePrivateCheckpoint(
    record: AgentRecord,
    authority: ResumeAuthority,
    callerRoot: string,
  ): Extract<AgentRecoveryCheckpoint, { version: 2 }> {
    const cwd = this.recoveryCwds.get(record.id) ?? callerRoot;
    const checkpoint = readAgentRecoveryCheckpoints(cwd).find(value => value.id === record.id);
    if (!checkpoint) {
      const path = agentRecoveryCheckpointPath(cwd, record.id);
      throw new AgentResumeError(
        existsSync(path) ? "resume-checkpoint-invalid" : "resume-checkpoint-missing",
        `no valid v2 checkpoint exists for agent ${record.id}`,
      );
    }
    if (checkpoint.version !== 2) {
      throw new AgentResumeError("resume-checkpoint-invalid", "v1 checkpoints are display-only");
    }
    if (checkpoint.session.kind !== "private") {
      throw new AgentResumeError("resume-checkpoint-invalid", "only private v2 sessions are executable after loss");
    }
    this.assertCheckpointAuthority(checkpoint, authority, callerRoot);
    return checkpoint;
  }

  private ensureResumeHistory(record: AgentRecord, prompt: string, cwd: string): void {
    if (record.historyFile) return;
    const historyFile = createAgentHistoryPath(cwd, record.id);
    record.historyFile = historyFile;
    record.transcriptPath = agentHistoryLocator(cwd, historyFile);
    writeInitialEntry(historyFile, record.id, prompt, cwd);
  }

  private cleanupResumeWorktree(record: AgentRecord, worktree: WorktreeInfo | undefined, description: string): void {
    if (!worktree) return;
    const cleanupCwd = record.worktreeResume?.repoRoot ?? worktree.repoRoot;
    try {
      this.applyWorktreeCleanup(record, cleanupWorktree(cleanupCwd, worktree, description));
    } finally {
      this.reconstructedWorktrees.delete(record.id);
    }
  }

  private startResumeTurn(
    record: AgentRecord,
    prompt: string,
    isBackground: boolean,
    signal: AbortSignal | undefined,
    historyStartIndex: number,
    worktree: WorktreeInfo | undefined,
  ): Promise<string> {
    const controller = record.abortController!;
    const occupiesBackgroundPool = isBackground && this.persistedOwnership(record).kind === "top-level";
    let settled = false;
    let detachExternalSignal = () => {};
    if (signal) {
      const onAbort = () => this.abort(record.id);
      if (signal.aborted) onAbort();
      else {
        signal.addEventListener("abort", onAbort, { once: true });
        detachExternalSignal = () => signal.removeEventListener("abort", onAbort);
      }
    }

    const finish = (text: string, failure?: string, thrown?: unknown): string => {
      if (settled) return text;
      settled = true;
      detachExternalSignal();
      if (record.status !== "stopped") {
        record.status = failure || thrown !== undefined ? "error" : "completed";
      }
      if (failure) record.error = failure;
      if (thrown !== undefined) record.error = thrown instanceof Error ? thrown.message : String(thrown);
      record.result = text;
      record.completedAt = Date.now();
      this.flushOutput(record);
      this.cleanupResumeWorktree(record, worktree, record.description);
      if (!isBackground) record.resultConsumed = true;
      this.checkpoint(record);
      if (occupiesBackgroundPool) this.finishBackground(record.id);
      try { this.onComplete?.(record); } catch { /* completion callbacks are best effort */ }
      if (occupiesBackgroundPool) this.drainQueue();
      return text;
    };

    const promise = Promise.resolve()
      .then(() => resumeAgent(record.session!, prompt, {
        historyStartIndex,
        onToolActivity: activity => {
          if (activity.type === "end") record.toolUses++;
        },
        onAssistantUsage: usage => addUsage(record.lifetimeUsage, usage),
        onCompaction: info => {
          record.compactionCount++;
          this.onCompact?.(record, info);
        },
        signal: controller.signal,
      }))
      .then(({ text, failure }) => finish(text, failure))
      .catch(error => finish("", undefined, error));
    record.promise = promise;
    return promise;
  }

  /**
   * Resume a record with explicit owner authority. Live sessions use the
   * same-process path; only a validated private v2 checkpoint may rehydrate.
   */
  async resume(
    id: string,
    prompt: string,
    runtimeFactory: AgentResumeRuntimeFactory,
    authority: ResumeAuthority,
    signalOrOptions?: AbortSignal | ResumeOptions,
    options?: ResumeOptions,
  ): Promise<AgentRecord | undefined> {
    const record = this.agents.get(id);
    if (!record) return undefined;
    const resumeOptions = options ?? (
      signalOrOptions && "aborted" in signalOrOptions
        ? { signal: signalOrOptions }
        : signalOrOptions
    ) ?? {};
    const callerRoot = this.assertResumeAuthority(record, authority);
    if (record.status === "running" || record.status === "queued") {
      throw new AgentResumeError("resume-busy", `agent ${id} is already ${record.status}`);
    }

    const isBackground = resumeOptions.isBackground ?? false;
    const signal = resumeOptions.signal;
    const oldSession = record.session;
    let prepared: PreparedChildSession | undefined;
    let freshWorktree: WorktreeInfo | undefined;
    let resumeCheckpoint: Extract<AgentRecoveryCheckpoint, { version: 2 }> | undefined;
    if (!oldSession) {
      resumeCheckpoint = this.requirePrivateCheckpoint(record, authority, callerRoot);
      try {
        const checkpointSession = resumeCheckpoint.session;
        if (checkpointSession.kind !== "private") {
          throw new AgentResumeError("resume-checkpoint-invalid", "only private v2 sessions are executable after loss");
        }
        // Validate the locator before creating a worktree. The runtime repeats
        // the native JSONL/header checks immediately before open.
        resolvePrivateSessionLocator(callerRoot, checkpointSession.locator);
        const execution = resumeCheckpoint.worktree
          ? this.reconstructResumeWorktree(resumeCheckpoint.worktree, record.id)
          : (() => {
              if (!existsSync(checkpointSession.originalExecutionCwd)
                || !statSync(checkpointSession.originalExecutionCwd).isDirectory()) {
                throw new AgentResumeError("resume-worktree-missing-cwd", "original execution cwd is unavailable");
              }
              return { executionCwd: checkpointSession.originalExecutionCwd, worktree: undefined };
            })();
        freshWorktree = execution.worktree;
        const runtime = runtimeFactory.create({
          nestedManager: this,
          childIdentity: {
            parentAgentId: record.id,
            depth: resumeCheckpoint.runtime.depth,
            maxSubagentDepth: resumeCheckpoint.runtime.maxSubagentDepth,
            rootSessionId: resumeCheckpoint.runtime.rootSessionId,
          },
        });
        prepared = await runtime.rehydrate(
          {
            ...record,
            sessionState: checkpointSession,
            ownership: resumeCheckpoint.ownership,
            runtimeIdentity: resumeCheckpoint.runtime,
            artifactRootCwd: checkpointSession.artifactRootCwd,
            resourceCwd: checkpointSession.resourceCwd,
            originalExecutionCwd: checkpointSession.originalExecutionCwd,
            worktreeResume: resumeCheckpoint.worktree,
          },
          execution.executionCwd,
          signal,
        );
      } catch (error) {
        if (prepared?.session) {
          try { prepared.session.dispose(); } catch { /* adapter cleanup is best effort */ }
        }
        if (freshWorktree) this.removeReconstructedWorktree(record.id);
        if (error instanceof AgentResumeError) throw error;
        if (error instanceof ResumeStorageError) throw new AgentResumeError(error.code, error.message);
        if (error instanceof WorktreeError) throw new AgentResumeError(error.code, error.message);
        throw new AgentResumeError(
          error instanceof Error && "code" in error && typeof (error as { code?: unknown }).code === "string"
            ? (error as { code: AgentResumeErrorCode }).code
            : "resume-session-incompatible",
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    const session = prepared?.session ?? oldSession;
    if (!session) throw new AgentResumeError("resume-session-incompatible", "resume session is unavailable");
    const previous = {
      status: record.status,
      startedAt: record.startedAt,
      completedAt: record.completedAt,
      result: record.result,
      error: record.error,
      resultConsumed: record.resultConsumed,
      toolCallId: record.toolCallId,
      session: record.session,
      abortController: record.abortController,
      promise: record.promise,
      isBackground: record.isBackground,
      worktree: record.worktree,
      worktreeResume: record.worktreeResume,
      sessionState: record.sessionState,
      ownership: record.ownership,
      runtimeIdentity: record.runtimeIdentity,
      artifactRootCwd: record.artifactRootCwd,
      resourceCwd: record.resourceCwd,
      originalExecutionCwd: record.originalExecutionCwd,
      invocation: record.invocation,
      outputFile: record.outputFile,
      historyFile: record.historyFile,
      transcriptPath: record.transcriptPath,
      outputCleanup: record.outputCleanup,
      worktreeResult: record.worktreeResult,
    };
    const previousLiveActivitySession = record.liveActivity?.session;
    const controller = new AbortController();
    record.session = session;
    record.abortController = controller;
    record.status = "running";
    record.startedAt = Date.now();
    record.completedAt = undefined;
    record.result = undefined;
    record.error = undefined;
    record.resultConsumed = false;
    record.isBackground = isBackground;
    if (resumeOptions.toolCallId !== undefined) record.toolCallId = resumeOptions.toolCallId;
    if (prepared?.metadata) {
      record.sessionState = prepared.metadata.sessionState;
      record.runtimeIdentity = prepared.metadata.runtimeIdentity;
      record.ownership = prepared.metadata.ownership;
      record.artifactRootCwd = prepared.metadata.artifactRootCwd;
      record.resourceCwd = prepared.metadata.resourceCwd;
      record.originalExecutionCwd = prepared.metadata.originalExecutionCwd;
    }
    if (freshWorktree) {
      record.worktree = freshWorktree;
      record.worktreeResume = record.worktreeResume ?? resumeCheckpoint?.worktree;
    }
    if (record.liveActivity) record.liveActivity.session = session;
    const resumedModel = session.model;
    record.invocation = {
      ...(record.invocation ?? {}),
      ...(resumedModel && { effectiveModelName: resumedModel.name ?? resumedModel.id }),
      effectiveThinking: session.thinkingLevel,
      runInBackground: isBackground,
    };
    const occupiesBackgroundPool = isBackground && this.persistedOwnership(record).kind === "top-level";
    let backgroundReserved = false;
    try {
      const cwd = this.recoveryCwds.get(id) ?? callerRoot;
      this.ensureResumeHistory(record, prompt, cwd);
      const historyStartIndex = prepared?.historyStartIndex ?? session.messages.length;
      this.attachTranscriptStream(record, session, cwd, historyStartIndex);
      this.checkpoint(record);
      this.onStart?.(record);
      if (occupiesBackgroundPool) {
        this.runningBackground++;
        this.runningBackgroundIds.add(id);
        backgroundReserved = true;
      }
      this.startResumeTurn(record, prompt, isBackground, signal, historyStartIndex, freshWorktree);
    } catch (error) {
      if (backgroundReserved) this.finishBackground(id);
      if (record.outputCleanup !== previous.outputCleanup && record.outputCleanup) {
        try { record.outputCleanup(); } catch { /* rollback must remain best effort */ }
      }
      if (previous.historyFile === undefined && record.historyFile !== undefined) {
        try { rmSync(record.historyFile, { force: true }); } catch { /* rollback must remain best effort */ }
      }
      if (prepared && prepared.session !== oldSession) {
        try { prepared.session.dispose(); } catch { /* adapter cleanup is best effort */ }
      }
      if (freshWorktree) this.removeReconstructedWorktree(id);
      Object.assign(record, previous);
      if (record.liveActivity) record.liveActivity.session = previousLiveActivitySession;
      try { this.checkpoint(record); } catch { /* preserve the original setup failure */ }
      throw error;
    }

    if (!isBackground) await record.promise;
    return record;
  }

  /**
   * Send a steering message to an agent from the UI (mirrors the steer_subagent
   * tool). A live session delivers it now — it interrupts the agent after its
   * current tool execution and appears as a user message. If the session isn't
   * ready yet, the message is queued on `pendingSteers` and flushed when the
   * session is created. Returns false if the agent can't accept steering
   * (unknown id, or no longer running/queued).
   */
  steer(id: string, message: string): boolean {
    const record = this.agents.get(id);
    if (!record) return false;
    if (record.status !== "running" && record.status !== "queued") return false;
    if (record.session) {
      record.session.steer(message).catch(() => {});
    } else {
      if (!record.pendingSteers) record.pendingSteers = [];
      record.pendingSteers.push(message);
    }
    return true;
  }

  getRecord(id: string): AgentRecord | undefined {
    return this.agents.get(id);
  }

  listAgents(): AgentRecord[] {
    return [...this.agents.values()].sort(
      (a, b) => b.startedAt - a.startedAt,
    );
  }

  /** Restore terminal records persisted by a parent branch without runtime handles. */
  /**
   * Restore terminal records carried by a parent branch. A fork continues its
   * parent's context, so those agents count as present in this session and are
   * stamped with the current session id rather than the one that spawned them.
   */
  restoreCompleted(records: readonly unknown[], sessionId?: string): void {
    const latest = new Map<string, ReturnType<typeof this.createRestoredRecord>>();
    for (const value of records) {
      if (isRestorableAgentRecord(value)) {
        latest.set(value.id, this.createRestoredRecord({ ...value, sessionId }));
      }
    }

    for (const [id, restored] of latest) {
      const existing = this.agents.get(id);
      if (existing?.status === "running" || existing?.status === "queued") continue;
      this.agents.set(id, restored);
    }
  }

  private createRestoredRecord(record: {
    id: string;
    type: string;
    description: string;
    status: RestorableAgentStatus;
    startedAt: number;
    completedAt: number;
    result?: string;
    error?: string;
    resultConsumed?: boolean;
    toolCallId?: string;
    toolUses?: number;
    lifetimeUsage?: { input: number; output: number; cacheWrite: number };
    transcriptPath?: string;
    invocation?: AgentInvocation;
    compactionCount?: number;
    parentAgentId?: string;
    depth?: number;
    sessionId?: string;
    maxSubagentDepth?: number;
    rootSessionId?: string;
    sessionState?: AgentRecoverySessionState;
    ownership?: AgentOwnership;
    runtimeIdentity?: AgentRecoveryRuntimeIdentity;
    artifactRootCwd?: string;
    resourceCwd?: string;
    originalExecutionCwd?: string;
    worktreeResume?: AgentRecord["worktreeResume"];
  }): AgentRecord {
    return {
      id: record.id,
      type: record.type,
      description: record.description,
      status: record.status,
      result: record.result,
      error: record.error,
      resultConsumed: record.resultConsumed,
      toolCallId: record.toolCallId,
      toolUses: record.toolUses ?? 0,
      startedAt: record.startedAt,
      completedAt: record.completedAt,
      transcriptPath: record.transcriptPath,
      invocation: cloneInvocation(record.invocation),
      lifetimeUsage: record.lifetimeUsage
        ? { ...record.lifetimeUsage }
        : { input: 0, output: 0, cacheWrite: 0 },
      compactionCount: record.compactionCount ?? 0,
      parentAgentId: record.parentAgentId,
      depth: record.depth,
      sessionId: record.sessionId,
      maxSubagentDepth: record.maxSubagentDepth,
      rootSessionId: record.rootSessionId,
      sessionState: record.sessionState,
      ownership: record.ownership,
      runtimeIdentity: record.runtimeIdentity,
      artifactRootCwd: record.artifactRootCwd,
      resourceCwd: record.resourceCwd,
      originalExecutionCwd: record.originalExecutionCwd,
      worktreeResume: record.worktreeResume,
    };
  }

  /** Record a nested refusal so the widget and viewer retain the explanation. */
  reportNestedIssue(parentAgentId: string, issue: string): void {
    const record = this.agents.get(parentAgentId);
    if (record) record.nestedIssue = issue;
  }

  /** Run one nested child inline without charging either concurrency pool. */
  async spawnAndWait(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: string,
    prompt: string,
    options: Omit<SpawnOptions, "isBackground">,
    onSpawned?: (id: string) => void,
  ): Promise<{ id: string; record: AgentRecord }> {
    const id = this.spawn(pi, ctx, type, prompt, { ...options, isBackground: false, onSpawned });
    const record = this.agents.get(id);
    if (!record) throw new Error(`Nested agent "${id}" disappeared during startup.`);
    if (record.promise) await record.promise;
    return { id, record };
  }

  /** Current manager starts synchronously; retained for the nested tool contract. */
  async awaitStartup(_id: string): Promise<void> {}

  abort(id: string): boolean {
    const record = this.agents.get(id);
    if (!record) return false;

    // Remove from queue if queued
    if (record.status === "queued") {
      this.queue = this.queue.filter(q => q.id !== id);
      record.status = "stopped";
      record.completedAt = Date.now();
      this.flushOutput(record);
      this.checkpoint(record);
      return true;
    }

    if (record.status !== "running") return false;
    record.abortController?.abort();
    record.status = "stopped";
    record.completedAt = Date.now();
    this.flushOutput(record);
    this.checkpoint(record);
    this.finishBackground(id);
    this.drainQueue();
    return true;
  }

  /** Dispose a record's volatile runtime handles and remove it from the map. */
  private removeRecord(id: string, record: AgentRecord): void {
    this.flushOutput(record);
    try { record.session?.dispose?.(); } catch { /* cleanup is best effort */ }
    record.session = undefined;
    record.abortController = undefined;
    record.promise = undefined;
    if (record.liveActivity) record.liveActivity.session = undefined;
    this.reconstructedWorktrees.delete(id);
    this.agents.delete(id);
  }

  private retainTerminalStub(record: AgentRecord): void {
    this.flushOutput(record);
    try { record.session?.dispose?.(); } catch { /* cleanup is best effort */ }
    record.session = undefined;
    record.abortController = undefined;
    record.promise = undefined;
    record.outputFile = undefined;
    record.historyFile = undefined;
    record.worktree = undefined;
    if (record.liveActivity) record.liveActivity.session = undefined;
    record.result = undefined;
    this.checkpoint(record);
  }

  private cleanup() {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [id, record] of this.agents) {
      if (record.status === "running" || record.status === "queued") continue;
      if ((record.completedAt ?? 0) >= cutoff) continue;
      // Private v2 records remain executable even when their display transcript
      // is absent. Explicit and memory sessions retain only their display stub.
      const retain = record.sessionState?.kind === "private" || record.transcriptPath !== undefined;
      if (retain) this.retainTerminalStub(record);
      else this.removeRecord(id, record);
    }
  }

  /**
   * Remove all completed/stopped/errored records immediately.
   * Called on session start/switch so tasks from a prior session don't persist.
   * Pass skipUnconsumed=true to preserve records the LLM hasn't read yet
   * (resultConsumed=false) — they will be evicted by the 10-minute cleanup timer instead.
   */
  clearCompleted(skipUnconsumed = false): void {
    for (const [id, record] of this.agents) {
      if (record.status === "running" || record.status === "queued") continue;
      if (skipUnconsumed && !record.resultConsumed) continue;
      this.removeRecord(id, record);
    }
  }

  /** Whether any agents are still running or queued. */
  hasRunning(): boolean {
    return [...this.agents.values()].some(
      r => r.status === "running" || r.status === "queued",
    );
  }

  /** Abort all running and queued agents immediately. */
  abortAll(): number {
    let count = 0;
    // Clear queued agents first
    for (const queued of this.queue) {
      const record = this.agents.get(queued.id);
      if (record) {
        record.status = "stopped";
        record.completedAt = Date.now();
        this.flushOutput(record);
        this.checkpoint(record);
        count++;
      }
    }
    this.queue = [];
    // Abort running agents. Flush before checkpointing so a catchable
    // shutdown/session switch leaves the latest assistant message available.
    for (const record of this.agents.values()) {
      if (record.status === "running") {
        record.abortController?.abort();
        record.status = "stopped";
        record.completedAt = Date.now();
        this.flushOutput(record);
        this.finishBackground(record.id);
        this.checkpoint(record);
        count++;
      }
    }
    return count;
  }

  /** Wait for all running and queued agents to complete (including queued ones). */
  async waitForAll(): Promise<void> {
    // Loop because drainQueue respects the concurrency limit — as running
    // agents finish they start queued ones, which need awaiting too.
    while (true) {
      this.drainQueue();
      const pending = [...this.agents.values()]
        .filter(r => r.status === "running" || r.status === "queued")
        .map(r => r.promise)
        .filter(Boolean);
      if (pending.length === 0) break;
      await Promise.allSettled(pending);
    }
  }

  dispose() {
    clearInterval(this.cleanupInterval);
    for (const id of this.reconstructedWorktrees.keys()) this.removeReconstructedWorktree(id);
    // Clear queue
    this.queue = [];
    for (const record of this.agents.values()) {
      // Keep the latest openable checkpoint even when dispose() is called
      // without the host's normal session_shutdown abortAll hook.
      this.flushOutput(record);
      this.checkpoint(record);
      try { record.session?.dispose?.(); } catch { /* cleanup is best effort */ }
      record.session = undefined;
      record.abortController = undefined;
      record.promise = undefined;
      record.outputFile = undefined;
      record.historyFile = undefined;
      record.worktree = undefined;
      if (record.liveActivity) record.liveActivity.session = undefined;
      record.result = undefined;
      this.checkpoint(record);
    }
    this.agents.clear();
    this.recoveryCwds.clear();
    this.displayOnlyCheckpointIds.clear();
    this.runningBackgroundIds.clear();
    this.reconstructedWorktrees.clear();
    this.runningBackground = 0;
    // Prune any orphaned git worktrees (crash recovery)
    try { pruneWorktrees(process.cwd()); } catch { /* ignore */ }
    // Also prune repos that caller-supplied cwds created worktrees in — a clean
    // exit with in-flight agents would otherwise leave stale registrations there.
    for (const repo of this.worktreeRepos) {
      try { pruneWorktrees(repo); } catch { /* ignore */ }
    }
  }
}
