/**
 * agent-widget.ts — Persistent widget showing running/completed agents above the editor.
 *
 * Displays a tree of agents with animated spinners, live stats, and activity descriptions.
 * Uses the callback form of setWidget for themed rendering.
 */

import type { EditorComponent } from "@earendil-works/pi-tui";
import { isKeyRelease, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentManager } from "../agent-manager.js";
import {
  type AgentTreeKey,
  type AgentTreeProjection,
  type AgentTreeRow,
  navigateAgentTree,
  projectAgentTree,
  type WorkflowTreeRoot,
} from "../agent-tree.js";
import { getConfig } from "../agent-types.js";
import type { AgentInvocation, AgentRecord, SubagentType, WidgetMode } from "../types.js";
import { getLifetimeTotal, getSessionContextPercent, type LifetimeUsage, type SessionLike } from "../usage.js";

// ---- Constants ----

/** Maximum number of rendered lines before overflow collapse kicks in. */
export const MAX_WIDGET_LINES = 12;
/** Keep a small editor/input area visible below the above-editor widget. */
const MIN_EDITOR_LINES = 4;

/**
 * Derive the widget ceiling from the terminal height while retaining the
 * historical MAX_WIDGET_LINES ceiling. Very short terminals may have no room
 * for the widget; that is preferable to consuming the editor/input area.
 */
export function getWidgetLineBudget(rows: number): number {
  if (!Number.isFinite(rows)) return MAX_WIDGET_LINES;
  return Math.min(MAX_WIDGET_LINES, Math.max(0, Math.floor(rows) - MIN_EDITOR_LINES));
}

/** Braille spinner frames for animated running indicator. */
export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Statuses that indicate an error/non-success outcome (used for linger behavior and icon rendering). */
export const ERROR_STATUSES = new Set(["error", "aborted", "steered", "stopped"]);

type RequiredEditorComponent = Pick<EditorComponent, "getText" | "setText" | "handleInput" | "render" | "invalidate">;

/** Check the runtime contract shared by Pi editors and editor wrappers. */
function isEditorComponent(value: unknown): value is RequiredEditorComponent {
  if (value === null || typeof value !== "object") return false;
  const component = value as Partial<Record<keyof RequiredEditorComponent, unknown>>;
  return (["getText", "setText", "handleInput", "render", "invalidate"] as const)
    .every(method => typeof component[method] === "function");
}

/** Tool name → human-readable action for activity descriptions. */
const TOOL_DISPLAY: Record<string, string> = {
  read: "reading",
  bash: "running command",
  edit: "editing",
  write: "writing",
  grep: "searching",
  find: "finding files",
  ls: "listing",
};

// ---- Types ----

export type Theme = {
  fg(color: string, text: string): string;
  bold(text: string): string;
};

export type AgentWidgetOpenMode = "live" | "history" | "unavailable";
export type AgentWidgetOpenCallback = (record: AgentRecord, mode: AgentWidgetOpenMode) => void | Promise<void>;
export type AgentWidgetOptions = {
  canOpenHistory: (record: AgentRecord) => boolean;
  onOpen: AgentWidgetOpenCallback;
  /**
   * Current session id. The roster shows only agents belonging to it, so a
   * long-lived project directory does not fill the widget with work from other
   * sessions. Read live — the session id is only known once pi has started.
   * Nested children carry their parent's session id, so trees stay intact.
   */
  getSessionId?: () => string | undefined;
  /** Current artifact root. Records from another project stay out of every widget surface. */
  getArtifactRootCwd?: () => string | undefined;
  /** Workflow grouping roots for the current session; never conversations. */
  getWorkflowRoots?: () => WorkflowTreeRoot[];
  /** Open a root's inspector. Separate from `onOpen`, which opens a transcript. */
  onOpenWorkflow?: (id: string) => void | Promise<void>;
};

/** @deprecated Use AgentWidgetOpenMode. */
export type AgentOpenMode = AgentWidgetOpenMode;
/** @deprecated Use AgentWidgetOpenCallback. */
export type AgentOpenCallback = AgentWidgetOpenCallback;
/** @deprecated Use AgentWidgetOptions.canOpenHistory. */
export type AgentHistoryCapability = AgentWidgetOptions["canOpenHistory"];

export type UICtx = {
  setStatus(key: string, text: string | undefined): void;
  setWidget(
    key: string,
    content: undefined | ((tui: any, theme: Theme) => { render(): string[]; invalidate(): void }),
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
  onTerminalInput(handler: (data: string) => { consume?: boolean; data?: string } | undefined): () => void;
  getEditorText(): string;
};

/** Per-agent live activity state. */
export interface AgentActivity {
  activeTools: Map<string, string>;
  toolUses: number;
  responseText: string;
  session?: SessionLike;
  /** Current turn count. */
  turnCount: number;
  /** Effective max turns for this agent (undefined = unlimited). */
  maxTurns?: number;
  /** Lifetime usage breakdown — see LifetimeUsage docs. */
  lifetimeUsage: LifetimeUsage;
}

export interface AgentDetails {
  displayName: string;
  description: string;
  subagentType: string;
  toolUses: number;
  tokens: string;
  durationMs: number;
  status: "queued" | "running" | "completed" | "steered" | "aborted" | "stopped" | "error" | "background";
  /** Human-readable description of what the agent is currently doing. */
  activity?: string;
  /** Current spinner frame index (for animated running indicator). */
  spinnerFrame?: number;
  /** Short model name if different from parent (e.g. "haiku", "sonnet"). */
  modelName?: string;
  /** Notable config tags (e.g. ["thinking: high", "isolated"]). */
  tags?: string[];
  /** Current turn count. */
  turnCount?: number;
  /** Effective max turns (undefined = unlimited). */
  maxTurns?: number;
  agentId?: string;
  error?: string;
}

// ---- Formatting helpers ----

/** Apply foreground styling while restoring it after nested foreground/full ANSI resets. */
export function fgPreservingNestedStyles(theme: Theme, color: string, text: string): string {
  const styledEmpty = theme.fg(color, "");
  const styleStart = styledEmpty.replace(/\u001b\[(?:0|39)m/g, "");
  return theme.fg(color, text.replace(/\u001b\[(?:0|39)m/g, reset => `${reset}${styleStart}`));
}

/** Format a token count compactly: "33.8k token", "1.2M token". */
export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M token`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k token`;
  return `${count} token`;
}

/**
 * Token count with optional context-fill % and compaction-count annotations.
 * Thresholds for percent: <70% dim, 70–85% warning, ≥85% error.
 * Compaction count rendered as `⇊N` in dim.
 *
 *   "12.3k token"               — no annotations
 *   "12.3k token (45%)"         — percent only
 *   "12.3k token (⇊2)"          — compactions only (e.g. right after compact)
 *   "12.3k token (45% · ⇊2)"    — both
 */
export function formatSessionTokens(
  tokens: number,
  percent: number | null,
  theme: Theme,
  compactions = 0,
): string {
  const tokenStr = formatTokens(tokens);
  const annot: string[] = [];
  if (percent !== null) {
    const color = percent >= 85 ? "error" : percent >= 70 ? "warning" : "dim";
    annot.push(theme.fg(color, `${Math.round(percent)}%`));
  }
  if (compactions > 0) {
    annot.push(theme.fg("dim", `⇊${compactions}`));
  }
  if (annot.length === 0) return tokenStr;
  return `${tokenStr} (${annot.join(" · ")})`;
}

/** Format turn count with optional max limit: "↻5≤30" or "↻5". */
export function formatTurns(turnCount: number, maxTurns?: number | null): string {
  return maxTurns != null ? `↻${turnCount}≤${maxTurns}` : `↻${turnCount}`;
}

/** Format milliseconds as human-readable duration. */
export function formatMs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Format duration from start/completed timestamps. */
export function formatDuration(startedAt: number, completedAt?: number): string {
  if (completedAt) return formatMs(completedAt - startedAt);
  return `${formatMs(Date.now() - startedAt)} (running)`;
}

/** Get display name for any agent type (built-in or custom). */
export function getDisplayName(type: SubagentType): string {
  return getConfig(type).displayName;
}

function rowTypeName(type: SubagentType): string {
  return getDisplayName(type);
}

function rowModeLabel(type: SubagentType): string | undefined {
  return getPromptModeLabel(type);
}

/** Short label for prompt mode: "twin" for append, nothing for replace (the default). */
export function getPromptModeLabel(type: SubagentType): string | undefined {
  const config = getConfig(type);
  return config.promptMode === "append" ? "twin" : undefined;
}

/** Mode label is not included — callers add it where they want it. */
export function buildInvocationTags(
  invocation: AgentInvocation | undefined,
): { modelName?: string; tags: string[] } {
  const tags: string[] = [];
  if (!invocation) return { tags };
  const thinking = invocation.effectiveThinking ?? invocation.thinking;
  if (thinking) tags.push(`thinking: ${thinking}`);
  if (invocation.isolated) tags.push("isolated");
  if (invocation.isolation === "worktree") tags.push("worktree");
  if (invocation.inheritContext) tags.push("inherit context");
  if (invocation.runInBackground) tags.push("background");
  if (invocation.maxTurns != null) tags.push(`max turns: ${invocation.maxTurns}`);
  return { modelName: invocation.modelName, tags };
}

/** Normalize and truncate text so it can never add physical widget rows. */
function truncateLine(text: string, len = 60): string {
  const line = text.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  if (line.length <= len) return line;
  return line.slice(0, len) + "…";
}

/** Build a human-readable activity string from currently-running tools or response text. */
export function describeActivity(activeTools: Map<string, string>, responseText?: string): string {
  if (activeTools.size > 0) {
    const groups = new Map<string, number>();
    for (const toolName of activeTools.values()) {
      const action = TOOL_DISPLAY[toolName] ?? toolName;
      groups.set(action, (groups.get(action) ?? 0) + 1);
    }

    const parts: string[] = [];
    for (const [action, count] of groups) {
      if (count > 1) {
        parts.push(`${action} ${count} ${action === "searching" ? "patterns" : "files"}`);
      } else {
        parts.push(action);
      }
    }
    return parts.join(", ") + "…";
  }

  // No tools active — show truncated response text if available
  if (responseText && responseText.trim().length > 0) {
    return truncateLine(responseText);
  }

  return "thinking…";
}

/**
 * Mark the final visible roster row as the tree's last branch.
 *
 * `bodyIndex` is the offset of that row's header line inside the assembled body,
 * which is not simply `body.length - 1`: the bounded viewport pads the body
 * with blank lines, and two-line rows carry a `│` continuation underneath.
 */
function markLastBranch(body: string[], bodyIndex: number, depth = 0): void {
  const header = body[bodyIndex];
  if (header === undefined) return;
  body[bodyIndex] = header.replace("├─", "└─");
  const continuation = body[bodyIndex + 1];
  if (!continuation) return;
  let from = 0;
  for (let level = 0; level <= depth; level++) {
    const index = continuation.indexOf("│  ", from);
    if (index < 0) return;
    if (level === depth) {
      body[bodyIndex + 1] = continuation.slice(0, index) + "   " + continuation.slice(index + 3);
      return;
    }
    from = index + 3;
  }
}

// ---- Widget manager ----

export class AgentWidget {
  private uiCtx: UICtx | undefined;
  private widgetFrame = 0;
  private widgetInterval: ReturnType<typeof setInterval> | undefined;
  private inputUnsub: (() => void) | undefined;
  /** Whether arrow keys currently navigate the agent roster. */
  private navigationActive = false;
  /** Depth of AgentWidget-owned modals currently holding the keyboard. */
  private modalDepth = 0;
  /** Stable shared-tree key of the selected row, so roster changes do not jump selection. */
  private selectedNodeKey: AgentTreeKey | undefined;
  /** User-collapsed rows for the current session. Rows default to expanded. */
  private collapsedKeys = new Set<AgentTreeKey>();
  private treeSessionId: string | undefined;
  private treeSessionInitialized = false;
  /** Last logical roster index of the selected row, used when it disappears. */
  private selectedRosterIndex = 0;
  /** First logical row currently represented by the bounded viewport. */
  private viewportStart = 0;

  /** Whether the widget callback is currently registered with the TUI. */
  private widgetRegistered = false;
  /** Cached TUI reference from widget factory callback, used for requestRender(). */
  private tui: any | undefined;
  /** Last status bar text, used to avoid redundant setStatus calls. */
  private lastStatusText: string | undefined;
  /** Snapshot of the state used for the last widget registration/render request. */
  private lastRenderKey: string | undefined;

  constructor(
    private manager: AgentManager,
    private agentActivity: Map<string, AgentActivity>,
    /** Read live at render time. Selects which agents the widget shows. */
    private mode: () => WidgetMode = () => "all",
    private options: AgentWidgetOptions = {
      canOpenHistory: (record) => record.session !== undefined || record.completedAt !== undefined,
      onOpen: () => {},
      getSessionId: () => undefined,
    },
  ) {}

  private resetNavigationState(): void {
    this.navigationActive = false;
    this.selectedNodeKey = undefined;
    this.selectedRosterIndex = 0;
    this.viewportStart = 0;
  }

  /** Keep collapse and selection state confined to the session that created it. */
  private currentSessionId(): string | undefined {
    const sessionId = this.options.getSessionId?.();
    if (!this.treeSessionInitialized) {
      this.treeSessionId = sessionId;
      this.treeSessionInitialized = true;
    } else if (sessionId !== this.treeSessionId) {
      this.treeSessionId = sessionId;
      this.collapsedKeys.clear();
      this.resetNavigationState();
    }
    return sessionId;
  }

  /** Shared projection is the widget's only hierarchy and visibility source. */
  private treeProjection(
    collapsedKeys: ReadonlySet<AgentTreeKey> = this.collapsedKeys,
  ): AgentTreeProjection {
    return projectAgentTree({
      agents: this.manager.listAgents(),
      workflowRoots: this.options.getWorkflowRoots?.() ?? [],
      sessionId: this.currentSessionId(),
      artifactRootCwd: this.options.getArtifactRootCwd?.(),
      mode: this.mode(),
      collapsedKeys,
      canOpenTerminalAgent: this.options.canOpenHistory,
    });
  }

  private rowStatus(row: AgentTreeRow): string {
    return row.node.kind === "workflow" ? row.node.root.status : row.node.record.status;
  }

  /** Set the UI context (grabbed from first tool execution). */
  setUICtx(ctx: UICtx): boolean {
    if (ctx === this.uiCtx) return false;

    // UICtx changed — the widget and input handler registered on the old
    // context are gone. Re-register both on the next update().
    this.inputUnsub?.();
    this.inputUnsub = undefined;
    this.uiCtx = ctx;
    this.widgetRegistered = false;
    this.tui = undefined;
    this.lastStatusText = undefined;
    this.lastRenderKey = undefined;
    this.resetNavigationState();
    this.collapsedKeys.clear();
    this.treeSessionId = undefined;
    this.treeSessionInitialized = false;
    // Print/RPC tests and lightweight embedders may provide only the widget
    // surface; real interactive contexts always implement this hook.
    if (typeof ctx.onTerminalInput === "function") {
      this.inputUnsub = ctx.onTerminalInput(data => this.handleKey(data));
    }
    return true;
  }

  /** Request a render on the currently registered TUI without touching input. */
  requestUiRefresh(force = true): boolean {
    if (!this.tui) return false;
    this.tui.requestRender(force);
    return true;
  }

  /** Drop the registration so the next `update()` calls `setWidget` again. */
  reRegister(): void {
    this.widgetRegistered = false;
    this.tui = undefined;
    this.lastRenderKey = undefined;
    this.update();
  }

  /** Called on each new turn (tool_execution_start). */
  onTurnStart() {
    this.update();
  }

  /** Keep the spinner/elapsed-time timer alive only while a visible agent runs. */
  ensureTimer() {
    if (!this.uiCtx || !this.treeProjection(new Set()).rows.some(row => this.rowStatus(row) === "running")) return;
    if (!this.widgetInterval) {
      this.widgetInterval = setInterval(() => this.update(true), 250);
    }
  }

  private syncTimer(shouldRun: boolean): void {
    if (shouldRun) {
      this.ensureTimer();
    } else if (this.widgetInterval) {
      clearInterval(this.widgetInterval);
      this.widgetInterval = undefined;
    }
  }

  /**
   * Retained for the lifecycle call sites. Terminal visibility is determined
   * by the manager record and the history capability, not a one-turn timer.
   */
  markFinished(_agentId: string) {}

  /** Visible, selectable rows in shared-tree preorder. */
  private rosterRows(): readonly AgentTreeRow[] {
    return this.treeProjection().rows;
  }

  /**
   * Track an AgentWidget-owned modal (the `/agents` menus and friends).
   *
   * The widget's terminal listener runs before the focused component, so while
   * a modal is open the listener must not claim ↑/↓/enter/escape.
   */
  setModalOpen(open: boolean): void {
    this.modalDepth = open ? this.modalDepth + 1 : Math.max(0, this.modalDepth - 1);
  }

  /**
   * True when Pi's prompt editor owns the keyboard.
   *
   * A terminal-input listener runs before the focused component, and Pi swaps
   * the prompt editor out for every dialog while `getEditorText()` keeps
   * reporting the detached — empty — editor. Without this guard the widget eats
   * ↑/↓/enter/escape from `/settings`, other extensions' pickers, and Pi's own
   * menus. The modal-depth guard covers dialogs opened by this extension; the
   * structural EditorComponent contract covers Pi's editor and wrappers such as
   * tmux cursor-focus without relying on a shared module identity. Dialogs and
   * overlays that lack the editor text methods, such as SettingsList and the
   * autoresearch dashboard, are rejected.
   *
   * `focused == null` errs toward the editor so list activation keeps working.
   */
  private editorHasFocus(): boolean {
    if (this.modalDepth > 0) return false;
    const focused = (this.tui as { focusedComponent?: unknown } | undefined)?.focusedComponent;
    return focused == null || isEditorComponent(focused);
  }

  private selectedIndexOf(rows: readonly AgentTreeRow[]): number {
    if (!this.selectedNodeKey) return -1;
    return rows.findIndex(row => row.key === this.selectedNodeKey);
  }

  private deactivate(): void {
    // Keep the selected row and viewport so re-entering navigation can resume
    // where the user left off. Lifecycle resets (context, dispose, empty
    // roster) clear this state explicitly instead of treating every exit as a
    // reset.
    this.navigationActive = false;
    this.update();
  }

  /** Resume navigation from the retained row, or select the first row. */
  private activate(rows: readonly AgentTreeRow[]): void {
    this.navigationActive = true;
    const selectedIndex = this.selectedIndexOf(rows);
    if (selectedIndex >= 0) {
      this.selectedRosterIndex = selectedIndex;
    } else {
      // The previously selected row may have been cleaned up while navigation
      // was inactive. Resume at its old logical position, clamped to the new
      // roster, rather than jumping back to the first row.
      const fallbackIndex = Math.max(0, Math.min(this.selectedRosterIndex, rows.length - 1));
      this.selectedNodeKey = rows[fallbackIndex].key;
      this.selectedRosterIndex = fallbackIndex;
      this.viewportStart = Math.min(this.viewportStart, Math.max(0, rows.length - 1));
    }
    this.update();
  }

  /** Move the selected row, activating only from an empty focused editor. */
  private moveSelection(direction: -1 | 1): boolean {
    const projection = this.treeProjection();
    const rows = projection.rows;
    const ui = this.uiCtx;
    if (rows.length === 0 || !ui) return false;

    if (!this.navigationActive) {
      if (direction !== 1 || !this.editorHasFocus() || (ui.getEditorText?.() ?? "") !== "") return false;
      this.activate(rows);
      return true;
    }

    const currentIndex = Math.max(0, this.selectedIndexOf(rows));
    if (direction === -1 && currentIndex === 0) {
      this.deactivate();
      return true;
    }
    const navigation = navigateAgentTree(
      projection,
      this.selectedNodeKey,
      this.collapsedKeys,
      direction === -1 ? "up" : "down",
    );
    this.selectedNodeKey = navigation.selectedKey;
    this.selectedRosterIndex = Math.max(0, this.selectedIndexOf(rows));
    this.update();
    return true;
  }

  /** Collapse or expand a selected workflow root while tree navigation is active. */
  private moveHorizontal(direction: "left" | "right"): void {
    const projection = this.treeProjection();
    const selected = projection.rows.find(row => row.key === this.selectedNodeKey);
    if (selected?.node.kind !== "workflow") return;

    const navigation = navigateAgentTree(
      projection,
      this.selectedNodeKey,
      this.collapsedKeys,
      direction,
    );
    this.selectedNodeKey = navigation.selectedKey;
    this.collapsedKeys = new Set(navigation.collapsedKeys);
    this.selectedRosterIndex = Math.max(0, this.selectedIndexOf(this.treeProjection().rows));
    this.update();
  }

  private openSelected(): void {
    const row = this.rosterRows().find(candidate => candidate.key === this.selectedNodeKey);
    this.deactivate();
    if (!row) return;
    if (row.node.kind === "workflow") {
      void this.options.onOpenWorkflow?.(row.node.root.id);
      return;
    }
    const record = row.node.record;
    const mode: AgentWidgetOpenMode = record.status === "running" || record.status === "queued"
      ? "live"
      : this.options.canOpenHistory(record) ? "history" : "unavailable";
    void this.options.onOpen(record, mode);
  }

  /** Handle terminal input before it reaches the focused prompt editor. */
  handleKey(data: string): { consume?: boolean; data?: string } | undefined {
    if (!this.uiCtx || isKeyRelease(data)) return undefined;
    if (!this.editorHasFocus()) {
      if (this.navigationActive) this.deactivate();
      return undefined;
    }

    if (!this.navigationActive) {
      const rows = this.rosterRows();
      if (!matchesKey(data, "down") || (this.uiCtx.getEditorText?.() ?? "") !== "" || rows.length === 0) {
        return undefined;
      }
      this.activate(rows);
      return { consume: true };
    }

    if (matchesKey(data, "escape")) {
      this.deactivate();
      return { consume: true };
    }
    if (matchesKey(data, "up")) return this.moveSelection(-1) ? { consume: true } : undefined;
    if (matchesKey(data, "down")) return this.moveSelection(1) ? { consume: true } : undefined;
    if (matchesKey(data, "left")) {
      this.moveHorizontal("left");
      return { consume: true };
    }
    if (matchesKey(data, "right")) {
      this.moveHorizontal("right");
      return { consume: true };
    }
    if (matchesKey(data, Key.enter)) {
      this.openSelected();
      return { consume: true };
    }

    // Non-navigation keys flow to the editor and leave navigation mode.
    this.deactivate();
    return undefined;
  }

  /** Render a finished agent line. */
  private renderFinishedLine(a: AgentRecord, theme: Theme): string {
    const name = rowTypeName(a.type);
    const modeLabel = rowModeLabel(a.type);
    const duration = formatMs((a.completedAt ?? Date.now()) - a.startedAt);

    let icon: string;
    let statusText: string;
    if (a.status === "completed") {
      icon = theme.fg("success", "✓");
      statusText = "";
    } else if (a.status === "steered") {
      icon = theme.fg("warning", "✓");
      statusText = theme.fg("warning", " (turn limit)");
    } else if (a.status === "stopped") {
      icon = theme.fg("dim", "■");
      statusText = theme.fg("dim", " stopped");
    } else if (a.status === "error") {
      icon = theme.fg("error", "✗");
      const errMsg = a.error ? `: ${truncateLine(a.error)}` : "";
      statusText = theme.fg("error", ` error${errMsg}`);
    } else {
      // aborted
      icon = theme.fg("error", "✗");
      statusText = theme.fg("warning", " aborted");
    }

    const parts: string[] = [];
    const activity = this.agentActivity.get(a.id);
    const live = activity ?? a.liveActivity;
    if (live) parts.push(formatTurns(live.turnCount, live.maxTurns));
    if (a.toolUses > 0) parts.push(`${a.toolUses} tool use${a.toolUses === 1 ? "" : "s"}`);
    const tokens = getLifetimeTotal(a.lifetimeUsage);
    if (tokens > 0) {
      parts.push(formatSessionTokens(tokens, getSessionContextPercent(activity?.session ?? a.liveActivity?.session ?? a.session), theme, a.compactionCount));
      if (a.parentAgentId) parts.push(theme.fg("dim", "already counted in parent"));
    }
    parts.push(duration);

    const modeTag = modeLabel ? ` ${theme.fg("dim", `(${modeLabel})`)}` : "";
    const issue = a.nestedIssue ? theme.fg("warning", ` · nested blocked: ${truncateLine(a.nestedIssue)}`) : "";
    return `${icon} ${theme.fg("dim", name)}${modeTag}  ${theme.fg("dim", truncateLine(a.description))} ${theme.fg("dim", "·")} ${theme.fg("dim", parts.join(" · "))}${statusText}${issue}`;
  }

  /**
   * Render the widget content. Called from the registered widget's render() callback,
   * reading live state each time instead of capturing it in a closure.
   */
  private renderWidget(tui: any, theme: Theme): string[] {
    const projection = this.treeProjection();
    const allRows = this.treeProjection(new Set()).rows;
    const hasActive = allRows.some(row => {
      const status = this.rowStatus(row);
      return status === "running" || status === "queued" || status === "paused";
    });

    // Nothing to show — return empty (widget will be unregistered by update()).
    if (projection.rows.length === 0) return [];

    const selectedKey = this.navigationActive ? this.selectedNodeKey : undefined;
    const w = tui.terminal.columns;
    const maxLines = getWidgetLineBudget(tui.terminal.rows);
    if (maxLines === 0) return [];
    const truncate = (line: string, width = w) => truncateToWidth(line, Math.max(0, width));
    const headingColor = hasActive ? "accent" : "dim";
    const headingIcon = hasActive ? "●" : "○";
    const frame = SPINNER[this.widgetFrame % SPINNER.length];

    const ancestorPrefix = (row: AgentTreeRow): string => row.ancestorContinues
      .map(continues => continues ? "│  " : "   ")
      .join("");
    const orphanNote = (row: AgentTreeRow): string => {
      if (!row.orphaned || row.node.kind !== "agent") return "";
      if (row.cycle) return theme.fg("dim", " · parent cycle");
      const record = row.node.record;
      return theme.fg("dim", ` · parent ${record.parentDescription ?? record.parentAgentId} is gone`);
    };
    const rowPrefix = (row: AgentTreeRow): string => ancestorPrefix(row) + (row.isLast ? "└─ " : "├─ ");
    const detailPrefix = (row: AgentTreeRow): string => ancestorPrefix(row) + "│    ";
    const renderedRows: { row: AgentTreeRow; lines: string[]; depth: number }[] = [];

    for (const row of projection.rows) {
      const note = orphanNote(row);
      const marker = row.key === selectedKey ? theme.fg("accent", "●") : theme.fg("dim", "○");
      const prefix = theme.fg("dim", rowPrefix(row));

      if (row.node.kind === "workflow") {
        const root = row.node.root;
        const statusColor = root.status === "completed"
          ? "success"
          : root.status === "failed" ? "error" : root.status === "paused" ? "warning" : "dim";
        const icon = root.status === "running"
          ? theme.fg("accent", frame)
          : root.status === "completed"
          ? theme.fg("success", "✓")
          : root.status === "failed"
          ? theme.fg("error", "✗")
          : root.status === "killed"
          ? theme.fg("dim", "■")
          : theme.fg("warning", "Ⅱ");
        const elapsed = formatMs((root.completedAt ?? Date.now()) - root.startedAt);
        const progress = `${root.doneCount}/${root.agentCount} done`;
        renderedRows.push({
          row,
          depth: row.depth,
          lines: [truncate(
            prefix
            + `${marker} ${icon} ${theme.bold("workflow")}  `
            + `${theme.fg("muted", truncateLine(root.description || root.name))} ${theme.fg("dim", "·")} `
            + `${theme.fg(statusColor, root.status)} ${theme.fg("dim", "·")} `
            + `${theme.fg("dim", `${progress} · ${formatTokens(root.tokens)} · ${elapsed}`)}`
            + (root.restoredHistory ? theme.fg("dim", " · restored history (child conversations unavailable)") : ""),
          )],
        });
        continue;
      }

      const a = row.node.record;
      if (a.status === "running") {
        const name = rowTypeName(a.type);
        const modeLabel = rowModeLabel(a.type);
        const modeTag = modeLabel ? ` ${theme.fg("dim", `(${modeLabel})`)}` : "";
        const elapsed = formatMs(Date.now() - a.startedAt);
        const activityState = this.agentActivity.get(a.id);
        const live = activityState ?? a.liveActivity;
        const toolUses = activityState?.toolUses ?? a.toolUses;
        const tokens = getLifetimeTotal(a.lifetimeUsage);
        const contextPercent = getSessionContextPercent(activityState?.session ?? a.liveActivity?.session ?? a.session);
        const tokenText = tokens > 0 ? formatSessionTokens(tokens, contextPercent, theme, a.compactionCount)
          + (a.parentAgentId ? theme.fg("dim", " (in parent)") : "") : "";
        const parts: string[] = [];
        if (live) parts.push(formatTurns(live.turnCount, live.maxTurns));
        if (toolUses > 0) parts.push(`${toolUses} tool use${toolUses === 1 ? "" : "s"}`);
        if (tokenText) parts.push(tokenText);
        parts.push(elapsed);
        const statsText = parts.join(" · ");
        const activity = a.nestedIssue
          ? `nested blocked: ${a.nestedIssue}`
          : live ? describeActivity(live.activeTools, live.responseText) : "thinking…";
        renderedRows.push({
          row,
          depth: row.depth,
          lines: [
            truncate(prefix + `${marker} ${theme.fg("accent", frame)} ${theme.bold(name)}${modeTag}  ${theme.fg("muted", truncateLine(a.description))} ${theme.fg("dim", "·")} ${fgPreservingNestedStyles(theme, "dim", statsText)}${note}`),
            truncate(theme.fg("dim", detailPrefix(row)) + theme.fg("dim", `⎿  ${activity}`)),
          ],
        });
      } else if (a.status === "queued") {
        renderedRows.push({
          row,
          depth: row.depth,
          lines: [truncate(prefix + `${marker} ${theme.fg("muted", "◦")} ${theme.fg("dim", `${rowTypeName(a.type)}  ${truncateLine(a.description)} · queued`)}${note}`)],
        });
      } else {
        renderedRows.push({
          row,
          depth: row.depth,
          lines: [truncate(prefix + `${marker} ` + this.renderFinishedLine(a, theme) + note)],
        });
      }
    }

    // Assemble with a responsive cap (heading + overflow indicator = 2
    // reserved lines when content exceeds the available body budget).
    const maxBody = maxLines - 1; // heading takes 1 line
    const rows = renderedRows;
    const totalBody = rows.reduce((total, row) => total + row.lines.length, 0);

    const heading = "Agents  ↑↓ select · ←→ workflow fold · enter view · esc back";
    const lines: string[] = [truncate(theme.fg(headingColor, headingIcon) + " " + theme.fg(headingColor, heading))];

    if (maxLines === 1) {
      // There is room only for the heading; do not consume the editor/input row.
      return lines;
    }

    if (totalBody <= maxBody) {
      this.viewportStart = 0;
      for (const row of rows) lines.push(...row.lines);
      if (rows.length > 0) {
        const lastRow = rows[rows.length - 1];
        markLastBranch(lines, lines.length - lastRow.lines.length, lastRow.depth);
      }
    } else {
      // Reserve one line for a directional overflow summary. The viewport is
      // a contiguous slice in roster order, so the same slice is navigable and
      // renderable even when the selected row is currently hidden.
      const baseContentBudget = Math.max(0, maxBody - 1);
      const heightAt = (index: number) => rows[index]?.lines.length ?? 0;
      const endFor = (start: number, budget: number): number => {
        let used = 0;
        let end = start;
        while (end < rows.length && used + heightAt(end) <= budget) {
          used += heightAt(end++);
        }
        return end;
      };

      let start = Math.max(0, Math.min(this.viewportStart, Math.max(0, rows.length - 1)));
      const selectedIndex = this.navigationActive && selectedKey
        ? rows.findIndex(row => row.row.key === selectedKey)
        : -1;
      if (selectedIndex >= 0) {
        if (selectedIndex < start) start = selectedIndex;
        if (selectedIndex >= endFor(start, baseContentBudget)) start = selectedIndex;
      }

      // Keep both directional affordances in the viewport chrome: the top
      // count sits below the heading and the bottom count sits below the
      // bounded roster. Each consumes one row when that direction is hidden.
      let showTopMore = start > 0;
      let contentBudget = Math.max(0, maxBody - (showTopMore ? 2 : 1));
      if (selectedIndex >= 0 && selectedIndex >= endFor(start, contentBudget)) {
        start = selectedIndex;
        showTopMore = start > 0;
        contentBudget = Math.max(0, maxBody - (showTopMore ? 2 : 1));
      }
      this.viewportStart = start;

      let used = 0;
      let end = start;
      let lastRowLine = -1;
      const visibleBody: string[] = [];
      while (end < rows.length && used + heightAt(end) <= contentBudget) {
        lastRowLine = visibleBody.length;
        visibleBody.push(...rows[end].lines);
        used += heightAt(end);
        end++;
      }
      // A selected two-line row must remain addressable even if only one body
      // line is available. Showing its header is preferable to hiding it.
      if (end === start && rows[start] && contentBudget > 0) {
        visibleBody.push(rows[start].lines[0]);
        end = start + 1;
      }
      markLastBranch(visibleBody, lastRowLine, rows[Math.max(start, end - 1)]?.depth ?? 0);

      const hiddenBefore = start;
      const hiddenAfter = Math.max(0, rows.length - end);
      const hidden = hiddenBefore + hiddenAfter;
      const hiddenRows = rows.filter((_row, index) => index < start || index >= end);
      const categoryCounts: string[] = [
        ["running", hiddenRows.filter(row => this.rowStatus(row.row) === "running").length] as [string, number],
        ["queued", hiddenRows.filter(row => this.rowStatus(row.row) === "queued").length] as [string, number],
        ["finished", hiddenRows.filter(row => {
          const status = this.rowStatus(row.row);
          return status !== "running" && status !== "queued";
        }).length] as [string, number],
      ].filter(([, count]) => count > 0).map(([label, count]) => `${count} ${label}`);
      const direction = [
        ...(hiddenBefore > 0 ? [`↑ ${hiddenBefore} more`] : []),
        ...(hiddenAfter > 0 ? [`↓ ${hiddenAfter} more`] : []),
      ].join(" · ");
      const summary = `+${hidden} more (${direction}${categoryCounts.length > 0 ? `; ${categoryCounts.join(", ")}` : ""})`;

      if (showTopMore) lines.push(truncate(theme.fg("dim", `↑ ${hiddenBefore} more`)));

      // Fill the bounded viewport so the scrollbar track has a stable height.
      while (visibleBody.length < contentBudget) visibleBody.push("");
      const totalBody = rows.reduce((total, row) => total + row.lines.length, 0);
      const startOffset = rows.slice(0, start).reduce((total, row) => total + row.lines.length, 0);
      const trackHeight = Math.max(0, contentBudget);
      const minThumbHeight = Math.min(2, trackHeight);
      const thumbHeight = Math.max(
        minThumbHeight,
        Math.min(trackHeight, Math.round((trackHeight * trackHeight) / totalBody)),
      );
      const maxScrollTop = Math.max(0, totalBody - trackHeight);
      const maxThumbTop = Math.max(0, trackHeight - thumbHeight);
      const thumbOffset = maxScrollTop === 0
        ? 0
        : Math.round((startOffset / maxScrollTop) * maxThumbTop);
      const contentWidth = Math.max(0, w - 1);
      for (let index = 0; index < visibleBody.length; index++) {
        const isThumb = index >= thumbOffset && index < thumbOffset + thumbHeight;
        const scrollbar = isThumb
          ? theme.fg("scrollbarThumb", this.navigationActive ? "█" : "┃")
          : theme.fg("scrollbarTrack", "│");
        const bodyLine = truncate(visibleBody[index] ?? "", contentWidth);
        lines.push(bodyLine + " ".repeat(Math.max(0, contentWidth - visibleWidth(bodyLine))) + scrollbar);
      }

      // The directional count is outside the viewport, like ScrollView's
      // surrounding chrome, and therefore does not consume scrollbar track.
      if (hiddenAfter > 0) {
        lines.push(truncate(theme.fg("dim", `↓ ${hiddenAfter} more · +${hidden} more (${categoryCounts.length > 0 ? categoryCounts.join(", ") : ""})`)));
      } else if (!showTopMore) {
        lines.push(truncate(theme.fg("dim", "└─") + ` ${theme.fg("dim", summary)}`));
      } else {
        // Scrolled to the end with rows hidden above. The final visible roster
        // row already carries the tree terminator, so this row only reserves
        // height for a stable footer — repeating `└─` would draw two of them.
        lines.push("   ");
      }
    }

    return lines;
  }

  /** Build a render-relevant snapshot without capturing mutable records. */
  private renderKey(projection: AgentTreeProjection): string {
    const activities = projection.rows.map(row => {
      if (row.node.kind !== "agent") return undefined;
      const a = row.node.record;
      const activity = this.agentActivity.get(a.id);
      return activity ? {
        id: a.id,
        activeTools: [...activity.activeTools.entries()],
        toolUses: activity.toolUses,
        responseText: activity.responseText,
        turnCount: activity.turnCount,
        maxTurns: activity.maxTurns,
        lifetimeUsage: activity.lifetimeUsage,
        contextPercent: getSessionContextPercent(activity.session),
      } : undefined;
    });
    return JSON.stringify({
      frame: this.widgetFrame,
      rows: projection.rows.map(row => {
        const hierarchy = {
          key: row.key,
          depth: row.depth,
          parentKey: row.parentKey,
          ancestorContinues: row.ancestorContinues,
          isLast: row.isLast,
          hasChildren: row.hasChildren,
          expanded: row.expanded,
          orphaned: row.orphaned,
          cycle: row.cycle,
        };
        if (row.node.kind === "workflow") {
          return { ...hierarchy, kind: "workflow", ...row.node.root };
        }
        const a = row.node.record;
        return {
          ...hierarchy,
          kind: "agent",
          id: a.id,
          type: a.type,
          description: a.description,
          status: a.status,
          toolUses: a.toolUses,
          startedAt: a.startedAt,
          completedAt: a.completedAt,
          error: a.error,
          lifetimeUsage: a.lifetimeUsage,
          compactionCount: a.compactionCount,
          isBackground: a.isBackground,
          parentAgentId: a.parentAgentId,
          parentDescription: a.parentDescription,
          nestedIssue: a.nestedIssue,
          liveActivity: a.liveActivity ? {
            activeTools: [...a.liveActivity.activeTools.entries()],
            responseText: a.liveActivity.responseText,
            turnCount: a.liveActivity.turnCount,
            maxTurns: a.liveActivity.maxTurns,
            contextPercent: getSessionContextPercent(a.liveActivity.session),
          } : undefined,
          hasSession: a.session !== undefined,
          transcriptPath: a.transcriptPath,
          openableHistory: this.options.canOpenHistory(a),
        };
      }),
      activities,
      collapsedKeys: [...this.collapsedKeys].sort(),
      navigationActive: this.navigationActive,
      selectedNodeKey: this.selectedNodeKey,
      viewportStart: this.viewportStart,
    });
  }

  /** Force an immediate widget update. `advanceSpinner` is reserved for the timer. */
  update(advanceSpinner = false) {
    if (!this.uiCtx) return;
    const projection = this.treeProjection();
    const allRows = this.treeProjection(new Set()).rows;

    let runningCount = 0;
    let queuedCount = 0;
    let hasRunning = false;
    for (const row of allRows) {
      const status = this.rowStatus(row);
      if (status === "running") hasRunning = true;
      if (row.node.kind !== "agent") continue;
      if (status === "running") runningCount++;
      else if (status === "queued") queuedCount++;
    }

    // Nothing to show — clear widget.
    if (projection.rows.length === 0) {
      if (this.widgetRegistered) {
        this.uiCtx.setWidget("agents", undefined);
        this.widgetRegistered = false;
        this.tui = undefined;
      }
      if (this.lastStatusText !== undefined) {
        this.uiCtx.setStatus("subagents", undefined);
        this.lastStatusText = undefined;
      }
      this.lastRenderKey = undefined;
      this.resetNavigationState();
      this.syncTimer(false);
      return;
    }

    // Status bar counts real agents, not grouping-only workflow roots.
    let newStatusText: string | undefined;
    const activeAgentCount = runningCount + queuedCount;
    if (activeAgentCount > 0) {
      const statusParts: string[] = [];
      if (runningCount > 0) statusParts.push(`${runningCount} running`);
      if (queuedCount > 0) statusParts.push(`${queuedCount} queued`);
      newStatusText = `${statusParts.join(", ")} agent${activeAgentCount === 1 ? "" : "s"}`;
    }
    if (newStatusText !== this.lastStatusText) {
      this.uiCtx.setStatus("subagents", newStatusText);
      this.lastStatusText = newStatusText;
    }

    // Event-driven updates refresh hierarchy/layout with a forced redraw.
    // Timer ticks only advance running spinners and remain incremental.
    if (advanceSpinner && hasRunning) this.widgetFrame++;
    this.syncTimer(hasRunning);
    const roster = projection.rows;
    const selectedIndex = this.selectedIndexOf(roster);
    if (selectedIndex >= 0) {
      this.selectedRosterIndex = selectedIndex;
    } else if (this.navigationActive) {
      if (roster.length === 0) {
        this.resetNavigationState();
      } else {
        const fallbackIndex = Math.max(0, Math.min(this.selectedRosterIndex, roster.length - 1));
        this.selectedNodeKey = roster[fallbackIndex].key;
        this.selectedRosterIndex = fallbackIndex;
        this.viewportStart = Math.min(this.viewportStart, roster.length - 1);
      }
    }
    const renderKey = this.renderKey(projection);

    // Register widget callback once; subsequent updates use requestRender()
    // which re-invokes render() without replacing the component (avoids layout thrashing).
    if (!this.widgetRegistered) {
      this.uiCtx.setWidget("agents", (tui, theme) => {
        this.tui = tui;
        return {
          render: () => this.renderWidget(tui, theme),
          invalidate: () => {
            // Theme changed — force re-registration so factory captures fresh theme.
            this.widgetRegistered = false;
            this.tui = undefined;
            this.lastRenderKey = undefined;
          },
        };
      }, { placement: "aboveEditor" });
      this.widgetRegistered = true;
    } else if (renderKey !== this.lastRenderKey) {
      // Widget already registered — request a re-render only when visible state
      // changed (or the spinner timer advanced).
      // Event-driven updates can change surrounding layout state, so force a
      // full redraw. Timer ticks only advance the spinner and use incremental
      // rendering to keep animation lightweight.
      this.tui?.requestRender(!advanceSpinner);
    }
    this.lastRenderKey = renderKey;
  }

  dispose() {
    if (this.widgetInterval) {
      clearInterval(this.widgetInterval);
      this.widgetInterval = undefined;
    }
    if (this.uiCtx) {
      this.uiCtx.setWidget("agents", undefined);
      this.uiCtx.setStatus("subagents", undefined);
    }
    this.inputUnsub?.();
    this.inputUnsub = undefined;
    this.widgetRegistered = false;
    this.tui = undefined;
    this.lastStatusText = undefined;
    this.lastRenderKey = undefined;
    this.resetNavigationState();
    this.collapsedKeys.clear();
    this.treeSessionId = undefined;
    this.treeSessionInitialized = false;
    this.uiCtx = undefined;
  }
}
