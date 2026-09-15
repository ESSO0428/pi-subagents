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

/** Build the visible status-section labels for the agents menu. */
export function buildAgentStatusMenuEntries(
  records: readonly AgentRecord[],
  cwd: string | undefined,
): string[] {
  const { active, history } = splitAgentRecords(records, cwd);
  return [
    ...(active.length > 0 ? [`Running agents (${active.length})`] : []),
    ...(history.length > 0 ? [`Agent history (${history.length})`] : []),
  ];
}
