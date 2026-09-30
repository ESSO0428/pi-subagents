/**
 * wait-group.ts — Explicit, nonblocking completion wait groups.
 *
 * Unlike GroupJoinManager, wait groups never time out or partially deliver.
 * A group delivers exactly once after it has been sealed and every member has
 * reached a terminal state.
 */

import { randomUUID } from "node:crypto";
import type { AgentRecord } from "./types.js";

export const TERMINAL_AGENT_STATUSES = [
  "completed",
  "steered",
  "error",
  "stopped",
  "aborted",
] as const;

export type TerminalAgentStatus = (typeof TERMINAL_AGENT_STATUSES)[number];

export interface WaitGroupSnapshot {
  groupId: string;
  summary: string;
  agentIds: readonly string[];
  sealed: boolean;
  delivered: boolean;
}

type WaitGroup = {
  groupId: string;
  summary: string;
  agentIds: Set<string>;
  completedRecords: Map<string, AgentRecord>;
  sealed: boolean;
  delivered: boolean;
};

export type WaitGroupDeliveryCallback = (
  groupId: string,
  summary: string,
  records: AgentRecord[],
) => void;

function normalizeSummary(summary: string): string {
  const normalized = summary.trim();
  if (!normalized) throw new Error("Wait group summary must not be empty.");
  return normalized;
}

function createGroupId(): string {
  return `wait-${randomUUID().slice(0, 17)}`;
}

export function isTerminalAgentStatus(status: AgentRecord["status"]): status is TerminalAgentStatus {
  return (TERMINAL_AGENT_STATUSES as readonly string[]).includes(status);
}

export class WaitGroupManager {
  private groups = new Map<string, WaitGroup>();
  private agentToGroup = new Map<string, string>();

  constructor(private deliverCb: WaitGroupDeliveryCallback) {}

  create(summary: string, requestedGroupId?: string): string {
    const groupId = requestedGroupId?.trim() || createGroupId();
    if (!groupId) throw new Error("Wait group ID must not be empty.");
    if (this.groups.has(groupId)) throw new Error(`Wait group already exists: "${groupId}".`);

    this.groups.set(groupId, {
      groupId,
      summary: normalizeSummary(summary),
      agentIds: new Set(),
      completedRecords: new Map(),
      sealed: false,
      delivered: false,
    });
    return groupId;
  }

  update(groupId: string, summary: string): void {
    const group = this.requireGroup(groupId);
    if (group.delivered) throw new Error(`Wait group "${groupId}" has already delivered.`);
    group.summary = normalizeSummary(summary);
  }

  addAgent(groupId: string, agentId: string): void {
    const group = this.requireGroup(groupId);
    if (group.delivered) throw new Error(`Wait group "${groupId}" has already delivered.`);
    if (group.sealed) throw new Error(`Wait group "${groupId}" is already sealed.`);

    const existingGroupId = this.agentToGroup.get(agentId);
    if (existingGroupId && existingGroupId !== groupId) {
      throw new Error(`Agent "${agentId}" already belongs to wait group "${existingGroupId}".`);
    }

    group.agentIds.add(agentId);
    this.agentToGroup.set(agentId, groupId);
  }

  removeAgent(groupId: string, agentId: string): void {
    const group = this.groups.get(groupId);
    if (!group || group.delivered) return;
    group.agentIds.delete(agentId);
    group.completedRecords.delete(agentId);
    this.agentToGroup.delete(agentId);
    if (group.agentIds.size === 0 && !group.sealed) this.groups.delete(groupId);
  }

  /**
   * Seal a group. Returns true when this call delivered the group, otherwise
   * false when members are still running or it was already sealed.
   */
  seal(groupId: string): boolean {
    const group = this.requireGroup(groupId);
    if (group.delivered) return false;
    if (group.sealed) return false;
    group.sealed = true;
    return this.tryDeliver(group);
  }

  /** Register a terminal completion and deliver if the sealed group is ready. */
  onAgentComplete(record: AgentRecord): "pass" | "held" | "delivered" {
    const groupId = this.agentToGroup.get(record.id);
    if (!groupId) return "pass";

    const group = this.groups.get(groupId);
    if (!group) return "pass";
    if (!isTerminalAgentStatus(record.status)) return "held";
    if (group.delivered) return "delivered";

    group.completedRecords.set(record.id, record);
    return this.tryDeliver(group) ? "delivered" : "held";
  }

  hasGroup(groupId: string): boolean {
    return this.groups.has(groupId);
  }

  getGroup(groupId: string): WaitGroupSnapshot | undefined {
    const group = this.groups.get(groupId);
    if (!group) return undefined;
    return {
      groupId: group.groupId,
      summary: group.summary,
      agentIds: [...group.agentIds],
      sealed: group.sealed,
      delivered: group.delivered,
    };
  }

  /** Remove an empty implicit group when its spawn failed before registration. */
  discard(groupId: string): void {
    const group = this.groups.get(groupId);
    if (!group || group.agentIds.size > 0 || group.delivered) return;
    this.groups.delete(groupId);
  }

  isGrouped(agentId: string): boolean {
    return this.agentToGroup.has(agentId);
  }

  private requireGroup(groupId: string): WaitGroup {
    const group = this.groups.get(groupId);
    if (!group) throw new Error(`Wait group not found: "${groupId}".`);
    return group;
  }

  private tryDeliver(group: WaitGroup): boolean {
    if (group.delivered || !group.sealed || group.agentIds.size === 0) return false;
    if ([...group.agentIds].some(id => !group.completedRecords.has(id))) return false;

    group.delivered = true;
    // Preserve join order in the notification rather than completion order.
    const records = [...group.agentIds]
      .map(id => group.completedRecords.get(id))
      .filter((record): record is AgentRecord => record !== undefined);
    this.deliverCb(group.groupId, group.summary, records);
    for (const id of group.agentIds) {
      this.agentToGroup.delete(id);
    }
    this.groups.delete(group.groupId);
    return true;
  }

  dispose(): void {
    this.groups.clear();
    this.agentToGroup.clear();
  }
}
