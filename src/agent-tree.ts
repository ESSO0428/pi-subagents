/**
 * Framework-free projection and navigation for workflow roots and real agents.
 */

import { sameArtifactRootCwd } from "./agent-session-storage.js";
import type { AgentRecord, WidgetMode, WorkflowTreeRoot } from "./types.js";

export type { WorkflowTreeRoot } from "./types.js";

export type AgentTreeKey = `workflow:${string}` | `agent:${string}`;

export type AgentTreeNode =
  | {
      kind: "workflow";
      key: AgentTreeKey;
      root: WorkflowTreeRoot;
    }
  | {
      kind: "agent";
      key: AgentTreeKey;
      record: AgentRecord;
    };

export interface AgentTreeRow {
  key: AgentTreeKey;
  node: AgentTreeNode;
  depth: number;
  parentKey: AgentTreeKey | undefined;
  ancestorContinues: readonly boolean[];
  isLast: boolean;
  hasChildren: boolean;
  expanded: boolean;
  orphaned: boolean;
  cycle: boolean;
}

export interface AgentTreeProjection {
  /** Rows that are currently renderable and selectable, in preorder. */
  rows: readonly AgentTreeRow[];
}

export interface ProjectAgentTreeOptions {
  agents: readonly AgentRecord[];
  workflowRoots?: readonly WorkflowTreeRoot[];
  sessionId?: string;
  artifactRootCwd?: string;
  mode?: WidgetMode;
  collapsedKeys?: ReadonlySet<AgentTreeKey>;
  /** Called only for terminal real agents. Active agents are always openable. */
  canOpenTerminalAgent: (record: AgentRecord) => boolean;
}

export type AgentTreeDirection = "up" | "down" | "left" | "right";

export interface AgentTreeNavigation {
  selectedKey: AgentTreeKey | undefined;
  collapsedKeys: ReadonlySet<AgentTreeKey>;
}

type InternalNode = {
  node: AgentTreeNode;
  order: number;
  parentKey?: AgentTreeKey;
  candidateParentKey?: AgentTreeKey;
  orphaned: boolean;
  cycle: boolean;
  children: InternalNode[];
};

function rank(node: AgentTreeNode): number {
  const status = node.kind === "workflow" ? node.root.status : node.record.status;
  if (status === "running" || status === "paused") return 0;
  if (status === "queued") return 1;
  return 2;
}

function compare(a: InternalNode, b: InternalNode): number {
  return rank(a.node) - rank(b.node) || a.order - b.order;
}

function persistedArtifactRoot(record: AgentRecord): string | undefined {
  if (record.artifactRootCwd !== undefined) return record.artifactRootCwd;
  const state = record.sessionState;
  return state && state.kind !== "pending" ? state.artifactRootCwd : undefined;
}

function isVisibleWorkflowRoot(
  root: WorkflowTreeRoot,
  artifactRootCwd: string | undefined,
  sessionId: string | undefined,
): boolean {
  if (artifactRootCwd !== undefined
    && (root.artifactRootCwd === undefined || !sameArtifactRootCwd(root.artifactRootCwd, artifactRootCwd))) {
    return false;
  }
  return sessionId === undefined || root.rootSessionId === sessionId;
}

function isVisibleAgent(
  record: AgentRecord,
  options: ProjectAgentTreeOptions,
): boolean {
  if (!sameArtifactRootCwd(persistedArtifactRoot(record), options.artifactRootCwd)) return false;
  if (options.sessionId !== undefined && record.sessionId !== options.sessionId) return false;
  if (options.mode === "background" && record.parentAgentId === undefined && record.isBackground === false) {
    return false;
  }
  if (record.status === "running" || record.status === "queued") return true;
  return options.canOpenTerminalAgent(record) || record.sessionState?.kind === "private";
}

/**
 * Project workflow descriptors and real manager records into safe visible rows.
 *
 * Inputs are only read. Sorting, parent resolution, and cycle handling operate
 * on local nodes so callers can retain their arrays, records, and collapse set.
 */
export function projectAgentTree(options: ProjectAgentTreeOptions): AgentTreeProjection {
  if (options.mode === "off") return { rows: [] };

  const workflowRoots = (options.workflowRoots ?? [])
    .filter(root => isVisibleWorkflowRoot(root, options.artifactRootCwd, options.sessionId));
  const collapsedKeys = options.collapsedKeys ?? new Set<AgentTreeKey>();
  const workflowNodes = workflowRoots.map((root, index): InternalNode => ({
    node: { kind: "workflow", key: `workflow:${root.id}`, root },
    order: index,
    orphaned: false,
    cycle: false,
    children: [],
  }));
  const visibleAgents = options.agents.filter(record => isVisibleAgent(record, options));
  const agentNodes = visibleAgents.map((record, index): InternalNode => ({
    node: { kind: "agent", key: `agent:${record.id}`, record },
    order: workflowNodes.length + index,
    orphaned: false,
    cycle: false,
    children: [],
  }));

  const workflowById = new Map<string, InternalNode>();
  for (const entry of workflowNodes) {
    if (entry.node.kind === "workflow") workflowById.set(entry.node.root.id, entry);
  }
  const agentById = new Map<string, InternalNode>();
  for (const entry of agentNodes) {
    if (entry.node.kind === "agent") agentById.set(entry.node.record.id, entry);
  }
  const byKey = new Map<AgentTreeKey, InternalNode>();
  for (const entry of workflowNodes) byKey.set(entry.node.key, entry);
  for (const entry of agentNodes) byKey.set(entry.node.key, entry);

  for (const entry of agentNodes) {
    const node = entry.node;
    if (node.kind !== "agent" || node.record.parentAgentId === undefined) continue;
    const workflowParent = workflowById.get(node.record.parentAgentId);
    const agentParent = agentById.get(node.record.parentAgentId);
    entry.candidateParentKey = (workflowParent ?? agentParent)?.node.key;
  }

  const cycleKeys = new Set<AgentTreeKey>();
  const resolvedKeys = new Set<AgentTreeKey>();
  for (const start of agentNodes) {
    if (resolvedKeys.has(start.node.key)) continue;

    const path: InternalNode[] = [];
    const pathIndexes = new Map<AgentTreeKey, number>();
    let current: InternalNode | undefined = start;
    while (current !== undefined && current.node.kind === "agent" && !resolvedKeys.has(current.node.key)) {
      const cycleStart = pathIndexes.get(current.node.key);
      if (cycleStart !== undefined) {
        for (let index = cycleStart; index < path.length; index++) {
          cycleKeys.add(path[index].node.key);
        }
        break;
      }
      pathIndexes.set(current.node.key, path.length);
      path.push(current);
      const parent: InternalNode | undefined = current.candidateParentKey === undefined
        ? undefined
        : byKey.get(current.candidateParentKey);
      current = parent?.node.kind === "agent" ? parent : undefined;
    }
    for (const entry of path) resolvedKeys.add(entry.node.key);
  }

  const roots: InternalNode[] = [...workflowNodes];
  for (const entry of agentNodes) {
    const node = entry.node;
    if (node.kind !== "agent") continue;
    entry.cycle = cycleKeys.has(node.key);
    const declaredParent = node.record.parentAgentId;
    if (entry.cycle || (declaredParent !== undefined && entry.candidateParentKey === undefined)) {
      entry.orphaned = true;
      roots.push(entry);
      continue;
    }
    if (entry.candidateParentKey === undefined) {
      roots.push(entry);
      continue;
    }
    const parent = byKey.get(entry.candidateParentKey);
    if (parent === undefined) {
      entry.orphaned = true;
      roots.push(entry);
      continue;
    }
    entry.parentKey = parent.node.key;
    parent.children.push(entry);
  }

  roots.sort(compare);
  for (const entry of byKey.values()) entry.children.sort(compare);

  type PendingRow = {
    entry: InternalNode;
    depth: number;
    ancestorContinues: readonly boolean[];
    isLast: boolean;
  };
  const pending: PendingRow[] = [];
  for (let index = roots.length - 1; index >= 0; index--) {
    const entry = roots[index];
    let depth = 0;
    let ancestorContinues: readonly boolean[] = [];
    if (entry.orphaned && entry.node.kind === "agent") {
      depth = Math.max(1, entry.node.record.depth ?? 1);
      ancestorContinues = new Array(Math.max(0, depth - 1)).fill(true);
    }
    pending.push({ entry, depth, ancestorContinues, isLast: index === roots.length - 1 });
  }

  const rows: AgentTreeRow[] = [];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    const { entry, depth, ancestorContinues, isLast } = current;
    const hasChildren = entry.children.length > 0;
    const expanded = hasChildren && !collapsedKeys.has(entry.node.key);
    rows.push({
      key: entry.node.key,
      node: entry.node,
      depth,
      parentKey: entry.parentKey,
      ancestorContinues,
      isLast,
      hasChildren,
      expanded,
      orphaned: entry.orphaned,
      cycle: entry.cycle,
    });

    if (!expanded) continue;
    for (let index = entry.children.length - 1; index >= 0; index--) {
      pending.push({
        entry: entry.children[index],
        depth: depth + 1,
        ancestorContinues: [...ancestorContinues, !isLast],
        isLast: index === entry.children.length - 1,
      });
    }
  }

  return { rows };
}

/** Apply one tree-navigation key without mutating selection or collapse state. */
export function navigateAgentTree(
  projection: AgentTreeProjection,
  selectedKey: AgentTreeKey | undefined,
  collapsedKeys: ReadonlySet<AgentTreeKey>,
  direction: AgentTreeDirection,
): AgentTreeNavigation {
  const nextCollapsedKeys = new Set(collapsedKeys);
  const rows = projection.rows;
  if (rows.length === 0) {
    return { selectedKey: undefined, collapsedKeys: nextCollapsedKeys };
  }

  const selectedIndex = selectedKey === undefined
    ? -1
    : rows.findIndex(row => row.key === selectedKey);
  if (selectedIndex < 0) {
    return { selectedKey: rows[0].key, collapsedKeys: nextCollapsedKeys };
  }

  const selected = rows[selectedIndex];
  if (direction === "up") {
    return {
      selectedKey: rows[Math.max(0, selectedIndex - 1)].key,
      collapsedKeys: nextCollapsedKeys,
    };
  }
  if (direction === "down") {
    return {
      selectedKey: rows[Math.min(rows.length - 1, selectedIndex + 1)].key,
      collapsedKeys: nextCollapsedKeys,
    };
  }
  if (direction === "right") {
    if (selected.hasChildren && !selected.expanded) nextCollapsedKeys.delete(selected.key);
    return { selectedKey: selected.key, collapsedKeys: nextCollapsedKeys };
  }

  if (selected.hasChildren && selected.expanded) {
    nextCollapsedKeys.add(selected.key);
    return { selectedKey: selected.key, collapsedKeys: nextCollapsedKeys };
  }
  return {
    selectedKey: selected.parentKey ?? selected.key,
    collapsedKeys: nextCollapsedKeys,
  };
}
