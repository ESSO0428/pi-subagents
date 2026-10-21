/** Current-session Agent conversations tree used by `/agents`. */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Key,
  matchesKey,
  type TUI,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import type { AgentViewMode } from "../agent-history-list.js";
import {
  type AgentTreeKey,
  type AgentTreeProjection,
  type AgentTreeRow,
  navigateAgentTree,
  projectAgentTree,
  type WorkflowTreeRoot,
} from "../agent-tree.js";
import type { AgentRecord } from "../types.js";
import { getLifetimeTotal } from "../usage.js";
import {
  describeActivity,
  formatDuration,
  formatMs,
  formatTokens,
  type Theme,
} from "./agent-widget.js";

const DEFAULT_VISIBLE_ROWS = 10;

export interface AgentTreeMenuSource {
  agents: readonly AgentRecord[];
  workflowRoots: readonly WorkflowTreeRoot[];
  sessionId?: string;
  resolveViewMode(record: AgentRecord): AgentViewMode | undefined;
}

export interface AgentTreeMenuState {
  selectedKey: AgentTreeKey | undefined;
  selectedIndex: number;
  viewportStart: number;
  collapsedKeys: Set<AgentTreeKey>;
}

export type AgentTreeMenuSelection =
  | { kind: "workflow"; id: string }
  | { kind: "agent"; id: string; mode: AgentViewMode };

export function createAgentTreeMenuState(): AgentTreeMenuState {
  return {
    selectedKey: undefined,
    selectedIndex: 0,
    viewportStart: 0,
    collapsedKeys: new Set(),
  };
}

function projectionFor(
  source: AgentTreeMenuSource,
  collapsedKeys: ReadonlySet<AgentTreeKey>,
): AgentTreeProjection {
  return projectAgentTree({
    agents: source.agents,
    workflowRoots: source.workflowRoots,
    sessionId: source.sessionId,
    collapsedKeys,
    canOpenTerminalAgent: record => source.resolveViewMode(record) === "history",
  });
}

function rowPrefix(row: AgentTreeRow): string {
  const ancestors = row.ancestorContinues
    .map(continues => continues ? "│  " : "   ")
    .join("");
  return `${ancestors}${row.isLast ? "└─ " : "├─ "}`;
}

function statusIcon(status: string): string {
  if (status === "running") return "●";
  if (status === "queued") return "◦";
  if (status === "completed") return "✓";
  if (status === "paused") return "Ⅱ";
  if (status === "stopped" || status === "killed") return "■";
  return "✗";
}

/** Stateful TUI shell around the shared, pure Agent Tree projection. */
export class AgentTreeMenu implements Component {
  constructor(
    private tui: TUI,
    private theme: Partial<Theme>,
    private source: () => AgentTreeMenuSource,
    private state: AgentTreeMenuState,
    private done: (selection: AgentTreeMenuSelection | undefined) => void,
    private visibleRows = DEFAULT_VISIBLE_ROWS,
  ) {}

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) {
      this.done(undefined);
      return;
    }

    const direction = matchesKey(data, "up")
      ? "up"
      : matchesKey(data, "down")
        ? "down"
        : matchesKey(data, "left")
          ? "left"
          : matchesKey(data, "right")
            ? "right"
            : undefined;
    if (direction !== undefined) {
      const projection = this.resolveProjection();
      const navigation = navigateAgentTree(
        projection,
        this.state.selectedKey,
        this.state.collapsedKeys,
        direction,
      );
      this.state.selectedKey = navigation.selectedKey;
      this.state.collapsedKeys = new Set(navigation.collapsedKeys);
      this.resolveProjection();
      this.tui.requestRender?.();
      return;
    }

    if (!matchesKey(data, Key.enter)) return;
    const source = this.source();
    const projection = projectionFor(source, this.state.collapsedKeys);
    const row = projection.rows.find(candidate => candidate.key === this.state.selectedKey);
    if (row?.node.kind === "workflow") {
      this.done({ kind: "workflow", id: row.node.root.id });
      return;
    }
    if (row?.node.kind === "agent") {
      const mode = source.resolveViewMode(row.node.record);
      if (mode !== undefined) {
        this.done({ kind: "agent", id: row.node.record.id, mode });
      }
    }
  }

  render(width: number): string[] {
    const projection = this.resolveProjection();
    const rows = projection.rows;
    const capacity = Math.max(1, Math.trunc(this.visibleRows));
    const start = this.state.viewportStart;
    const end = Math.min(rows.length, start + capacity);
    const fg = (color: string, text: string) => this.theme.fg?.(color, text) ?? text;
    const bold = (text: string) => this.theme.bold?.(text) ?? text;
    const lines = [truncateToWidth(bold("Agent conversations this session"), width)];

    if (start > 0) {
      lines.push(truncateToWidth(fg("dim", `↑ ${start} more`), width));
    }

    for (let index = start; index < end; index++) {
      const row = rows[index];
      const selected = row.key === this.state.selectedKey;
      const marker = selected ? fg("accent", "→") : " ";
      const disclosure = row.hasChildren ? (row.expanded ? "▾" : "▸") : " ";
      const prefix = fg("dim", rowPrefix(row));
      if (row.node.kind === "workflow") {
        const root = row.node.root;
        const progress = `${root.doneCount}/${root.agentCount} done`;
        const elapsed = formatMs((root.completedAt ?? Date.now()) - root.startedAt);
        lines.push(truncateToWidth(
          `${prefix}${marker} ${disclosure} ${statusIcon(root.status)} ${bold("workflow")}  `
          + `${root.description || root.name} · ${root.status} · ${progress} · `
          + `${formatTokens(root.tokens)} · ${elapsed}`,
          width,
        ));
      } else {
        const record = row.node.record;
        const orphan = row.orphaned
          ? row.cycle ? " · parent cycle" : " · parent gone"
          : "";
        const invocation = record.invocation;
        const effectiveModel = record.session?.model?.name
          ?? record.session?.model?.id
          ?? invocation?.effectiveModelName;
        const requestedModel = invocation?.modelName;
        const effectiveThinking = record.session?.thinkingLevel
          ?? invocation?.effectiveThinking
          ?? invocation?.thinking;
        const requestedThinking = invocation?.thinking;
        const tokens = getLifetimeTotal(record.lifetimeUsage);
        const metadata = [
          ...(effectiveModel ? [`model: ${effectiveModel}`] : []),
          ...(requestedModel && requestedModel !== effectiveModel
            ? [`requested model: ${requestedModel}`]
            : []),
          ...(effectiveThinking ? [`thinking: ${effectiveThinking}`] : []),
          ...(requestedThinking && requestedThinking !== effectiveThinking
            ? [`requested thinking: ${requestedThinking}`]
            : []),
          `${record.toolUses} tool use${record.toolUses === 1 ? "" : "s"}`,
          formatTokens(tokens),
          formatDuration(record.startedAt, record.completedAt),
          ...(record.liveActivity
            ? [`activity: ${describeActivity(record.liveActivity.activeTools, record.liveActivity.responseText)}`]
            : []),
        ].join(" · ");
        lines.push(truncateToWidth(
          `${prefix}${marker} ${disclosure} ${statusIcon(record.status)} ${bold(record.type)}  `
          + `${record.description} · ${record.status} · ${metadata}${orphan}`,
          width,
        ));
      }
    }

    if (end < rows.length) {
      lines.push(truncateToWidth(fg("dim", `↓ ${rows.length - end} more`), width));
    }
    if (rows.length === 0) lines.push(fg("dim", "No conversations in this session."));
    lines.push(fg("dim", "↑↓ select · ←→ fold · enter view · esc back"));
    return lines;
  }

  invalidate(): void {
    /* no cached rendering state */
  }

  private resolveProjection(): AgentTreeProjection {
    const projection = projectionFor(this.source(), this.state.collapsedKeys);
    const rows = projection.rows;
    if (rows.length === 0) {
      this.state.selectedKey = undefined;
      this.state.selectedIndex = 0;
      this.state.viewportStart = 0;
      return projection;
    }

    const remembered = this.state.selectedKey === undefined
      ? -1
      : rows.findIndex(row => row.key === this.state.selectedKey);
    this.state.selectedIndex = remembered >= 0
      ? remembered
      : Math.max(0, Math.min(this.state.selectedIndex, rows.length - 1));
    this.state.selectedKey = rows[this.state.selectedIndex].key;

    const capacity = Math.max(1, Math.trunc(this.visibleRows));
    const maxStart = Math.max(0, rows.length - capacity);
    let start = Math.max(0, Math.min(this.state.viewportStart, maxStart));
    if (this.state.selectedIndex < start) start = this.state.selectedIndex;
    if (this.state.selectedIndex >= start + capacity) {
      start = this.state.selectedIndex - capacity + 1;
    }
    this.state.viewportStart = Math.max(0, Math.min(start, maxStart));
    return projection;
  }
}

/** Open one current-session tree modal. The caller owns modal-depth focus. */
export function showAgentTreeMenu(
  ctx: ExtensionCommandContext,
  source: () => AgentTreeMenuSource,
  state: AgentTreeMenuState,
): Promise<AgentTreeMenuSelection | undefined> {
  return ctx.ui.custom<AgentTreeMenuSelection | undefined>(
    (tui, theme, _keybindings, done) =>
      new AgentTreeMenu(tui, theme, source, state, done),
  );
}
