/** Helpers for separating openable active agents from terminal history. */

import { hasAgentHistory } from "./agent-history.js";
import { getAgentConfig } from "./agent-types.js";
import type { AgentRecord } from "./types.js";
import { formatDuration, getDisplayName } from "./ui/agent-widget.js";

export type AgentHistoryStatus =
  | "completed"
  | "steered"
  | "stopped"
  | "aborted"
  | "error";

export type AgentViewMode = "live" | "history";

const TERMINAL_STATUSES: ReadonlySet<string> = new Set<AgentHistoryStatus>([
  "completed",
  "steered",
  "stopped",
  "aborted",
  "error",
]);

/** Return whether a record status represents a terminal agent run. */
export function isTerminalAgentStatus(status: string): status is AgentHistoryStatus {
  return TERMINAL_STATUSES.has(status);
}

/** Return whether an active record has a live session that can be opened. */
export function canOpenActiveAgent(record: AgentRecord): boolean {
  return (record.status === "running" || record.status === "queued")
    && record.session !== undefined;
}

/** Return whether a terminal record has an in-memory or durable conversation. */
export function canOpenAgentHistory(record: AgentRecord, cwd: string | undefined): boolean {
  if (!isTerminalAgentStatus(record.status)) return false;
  return record.session !== undefined
    || (cwd !== undefined && hasAgentHistory(cwd, record.transcriptPath));
}

/** Resolve the conversation surface a real agent can open, if any. */
export function resolveAgentViewMode(
  record: AgentRecord,
  cwd: string | undefined,
): AgentViewMode | undefined {
  if (canOpenActiveAgent(record)) return "live";
  if (canOpenAgentHistory(record, cwd)) return "history";
  return undefined;
}

/** Split records into openable active and terminal-history buckets. */
export function splitAgentRecords(
  records: readonly AgentRecord[],
  cwd: string | undefined,
): { active: AgentRecord[]; history: AgentRecord[] } {
  const active: AgentRecord[] = [];
  const history: AgentRecord[] = [];

  for (const record of records) {
    if (canOpenActiveAgent(record)) {
      active.push(record);
    } else if (canOpenAgentHistory(record, cwd)) {
      history.push(record);
    }
  }

  return { active, history };
}

const DESCRIPTION_LIMIT = 72;
const LABEL_LIMIT = 140;

function boundedDescription(description: string): string {
  const line = description.split("\n").find((part) => part.trim())?.trim() ?? "";
  if (line.length <= DESCRIPTION_LIMIT) return line;
  return `${line.slice(0, DESCRIPTION_LIMIT - 1)}…`;
}

/** Format a bounded, single-line history menu option. */
export function formatAgentHistoryOption(record: AgentRecord, now: number): string {
  const duration = formatDuration(record.startedAt, record.completedAt ?? now);
  // Unit consumers may format persisted records before the registry has been
  // initialized; preserve the persisted type instead of falling back to
  // general-purpose's generic display name in that case.
  const displayName = getAgentConfig(record.type)?.displayName
    ?? (record.type === "general-purpose" ? getDisplayName(record.type) : record.type);
  const option = `[${record.status}] ${displayName} · ${boundedDescription(record.description)} · ${duration}`;
  return option.length <= LABEL_LIMIT ? option : `${option.slice(0, LABEL_LIMIT - 1)}…`;
}

/** Count real agents admitted to the current-session tree projection. */
export function countSessionAgentConversations(
  records: readonly AgentRecord[],
  cwd: string | undefined,
  sessionId: string | undefined,
): number {
  if (sessionId === undefined) return 0;
  return records.filter(record => {
    if (record.sessionId !== sessionId) return false;
    if (record.status === "running" || record.status === "queued") return true;
    return canOpenAgentHistory(record, cwd);
  }).length;
}

/** Build the visible conversation/history labels for the agents menu. */
export function buildAgentStatusMenuEntries(
  records: readonly AgentRecord[],
  cwd: string | undefined,
  sessionId?: string,
  /** Recovered legacy records, already filtered to the openable ones. */
  legacy: readonly AgentRecord[] = [],
  /** A workflow root keeps the current-session tree reachable before its first child starts. */
  hasWorkflowRoots = false,
): string[] {
  const { history } = splitAgentRecords(records, cwd);
  const inSession = countSessionAgentConversations(records, cwd, sessionId);
  // Legacy records are merged into this list when it opens, so the count has to
  // include the ones the in-memory set does not already carry — otherwise the
  // menu advertises fewer entries than the list actually shows.
  const inMemory = new Set(history.map((record) => record.id));
  const allSessions = history.length + legacy.filter((record) => !inMemory.has(record.id)).length;
  return [
    ...(inSession > 0 || hasWorkflowRoots
      ? [`Agent conversations this session (${inSession})`]
      : []),
    ...(allSessions > 0 ? [`Agent history all sessions (${allSessions})`] : []),
  ];
}
