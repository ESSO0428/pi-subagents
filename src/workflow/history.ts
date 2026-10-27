/** Durable, display-only history for terminal workflow runs. */

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { canonicalArtifactRootCwd } from "../agent-session-storage.js";
import type { WorkflowTreeRoot } from "../types.js";
import type { WorkflowMeta } from "./meta.js";
import type { WorkflowEntry, WorkflowRunStatus } from "./progress.js";
import type { WorkflowTask } from "./task.js";

export const WORKFLOW_HISTORY_VERSION = 1 as const;
export const WORKFLOW_HISTORY_RELATIVE_DIR = ".pi-subagents/workflow-history/v1";
export const WORKFLOW_HISTORY_MAX_ENTRIES = 100;
export const WORKFLOW_HISTORY_MAX_BYTES = 512 * 1024;

const WORKFLOW_ID = /^wf_[a-z0-9-]{6,}$/;
const MAX_NAME_LENGTH = 500;
const MAX_DETAIL_LENGTH = 1_000;
const MAX_PREVIEW_LENGTH = 4_000;
const MAX_AGENT_PREVIEW_LENGTH = 400;
const MAX_PHASES = 100;
const MAX_AGENTS = 1_000;
const MAX_LOGS = 200;
const MAX_LOG_LENGTH = 1_000;
const TERMINAL_STATUSES = new Set<WorkflowRunStatus>(["completed", "failed", "killed"]);

export interface WorkflowHistoryPhase {
  title: string;
  detail?: string;
  model?: string;
}

export interface WorkflowHistorySnapshot {
  version: typeof WORKFLOW_HISTORY_VERSION;
  workflowId: string;
  artifactRootCwd: string;
  /** Root Pi session that started the workflow; absent means history-only. */
  rootSessionId?: string;
  name: string;
  description: string;
  status: "completed" | "failed" | "killed";
  startedAt: number;
  completedAt: number;
  progress: WorkflowEntry[];
  agentCount: number;
  doneCount: number;
  totalTokens: number;
  totalToolCalls: number;
  resultPreview?: string;
  errorPreview?: string;
  meta?: {
    name: string;
    description: string;
    phases?: WorkflowHistoryPhase[];
  };
}

export class WorkflowHistoryStorageError extends Error {}

function fail(message: string): never {
  throw new WorkflowHistoryStorageError(message);
}

function isTerminalStatus(status: unknown): status is WorkflowHistorySnapshot["status"] {
  return typeof status === "string" && TERMINAL_STATUSES.has(status as WorkflowRunStatus)
    ? status === "completed" || status === "failed" || status === "killed"
    : false;
}

function safeText(value: string, limit: number): string {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u001B]/g, "")
    .slice(0, limit);
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function safeStoredText(value: unknown, limit: number): value is string {
  return typeof value === "string"
    && value.length <= limit
    && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u001B]/.test(value);
}

function safeSessionId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && safeStoredText(value, 256);
}

function safeInteger(value: unknown): value is number {
  return Number.isInteger(value) && finiteNonNegative(value);
}

function optionalNumber(value: unknown): number | undefined {
  return finiteNonNegative(value) ? value : undefined;
}

function optionalInteger(value: unknown): number | undefined {
  return safeInteger(value) ? value : undefined;
}

function allowedKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every(key => allowed.has(key));
}

function assertWorkflowId(id: string): void {
  if (typeof id !== "string" || !WORKFLOW_ID.test(id)) fail("workflow id is invalid");
}

function assertHistoryDirectoryPath(root: string, path: string): void {
  const canonicalRoot = canonicalArtifactRootCwd(root);
  const expected = join(canonicalRoot, WORKFLOW_HISTORY_RELATIVE_DIR);
  if (path !== expected || !path.startsWith(`${canonicalRoot}${sep}`)) {
    fail("workflow history path escaped its artifact root");
  }
}

function assertDirectory(path: string, label: string): void {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch {
    fail(`${label} is missing`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail(`${label} must be a non-symlink directory`);
}

function ensureDirectory(parent: string, name: string, label: string): string {
  const path = join(parent, name);
  if (existsSync(path)) {
    assertDirectory(path, label);
    return path;
  }
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch {
    fail(`could not create ${label}`);
  }
  assertDirectory(path, label);
  return path;
}

function historyDirectory(root: string, create: boolean): string | undefined {
  const canonicalRoot = canonicalArtifactRootCwd(root);
  assertDirectory(canonicalRoot, "artifact root");
  const subagents = create
    ? ensureDirectory(canonicalRoot, ".pi-subagents", ".pi-subagents")
    : join(canonicalRoot, ".pi-subagents");
  if (!create && !existsSync(subagents)) return undefined;
  assertDirectory(subagents, ".pi-subagents");

  const workflowHistory = create
    ? ensureDirectory(subagents, "workflow-history", "workflow history namespace")
    : join(subagents, "workflow-history");
  if (!create && !existsSync(workflowHistory)) return undefined;
  assertDirectory(workflowHistory, "workflow history namespace");

  const version = create
    ? ensureDirectory(workflowHistory, "v1", "workflow history version namespace")
    : join(workflowHistory, "v1");
  if (!create && !existsSync(version)) return undefined;
  assertDirectory(version, "workflow history version namespace");

  let real: string;
  try {
    real = realpathSync(version);
  } catch {
    fail("workflow history namespace is unavailable");
  }
  if (real !== version) fail("workflow history namespace escaped its lexical path");
  assertHistoryDirectoryPath(canonicalRoot, version);
  return version;
}

function snapshotPath(root: string, workflowId: string, create = false): string {
  assertWorkflowId(workflowId);
  const directory = historyDirectory(root, create);
  if (directory === undefined) fail("workflow history namespace is unavailable");
  const path = join(directory, `${workflowId}.json`);
  const child = relative(directory, path);
  if (child !== `${workflowId}.json` || child.includes(sep) || !isAbsolute(directory)) {
    fail("workflow history snapshot path escaped its namespace");
  }
  return path;
}

function sanitizePhase(phase: NonNullable<WorkflowMeta["phases"]>[number]): WorkflowHistoryPhase {
  return {
    title: safeText(phase.title, MAX_NAME_LENGTH),
    ...(phase.detail !== undefined ? { detail: safeText(phase.detail, MAX_DETAIL_LENGTH) } : {}),
    ...(phase.model !== undefined ? { model: safeText(phase.model, MAX_NAME_LENGTH) } : {}),
  };
}

const AGENT_KEYS = [
  "type", "index", "label", "phaseIndex", "phaseTitle", "state", "agentType", "model", "modelId",
  "thinking", "requestedThinking", "requestedModel", "fallbackModel", "isolation", "error", "skipped",
  "blocked", "cached", "queuedAt", "startedAt", "lastProgressAt", "attempt", "lastAttemptReason",
  "promptPreview", "resultPreview", "tokens", "toolCalls", "durationMs",
] as const;

function sanitizeAgent(entry: Extract<WorkflowEntry, { type: "workflow_agent" }>): Extract<WorkflowEntry, { type: "workflow_agent" }> {
  const out: Extract<WorkflowEntry, { type: "workflow_agent" }> = {
    type: "workflow_agent",
    index: entry.index,
    label: safeText(entry.label, MAX_NAME_LENGTH),
    state: entry.state,
  };
  if (entry.phaseIndex !== undefined) out.phaseIndex = entry.phaseIndex;
  if (entry.phaseTitle !== undefined) out.phaseTitle = safeText(entry.phaseTitle, MAX_NAME_LENGTH);
  for (const key of ["agentType", "model", "modelId", "thinking", "requestedThinking", "requestedModel", "fallbackModel"] as const) {
    const value = entry[key];
    if (value !== undefined) out[key] = safeText(value, MAX_NAME_LENGTH);
  }
  if (entry.isolation === "worktree") out.isolation = entry.isolation;
  if (entry.error !== undefined) out.error = safeText(entry.error, MAX_PREVIEW_LENGTH);
  for (const key of ["skipped", "blocked", "cached"] as const) {
    if (entry[key] !== undefined) out[key] = entry[key];
  }
  for (const key of ["queuedAt", "startedAt", "lastProgressAt", "tokens", "toolCalls", "durationMs"] as const) {
    const value = optionalNumber(entry[key]);
    if (value !== undefined) out[key] = value;
  }
  if (entry.attempt !== undefined) out.attempt = optionalInteger(entry.attempt);
  if (entry.lastAttemptReason !== undefined) out.lastAttemptReason = entry.lastAttemptReason;
  if (entry.promptPreview !== undefined) out.promptPreview = safeText(entry.promptPreview, MAX_AGENT_PREVIEW_LENGTH);
  if (entry.resultPreview !== undefined) out.resultPreview = safeText(entry.resultPreview, MAX_AGENT_PREVIEW_LENGTH);
  return out;
}

function boundedProgress(progress: readonly WorkflowEntry[]): WorkflowEntry[] {
  const phases = new Map<number, Extract<WorkflowEntry, { type: "workflow_phase" }>>();
  const agents = new Map<number, Extract<WorkflowEntry, { type: "workflow_agent" }>>();
  const logs: Extract<WorkflowEntry, { type: "workflow_log" }>[] = [];
  for (const entry of progress) {
    if (entry.type === "workflow_phase") {
      if (safeInteger(entry.index)) phases.set(entry.index, {
        type: "workflow_phase",
        index: entry.index,
        title: safeText(entry.title, MAX_NAME_LENGTH),
      });
    } else if (entry.type === "workflow_agent") {
      if (safeInteger(entry.index)) agents.set(entry.index, sanitizeAgent(entry));
    } else {
      logs.push({ type: "workflow_log", message: safeText(entry.message, MAX_LOG_LENGTH) });
    }
  }
  const entries: WorkflowEntry[] = [
    ...[...phases.values()].sort((a, b) => a.index - b.index).slice(0, MAX_PHASES),
    ...[...agents.values()].sort((a, b) => a.index - b.index).slice(0, MAX_AGENTS),
    ...logs.slice(-MAX_LOGS),
  ];
  return entries.slice(0, MAX_AGENTS + MAX_PHASES + MAX_LOGS);
}

function boundedMeta(meta: WorkflowMeta | undefined): WorkflowHistorySnapshot["meta"] | undefined {
  if (meta === undefined) return undefined;
  return {
    name: safeText(meta.name, MAX_NAME_LENGTH),
    description: safeText(meta.description, MAX_DETAIL_LENGTH),
    ...(meta.phases !== undefined
      ? { phases: meta.phases.slice(0, MAX_PHASES).map(sanitizePhase) }
      : {}),
  };
}

export function workflowHistoryPath(root: string, workflowId: string): string {
  return snapshotPath(root, workflowId, false);
}

export function workflowHistorySnapshot(task: WorkflowTask, artifactRootCwd: string): WorkflowHistorySnapshot | undefined {
  if (!isTerminalStatus(task.status) || task.endTime === undefined) return undefined;
  assertWorkflowId(task.id);
  const root = canonicalArtifactRootCwd(artifactRootCwd);
  const name = safeText(task.workflowName ?? task.meta?.name ?? task.id, MAX_NAME_LENGTH);
  const description = safeText(task.meta?.description ?? task.workflowName ?? task.id, MAX_DETAIL_LENGTH);
  const result = workflowResultPreview(task);
  const snapshot: WorkflowHistorySnapshot = {
    version: WORKFLOW_HISTORY_VERSION,
    workflowId: task.id,
    artifactRootCwd: root,
    ...(task.rootSessionId !== undefined ? { rootSessionId: safeText(task.rootSessionId, 256) } : {}),
    name,
    description,
    status: task.status,
    startedAt: task.startTime,
    completedAt: task.endTime,
    progress: boundedProgress(task.workflowProgress),
    agentCount: Math.max(0, Math.trunc(task.agentCount)),
    doneCount: Math.max(0, Math.trunc(task.doneCount)),
    totalTokens: Math.max(0, task.totalTokens),
    totalToolCalls: Math.max(0, task.totalToolCalls),
    ...(result.resultPreview !== undefined ? { resultPreview: result.resultPreview } : {}),
    ...(result.errorPreview !== undefined ? { errorPreview: result.errorPreview } : {}),
    ...(boundedMeta(task.meta) !== undefined ? { meta: boundedMeta(task.meta) } : {}),
  };
  return snapshot;
}

function workflowResultPreview(task: WorkflowTask): { resultPreview?: string; errorPreview?: string } {
  if (task.error !== undefined) return { errorPreview: safeText(task.error, MAX_PREVIEW_LENGTH) };
  if (task.value === undefined) return { resultPreview: "No output." };
  if (typeof task.value === "string") return { resultPreview: safeText(task.value, MAX_PREVIEW_LENGTH) };
  try {
    return { resultPreview: safeText(JSON.stringify(task.value, null, 2), MAX_PREVIEW_LENGTH) };
  } catch {
    return { resultPreview: "[unavailable]" };
  }
}

export function writeWorkflowHistorySnapshot(
  task: WorkflowTask,
  artifactRootCwd: string,
): WorkflowHistorySnapshot | undefined {
  const snapshot = workflowHistorySnapshot(task, artifactRootCwd);
  if (snapshot === undefined) return undefined;
  const path = snapshotPath(snapshot.artifactRootCwd, snapshot.workflowId, true);
  let existing: ReturnType<typeof lstatSync> | undefined;
  try {
    existing = lstatSync(path);
  } catch {
    existing = undefined;
  }
  if (existing?.isSymbolicLink()) fail("workflow history snapshot is a symlink");
  if (existing !== undefined) {
    if (!existing.isFile()) fail("workflow history snapshot must be a regular file");
    return snapshot;
  }

  const encoded = `${JSON.stringify(snapshot)}\n`;
  if (Buffer.byteLength(encoded, "utf8") > WORKFLOW_HISTORY_MAX_BYTES) {
    fail("workflow history snapshot is oversized");
  }
  const temporary = join(dirname(path), `.${snapshot.workflowId}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, encoded, { encoding: "utf8", mode: 0o600, flag: "wx" });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* best effort */ }
    throw error;
  }
  pruneWorkflowHistory(snapshot.artifactRootCwd);
  return snapshot;
}

function parseSnapshot(raw: string, expectedRoot: string, expectedId?: string): WorkflowHistorySnapshot | undefined {
  if (Buffer.byteLength(raw, "utf8") > WORKFLOW_HISTORY_MAX_BYTES) return undefined;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return undefined; }
  try { return validateSnapshot(value, expectedRoot, expectedId); } catch { return undefined; }
}

function validateSnapshot(value: unknown, expectedRoot: string, expectedId?: string): WorkflowHistorySnapshot | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const source = value as Record<string, unknown>;
  const root = canonicalArtifactRootCwd(expectedRoot);
  const allowed = [
    "version", "workflowId", "artifactRootCwd", "rootSessionId", "name", "description", "status", "startedAt", "completedAt",
    "progress", "agentCount", "doneCount", "totalTokens", "totalToolCalls", "resultPreview", "errorPreview", "meta",
  ] as const;
  if (!allowedKeys(source, allowed)) return undefined;
  if (source.version !== WORKFLOW_HISTORY_VERSION
    || typeof source.workflowId !== "string"
    || !WORKFLOW_ID.test(source.workflowId)
    || (expectedId !== undefined && source.workflowId !== expectedId)
    || typeof source.artifactRootCwd !== "string"
    || !isAbsolute(source.artifactRootCwd)
    || canonicalArtifactRootCwd(source.artifactRootCwd) !== root
    || (source.rootSessionId !== undefined && !safeSessionId(source.rootSessionId))
    || !safeStoredText(source.name, MAX_NAME_LENGTH)
    || !safeStoredText(source.description, MAX_DETAIL_LENGTH)
    || !isTerminalStatus(source.status)
    || !finiteNonNegative(source.startedAt)
    || !finiteNonNegative(source.completedAt)
    || source.completedAt < source.startedAt
    || !Array.isArray(source.progress)
    || !safeInteger(source.agentCount)
    || !safeInteger(source.doneCount)
    || !finiteNonNegative(source.totalTokens)
    || !finiteNonNegative(source.totalToolCalls)
    || (source.resultPreview !== undefined && !safeStoredText(source.resultPreview, MAX_PREVIEW_LENGTH))
    || (source.errorPreview !== undefined && !safeStoredText(source.errorPreview, MAX_PREVIEW_LENGTH))) {
    return undefined;
  }
  const progress = source.progress.filter(isSafeProgressEntry);
  if (progress.length !== source.progress.length) return undefined;
  const meta = source.meta === undefined ? undefined : validateMeta(source.meta);
  if (source.meta !== undefined && meta === undefined) return undefined;
  return {
    version: WORKFLOW_HISTORY_VERSION,
    workflowId: source.workflowId,
    artifactRootCwd: root,
    ...(source.rootSessionId !== undefined ? { rootSessionId: source.rootSessionId } : {}),
    name: source.name,
    description: source.description,
    status: source.status,
    startedAt: source.startedAt,
    completedAt: source.completedAt,
    progress,
    agentCount: source.agentCount,
    doneCount: source.doneCount,
    totalTokens: source.totalTokens,
    totalToolCalls: source.totalToolCalls,
    ...(source.resultPreview !== undefined ? { resultPreview: source.resultPreview } : {}),
    ...(source.errorPreview !== undefined ? { errorPreview: source.errorPreview } : {}),
    ...(meta !== undefined ? { meta } : {}),
  };
}

function validateMeta(value: unknown): WorkflowHistorySnapshot["meta"] | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const meta = value as Record<string, unknown>;
  if (!allowedKeys(meta, ["name", "description", "phases"]) || !safeStoredText(meta.name, MAX_NAME_LENGTH)
    || !safeStoredText(meta.description, MAX_DETAIL_LENGTH)
    || (meta.phases !== undefined && (!Array.isArray(meta.phases) || meta.phases.length > MAX_PHASES))) return undefined;
  const phases = meta.phases?.map(value => {
    if (typeof value !== "object" || value === null) return undefined;
    const phase = value as Record<string, unknown>;
    if (!allowedKeys(phase, ["title", "detail", "model"]) || !safeStoredText(phase.title, MAX_NAME_LENGTH)
      || (phase.detail !== undefined && !safeStoredText(phase.detail, MAX_DETAIL_LENGTH))
      || (phase.model !== undefined && !safeStoredText(phase.model, MAX_NAME_LENGTH))) return undefined;
    return {
      title: phase.title,
      ...(phase.detail !== undefined ? { detail: phase.detail } : {}),
      ...(phase.model !== undefined ? { model: phase.model } : {}),
    };
  });
  if (phases?.some(phase => phase === undefined)) return undefined;
  return {
    name: meta.name,
    description: meta.description,
    ...(phases !== undefined ? { phases: phases as WorkflowHistoryPhase[] } : {}),
  };
}

function isSafeProgressEntry(value: unknown): value is WorkflowEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  if (entry.type === "workflow_phase") {
    return allowedKeys(entry, ["type", "index", "title"])
      && safeInteger(entry.index)
      && safeStoredText(entry.title, MAX_NAME_LENGTH);
  }
  if (entry.type === "workflow_log") {
    return allowedKeys(entry, ["type", "message"])
      && safeStoredText(entry.message, MAX_LOG_LENGTH);
  }
  if (entry.type !== "workflow_agent" || !allowedKeys(entry, AGENT_KEYS)) return false;
  return safeInteger(entry.index)
    && safeStoredText(entry.label, MAX_NAME_LENGTH)
    && (entry.phaseIndex === undefined || safeInteger(entry.phaseIndex))
    && (entry.phaseTitle === undefined || safeStoredText(entry.phaseTitle, MAX_NAME_LENGTH))
    && (entry.state === "start" || entry.state === "progress" || entry.state === "done" || entry.state === "error")
    && (entry.agentType === undefined || safeStoredText(entry.agentType, MAX_NAME_LENGTH))
    && (entry.model === undefined || safeStoredText(entry.model, MAX_NAME_LENGTH))
    && (entry.modelId === undefined || safeStoredText(entry.modelId, MAX_NAME_LENGTH))
    && (entry.thinking === undefined || safeStoredText(entry.thinking, MAX_NAME_LENGTH))
    && (entry.requestedThinking === undefined || safeStoredText(entry.requestedThinking, MAX_NAME_LENGTH))
    && (entry.requestedModel === undefined || safeStoredText(entry.requestedModel, MAX_NAME_LENGTH))
    && (entry.fallbackModel === undefined || safeStoredText(entry.fallbackModel, MAX_NAME_LENGTH))
    && (entry.isolation === undefined || entry.isolation === "worktree")
    && (entry.error === undefined || safeStoredText(entry.error, MAX_PREVIEW_LENGTH))
    && (entry.skipped === undefined || typeof entry.skipped === "boolean")
    && (entry.blocked === undefined || typeof entry.blocked === "boolean")
    && (entry.cached === undefined || typeof entry.cached === "boolean")
    && (entry.queuedAt === undefined || finiteNonNegative(entry.queuedAt))
    && (entry.startedAt === undefined || finiteNonNegative(entry.startedAt))
    && (entry.lastProgressAt === undefined || finiteNonNegative(entry.lastProgressAt))
    && (entry.attempt === undefined || safeInteger(entry.attempt))
    && (entry.lastAttemptReason === undefined || entry.lastAttemptReason === "throttled" || entry.lastAttemptReason === "user-retry" || entry.lastAttemptReason === "stalled")
    && (entry.promptPreview === undefined || safeStoredText(entry.promptPreview, MAX_AGENT_PREVIEW_LENGTH))
    && (entry.resultPreview === undefined || safeStoredText(entry.resultPreview, MAX_AGENT_PREVIEW_LENGTH))
    && (entry.tokens === undefined || finiteNonNegative(entry.tokens))
    && (entry.toolCalls === undefined || finiteNonNegative(entry.toolCalls))
    && (entry.durationMs === undefined || finiteNonNegative(entry.durationMs));
}

function readSnapshotFile(root: string, path: string, expectedId: string): WorkflowHistorySnapshot | undefined {
  let stat: ReturnType<typeof lstatSync>;
  try { stat = lstatSync(path); } catch { return undefined; }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > WORKFLOW_HISTORY_MAX_BYTES) return undefined;
  let raw: string;
  try { raw = readFileSync(path, "utf8"); } catch { return undefined; }
  return parseSnapshot(raw, root, expectedId);
}

export function readWorkflowHistorySnapshot(root: string, workflowId: string): WorkflowHistorySnapshot | undefined {
  try {
    const path = snapshotPath(root, workflowId, false);
    return readSnapshotFile(root, path, workflowId);
  } catch {
    return undefined;
  }
}

export function loadWorkflowHistorySnapshots(root: string): WorkflowHistorySnapshot[] {
  let directory: string | undefined;
  try { directory = historyDirectory(root, false); } catch { return []; }
  if (directory === undefined) return [];
  let names: string[];
  try { names = readdirSync(directory); } catch { return []; }
  const snapshots: WorkflowHistorySnapshot[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -5);
    if (!WORKFLOW_ID.test(id)) continue;
    const snapshot = readSnapshotFile(root, join(directory, name), id);
    if (snapshot !== undefined) snapshots.push(snapshot);
  }
  return snapshots.sort((a, b) => b.completedAt - a.completedAt || b.startedAt - a.startedAt || a.workflowId.localeCompare(b.workflowId));
}

export function pruneWorkflowHistory(root: string): void {
  let directory: string | undefined;
  try { directory = historyDirectory(root, false); } catch { return; }
  if (directory === undefined) return;
  const snapshots = loadWorkflowHistorySnapshots(root);
  for (const snapshot of snapshots.slice(WORKFLOW_HISTORY_MAX_ENTRIES)) {
    const path = join(directory, `${snapshot.workflowId}.json`);
    try {
      const stat = lstatSync(path);
      if (!stat.isSymbolicLink() && stat.isFile()) unlinkSync(path);
    } catch {
      // A concurrent removal or unreadable entry is not a reason to leave the
      // rest of the valid, own-root history untouched.
    }
  }
}

export function toWorkflowHistoryTreeRoot(snapshot: WorkflowHistorySnapshot): WorkflowTreeRoot {
  return {
    artifactRootCwd: canonicalArtifactRootCwd(snapshot.artifactRootCwd),
    ...(snapshot.rootSessionId !== undefined ? { rootSessionId: snapshot.rootSessionId } : {}),
    id: snapshot.workflowId,
    name: snapshot.name,
    description: snapshot.description,
    status: snapshot.status,
    startedAt: snapshot.startedAt,
    completedAt: snapshot.completedAt,
    doneCount: snapshot.doneCount,
    agentCount: snapshot.agentCount,
    tokens: snapshot.totalTokens,
    restoredHistory: true,
  };
}
