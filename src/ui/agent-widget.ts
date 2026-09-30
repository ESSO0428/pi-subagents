/**
 * agent-widget.ts — Persistent widget showing running/completed agents above the editor.
 *
 * Displays a tree of agents with animated spinners, live stats, and activity descriptions.
 * Uses the callback form of setWidget for themed rendering.
 */

import { Editor, isKeyRelease, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { renderAgentName } from "../agent-color.js";
import type { AgentManager } from "../agent-manager.js";
import { getConfig } from "../agent-types.js";
import type { AgentInvocation, AgentRecord, SubagentType, WidgetMode } from "../types.js";
import { getLifetimeCost, getLifetimeTotal, getSessionContextPercent, type LifetimeUsage, type SessionLike } from "../usage.js";

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

export type AgentWidgetOpenMode = "live" | "history";
export type AgentWidgetOpenCallback = (record: AgentRecord, mode: AgentWidgetOpenMode) => void | Promise<void>;
export interface AgentWidgetOptions {
  canOpenHistory?: (record: AgentRecord) => boolean;
  onOpen?: AgentWidgetOpenCallback;
  showCost?: () => boolean;
}
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
  onTerminalInput?(handler: (data: string) => { consume?: boolean; data?: string } | undefined): () => void;
  getEditorText?(): string;
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

/** Metadata attached to Agent tool results for custom rendering. */
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
  /** Estimated cost in USD; 0 when the model has no pricing data. */
  cost?: number;
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

/** Format an estimated model cost without implying billing precision. */
export function formatCost(cost: number): string {
  if (!(cost > 0)) return "";
  if (cost < 0.0001) return "<$0.0001";
  if (cost >= 1) return `~$${cost.toFixed(2)}`;
  const rounded = Number(cost.toFixed(4));
  const decimals = (String(rounded).split(".")[1] ?? "").length;
  return `~$${rounded.toFixed(Math.max(2, decimals))}`;
}

/** Get display name for any agent type (built-in or custom). */
export function getDisplayName(type: SubagentType): string {
  return getConfig(type).displayName;
}

/** Short label for prompt mode: "twin" for append, nothing for replace (the default). */
export function getPromptModeLabel(type: SubagentType): string | undefined {
  const config = getConfig(type);
  return config.promptMode === "append" ? "twin" : undefined;
}

/** Mode label is not included — callers add it where they want it. */
export function buildInvocationTags(
  invocation: AgentInvocation | undefined,
): { modelName?: string; modelId?: string; tags: string[] } {
  const tags: string[] = [];
  if (!invocation) return { tags };
  const asked = (value: string | undefined, requested: string | undefined): string | undefined =>
    value && requested && requested !== value ? `${value} (asked ${requested})` : value;
  const thinking = asked(invocation.thinking, invocation.requestedThinking);
  if (thinking) tags.push(`thinking: ${thinking}`);
  if (invocation.isolated) tags.push("isolated");
  if (invocation.isolation === "worktree") tags.push("worktree");
  if (invocation.inheritContext) tags.push("inherit context");
  if (invocation.runInBackground) tags.push("background");
  if (invocation.maxTurns != null) tags.push(`max turns: ${invocation.maxTurns}`);
  return {
    modelName: asked(invocation.modelName, invocation.requestedModel),
    modelId: asked(invocation.modelId, invocation.requestedModel),
    tags,
  };
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

// ---- Widget manager ----

export class AgentWidget {
  private uiCtx: UICtx | undefined;
  private widgetFrame = 0;
  private widgetInterval: ReturnType<typeof setInterval> | undefined;
  private inputUnsub: (() => void) | undefined;
  /** Whether arrow keys currently navigate the agent roster. */
  private navigationActive = false;
  /** Number of modal surfaces currently owning this listener's input suspension. */
  private navigationSuspensionDepth = 0;
  /** Stable identity of the selected row, so roster changes do not jump selection. */
  private selectedAgentId: string | undefined;
  /** Last logical roster index of the selected row, used when it disappears. */
  private selectedRosterIndex = 0;
  /** First logical row currently represented by the bounded viewport. */
  private viewportStart = 0;

  /** Cached records and roster. Rebuilt by update(), never by an arrow press. */
  private cachedAgents: AgentRecord[] = [];
  private cachedRoster: AgentRecord[] = [];
  private rosterCacheKey: string | undefined;
  private rosterCacheInitialized = false;
  /** Terminal history capability is a potentially filesystem-backed lookup. */
  private historyOpenabilityCache = new Map<string, { key: string; value: boolean }>();

  /** Whether the widget callback is currently registered with the TUI. */
  private widgetRegistered = false;
  /** Cached TUI reference from widget factory callback, used for requestRender(). */
  private tui: any | undefined;
  /** Last status bar text, used to avoid redundant setStatus calls. */
  private lastStatusText: string | undefined;
  /** Snapshot of the state used for the last widget registration/render request. */
  private lastRenderKey: string | undefined;
  private readonly openOptions: AgentWidgetOptions;
  private readonly showCost: () => boolean;
  private readonly showModel: () => boolean;

  constructor(
    private manager: AgentManager,
    private agentActivity: Map<string, AgentActivity>,
    /** Read live at render time. Selects which agents the widget shows. */
    private mode: () => WidgetMode = () => "all",
    showCostOrOptions: (() => boolean) | AgentWidgetOptions = () => false,
    showModel: () => boolean = () => false,
  ) {
    if (typeof showCostOrOptions === "function") {
      this.showCost = showCostOrOptions;
      this.openOptions = {};
    } else {
      this.showCost = showCostOrOptions.showCost ?? (() => false);
      this.openOptions = showCostOrOptions;
    }
    this.showModel = showModel;
  }

  /**
   * Agents eligible for the widget, per the current `WidgetMode`:
   *   - `off`: none (the widget's existing empty-state path hides it entirely).
   *   - `background`: drop only agents *known* to be foreground
   *     (`isBackground === false`); keep everything else — background, queued,
   *     scheduled, or RPC-spawned (`undefined`). Keying off the `isBackground`
   *     record flag rather than the UI-only `invocation` snapshot (which only the
   *     Agent-tool path sets), and excluding rather than allow-listing, means
   *     only proven-foreground runs drop out — nothing else silently vanishes.
   *   - `all`: every agent.
   */
  private widgetAgentsFromManager(): AgentRecord[] {
    const all = this.manager.listAgents();
    switch (this.mode()) {
      case "off": return [];
      case "background": return all.filter(a => a.isBackground !== false);
      default: return all;
    }
  }

  /** Records currently visible to the widget; safe for render and input paths. */
  private widgetAgents(): AgentRecord[] {
    return this.rosterCacheInitialized ? this.cachedAgents : this.widgetAgentsFromManager();
  }

  private canOpenHistory(record: AgentRecord): boolean {
    return this.openOptions.canOpenHistory?.(record) ?? true;
  }

  private historyOpenabilityKey(record: AgentRecord): string {
    return JSON.stringify([
      record.status,
      record.completedAt ?? null,
      record.transcriptPath ?? null,
      record.session !== undefined,
    ]);
  }

  /**
   * Cache terminal history capability by the record state that can affect it.
   * The supplied predicate may call `existsSync`, so it must not run from a
   * timer refresh, render-key calculation, or arrow-navigation path more than
   * once for the same terminal record state.
   */
  private cachedCanOpenHistory(record: AgentRecord): boolean {
    if (record.status === "running" || record.status === "queued") return true;

    const key = this.historyOpenabilityKey(record);
    const cached = this.historyOpenabilityCache.get(record.id);
    if (cached?.key === key) return cached.value;

    const value = this.canOpenHistory(record);
    this.historyOpenabilityCache.set(record.id, { key, value });
    return value;
  }

  /** Refresh the manager snapshot and openability cache at lifecycle/update time. */
  private refreshRoster(): AgentRecord[] {
    const agents = this.widgetAgentsFromManager();
    const key = JSON.stringify({
      mode: this.mode(),
      agents: agents.map(record => [
        record.id,
        record.type,
        record.description,
        record.status,
        record.completedAt ?? null,
        record.startedAt,
        record.toolUses,
        record.error ?? null,
        record.transcriptPath ?? null,
        record.session !== undefined,
        record.isBackground,
        record.status !== "running" && record.status !== "queued"
          ? this.cachedCanOpenHistory(record)
          : undefined,
      ]),
    });
    if (this.rosterCacheInitialized && key === this.rosterCacheKey) return this.cachedRoster;

    const finished = agents.filter(record =>
      record.status !== "running" && record.status !== "queued"
      && record.completedAt !== undefined
      && this.cachedCanOpenHistory(record),
    );
    const running = agents.filter(record => record.status === "running");
    const queued = agents.filter(record => record.status === "queued");
    this.cachedAgents = agents;
    this.cachedRoster = [...running, ...queued, ...finished];
    this.rosterCacheKey = key;
    this.rosterCacheInitialized = true;
    return this.cachedRoster;
  }

  /** Suspend only this listener's keyboard ownership; never alter the widget. */
  suspendNavigation(): void {
    this.navigationSuspensionDepth++;
  }

  /** Restore one layer of this listener's keyboard ownership. */
  resumeNavigation(): void {
    if (this.navigationSuspensionDepth > 0) this.navigationSuspensionDepth--;
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
    this.navigationSuspensionDepth = 0;
    this.navigationActive = false;
    this.selectedAgentId = undefined;
    this.selectedRosterIndex = 0;
    this.viewportStart = 0;
    this.cachedAgents = [];
    this.cachedRoster = [];
    this.rosterCacheKey = undefined;
    this.rosterCacheInitialized = false;
    this.historyOpenabilityCache.clear();
    // Print/RPC tests and lightweight embedders may provide only the widget
    // surface; real interactive contexts always implement this hook.
    if (typeof ctx.onTerminalInput === "function") {
      this.inputUnsub = ctx.onTerminalInput(data => this.handleKey(data));
    }
    return true;
  }

  /** Request a render on the currently registered TUI without touching input. */
  requestUiRefresh(force = true): boolean {
    if (!this.tui || typeof this.tui.requestRender !== "function") return false;
    this.tui.requestRender(force);
    return true;
  }

  /** Called on each new turn (tool_execution_start). */
  onTurnStart() {
    this.update();
  }

  /** Keep the spinner/elapsed-time timer alive only while a visible agent runs. */
  ensureTimer() {
    if (!this.uiCtx) return;
    const roster = this.rosterCacheInitialized ? this.cachedRoster : this.refreshRoster();
    if (!roster.some(a => a.status === "running")) return;
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

  /** Retained for lifecycle call sites; terminal rows are record-driven now. */
  markRunning(_agentId: string) {}

  /**
   * Records represented by selectable rows in the above-editor widget.
   *
   * Keep this order as the single source of truth for both rendering and key
   * navigation. `listAgents()` is newest-first; active rows come first so the
   * panel exposes currently useful work before terminal history.
   */
  private roster(): AgentRecord[] {
    return this.rosterCacheInitialized ? this.cachedRoster : this.refreshRoster();
  }

  /** True when pi's prompt editor owns the keyboard. */
  private editorHasFocus(): boolean {
    const focused = (this.tui as { focusedComponent?: unknown } | undefined)?.focusedComponent;
    return focused == null || focused instanceof Editor;
  }

  private selectedIndexOf(records: readonly AgentRecord[]): number {
    if (!this.selectedAgentId) return -1;
    return records.findIndex(record => record.id === this.selectedAgentId);
  }

  private deactivate(): void {
    // Keep the selected row and viewport so re-entering navigation can resume
    // where the user left off. Lifecycle resets (context, dispose, empty
    // roster) clear this state explicitly instead of treating every exit as a
    // reset.
    this.navigationActive = false;
    this.requestUiRefresh();
  }

  /** Resume navigation from the retained row, or select the first row. */
  private activate(records: readonly AgentRecord[]): void {
    this.navigationActive = true;
    const selectedIndex = this.selectedIndexOf(records);
    if (selectedIndex >= 0) {
      this.selectedRosterIndex = selectedIndex;
    } else {
      // The previously selected row may have been cleaned up while navigation
      // was inactive. Resume at its old logical position, clamped to the new
      // roster, rather than jumping back to the first row.
      const fallbackIndex = Math.max(0, Math.min(this.selectedRosterIndex, records.length - 1));
      this.selectedAgentId = records[fallbackIndex].id;
      this.selectedRosterIndex = fallbackIndex;
      this.viewportStart = Math.min(this.viewportStart, Math.max(0, records.length - 1));
    }
    this.requestUiRefresh();
  }

  /** Move the selected row, activating only from an empty focused editor. */
  private moveSelection(direction: -1 | 1): boolean {
    const records = this.roster();
    const ui = this.uiCtx;
    if (records.length === 0 || !ui) return false;

    if (!this.navigationActive) {
      if (direction !== 1 || !this.editorHasFocus() || (ui.getEditorText?.() ?? "") !== "") return false;
      this.activate(records);
      return true;
    }

    const currentIndex = Math.max(0, this.selectedIndexOf(records));
    if (direction === -1 && currentIndex === 0) {
      this.deactivate();
      return true;
    }
    const nextIndex = Math.max(0, Math.min(records.length - 1, currentIndex + direction));
    this.selectedAgentId = records[nextIndex].id;
    this.selectedRosterIndex = nextIndex;
    this.requestUiRefresh();
    return true;
  }

  private openSelected(): void {
    const record = this.roster().find(candidate => candidate.id === this.selectedAgentId);
    this.deactivate();
    if (!record) return;
    const mode: AgentWidgetOpenMode = record.status === "running" || record.status === "queued" ? "live" : "history";
    void this.openOptions.onOpen?.(record, mode);
  }

  /** Handle terminal input before it reaches the focused prompt editor. */
  handleKey(data: string): { consume?: boolean; data?: string } | undefined {
    if (!this.uiCtx || isKeyRelease(data)) return undefined;
    if (this.navigationSuspensionDepth > 0) return undefined;
    if (!this.editorHasFocus()) {
      if (this.navigationActive) this.deactivate();
      return undefined;
    }

    if (!this.navigationActive) {
      const records = this.roster();
      if (!matchesKey(data, "down") || (this.uiCtx.getEditorText?.() ?? "") !== "" || records.length === 0) {
        return undefined;
      }
      this.activate(records);
      return { consume: true };
    }

    if (matchesKey(data, "escape")) {
      this.deactivate();
      return { consume: true };
    }
    if (matchesKey(data, "up")) return this.moveSelection(-1) ? { consume: true } : undefined;
    if (matchesKey(data, "down")) return this.moveSelection(1) ? { consume: true } : undefined;
    if (matchesKey(data, Key.enter)) {
      this.openSelected();
      return { consume: true };
    }

    // Only ↑/↓ navigate. Other keys, including j/k/←/→, flow to the editor
    // and leave navigation mode.
    this.deactivate();
    return undefined;
  }

  /** Render a finished agent line. */
  private renderFinishedLine(a: { id: string; type: SubagentType; status: string; description: string; toolUses: number; startedAt: number; completedAt?: number; error?: string; lifetimeUsage?: LifetimeUsage }, theme: Theme): string {
    const modeLabel = getPromptModeLabel(a.type);
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
    if (activity) parts.push(formatTurns(activity.turnCount, activity.maxTurns));
    if (a.toolUses > 0) parts.push(`${a.toolUses} tool use${a.toolUses === 1 ? "" : "s"}`);
    const costText = this.showCost() && a.lifetimeUsage ? formatCost(getLifetimeCost(a.lifetimeUsage)) : "";
    if (costText) parts.push(costText);
    parts.push(duration);

    const modeTag = modeLabel ? ` ${theme.fg("dim", `(${modeLabel})`)}` : "";
    const description = truncateLine(a.description);
    return `${icon} ${renderAgentName(a.type, theme, { fallbackColor: "dim" })}${modeTag}  ${theme.fg("dim", description)} ${theme.fg("dim", "·")} ${theme.fg("dim", parts.join(" · "))}${statusText}`;
  }

  /**
   * Render the widget content. Called from the registered widget's render() callback,
   * reading live state each time instead of capturing it in a closure.
   */
  private renderWidget(tui: any, theme: Theme): string[] {
    const roster = this.roster();
    const running = roster.filter(a => a.status === "running");
    const queued = roster.filter(a => a.status === "queued");
    const finished = roster.filter(a => a.status !== "running" && a.status !== "queued");

    const selectedId = this.navigationActive ? this.selectedAgentId : undefined;
    const hasActive = running.length > 0 || queued.length > 0;
    const hasFinished = finished.length > 0;

    // Nothing to show — return empty (widget will be unregistered by update())
    if (!hasActive && !hasFinished) return [];

    const w = tui.terminal.columns;
    const maxLines = getWidgetLineBudget(tui.terminal.rows);
    if (maxLines === 0) return [];
    const truncate = (line: string, width = w) => truncateToWidth(line, Math.max(0, width));
    const headingColor = hasActive ? "accent" : "dim";
    const headingIcon = hasActive ? "●" : "○";
    const frame = SPINNER[this.widgetFrame % SPINNER.length];

    // Build sections separately for overflow-aware assembly.
    // Each running agent = 2 lines (header + activity), finished = 1 line, queued = 1 line.

    type WidgetRow = { record: AgentRecord; lines: string[]; recordCount?: number };

    const finishedLines: WidgetRow[] = [];
    for (const a of finished) {
      const marker = a.id === selectedId ? theme.fg("accent", "●") : theme.fg("dim", "○");
      finishedLines.push({
        record: a,
        lines: [truncate(theme.fg("dim", "├─") + ` ${marker} ` + this.renderFinishedLine(a, theme))],
      });
    }

    const runningLines: WidgetRow[] = []; // each entry is [header, activity]
    for (const a of running) {
      const modeLabel = getPromptModeLabel(a.type);
      const modeTag = modeLabel ? ` ${theme.fg("dim", `(${modeLabel})`)}` : "";
      const elapsed = formatMs(Date.now() - a.startedAt);

      const bg = this.agentActivity.get(a.id);
      const toolUses = bg?.toolUses ?? a.toolUses;
      // Spend comes from the record, never from the activity tracker: the record
      // survives the agent finishing and includes nested-child usage.
      const tokens = getLifetimeTotal(a.lifetimeUsage);
      const contextPercent = getSessionContextPercent(bg?.session);
      const tokenText = tokens > 0 ? formatSessionTokens(tokens, contextPercent, theme, a.compactionCount) : "";
      const costText = this.showCost() ? formatCost(getLifetimeCost(a.lifetimeUsage)) : "";

      const parts: string[] = [];
      if (this.showModel()) {
        const { modelName, tags } = buildInvocationTags(a.invocation);
        if (modelName) parts.push(modelName);
        const thinkingTag = tags.find(tag => tag.startsWith("thinking: "));
        if (thinkingTag) parts.push(thinkingTag);
      }
      if (bg) parts.push(formatTurns(bg.turnCount, bg.maxTurns));
      if (toolUses > 0) parts.push(`${toolUses} tool use${toolUses === 1 ? "" : "s"}`);
      if (tokenText) parts.push(tokenText);
      if (costText) parts.push(costText);
      parts.push(elapsed);
      const statsText = parts.join(" · ");

      const activity = bg ? describeActivity(bg.activeTools, bg.responseText) : "thinking…";

      const marker = a.id === selectedId ? theme.fg("accent", "●") : theme.fg("dim", "○");
      runningLines.push({
        record: a,
        lines: [
          truncate(theme.fg("dim", "├─") + ` ${marker} ${theme.fg("accent", frame)} ${renderAgentName(a.type, theme, { bold: true })}${modeTag}  ${theme.fg("muted", truncateLine(a.description))} ${theme.fg("dim", "·")} ${fgPreservingNestedStyles(theme, "dim", statsText)}`),
          truncate(theme.fg("dim", "│  ") + `   ${theme.fg("dim", `⎿  ${truncateLine(activity)}`)}`),
        ],
      });
    }

    const queuedLines: WidgetRow[] = queued.map(a => {
      const marker = a.id === selectedId ? theme.fg("accent", "●") : theme.fg("dim", "○");
      return {
        record: a,
        lines: [truncate(theme.fg("dim", "├─") + ` ${marker} ${theme.fg("muted", "◦")} ${theme.fg("dim", `${getDisplayName(a.type)}  ${truncateLine(a.description)} · queued`)}`)],
      };
    });

    // Keep the idle widget compact: a queue is one logical status line until
    // navigation starts. While navigating, expand it back to the same per-agent
    // roster used by key handling so every selected queued record can render.
    const queuedSummary: WidgetRow[] = queued.length > 0 && !this.navigationActive
      ? [{
        record: queued[0],
        recordCount: queued.length,
        lines: [truncate(theme.fg("dim", "├─") + ` ${theme.fg("dim", "○")} ${theme.fg("muted", "◦")} ${theme.fg("dim", `${queued.length} queued`)}`)],
      }]
      : [];

    // Assemble with a responsive cap (heading + overflow indicator = 2
    // reserved lines when content exceeds the available body budget).
    const maxBody = maxLines - 1; // heading takes 1 line
    const rows: WidgetRow[] = [
      ...runningLines,
      ...(this.navigationActive ? queuedLines : queuedSummary),
      ...finishedLines,
    ];
    const totalBody = rows.reduce((total, row) => total + row.lines.length, 0);

    const heading = "Agents  ↑↓ select · enter view · esc back";
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
        const lastStart = lines.length - lastRow.lines.length;
        // Keep the selected row's bullet adjacent to the normal branch marker.
        // This makes the active row unambiguous even when it is the last row.
        const lastRowSelected = this.navigationActive && lastRow.record.id === selectedId;
        if (!lastRowSelected) lines[lastStart] = lines[lastStart].replace("├─", "└─");
        if (lastRow.lines.length === 2) {
          lines[lastStart + 1] = lines[lastStart + 1].replace("│  ", "   ");
        }
      }
    } else if (!this.navigationActive && queuedSummary.length > 0) {
      // In the idle view the queue is deliberately one summary row. Preserve
      // that row before spending space on terminal history, and account for
      // the real number of queued records if the summary itself cannot fit.
      // Navigation expands the queue into per-record rows and uses the full
      // contiguous viewport below.
      const visibleRows: WidgetRow[] = [];
      const hiddenRows: WidgetRow[] = [];
      let bodyBudget = Math.max(0, maxBody - 1); // reserve the footer
      let runningBudget = Math.max(0, bodyBudget - 1); // reserve queued summary

      for (const row of runningLines) {
        const height = row.lines.length;
        if (height <= runningBudget) {
          visibleRows.push(row);
          runningBudget -= height;
          bodyBudget -= height;
        } else {
          hiddenRows.push(row);
        }
      }

      const summaryRow = queuedSummary[0];
      if (bodyBudget > 0) {
        visibleRows.push(summaryRow);
        bodyBudget -= summaryRow.lines.length;
      } else {
        hiddenRows.push(summaryRow);
      }

      for (const row of finishedLines) {
        const height = row.lines.length;
        if (height <= bodyBudget) {
          visibleRows.push(row);
          bodyBudget -= height;
        } else {
          hiddenRows.push(row);
        }
      }

      for (const row of visibleRows) lines.push(...row.lines);
      if (visibleRows.length > 0) {
        const lastRow = visibleRows[visibleRows.length - 1];
        const lastStart = lines.length - lastRow.lines.length;
        lines[lastStart] = lines[lastStart].replace("├─", "└─");
        if (lastRow.lines.length === 2) {
          lines[lastStart + 1] = lines[lastStart + 1].replace("│  ", "   ");
        }
      }

      const hiddenCount = (rows: readonly WidgetRow[]): number =>
        rows.reduce((total, row) => total + (row.recordCount ?? 1), 0);
      const categoryCount = (status: string): number => hiddenRows
        .filter(row => row.record.status === status)
        .reduce((total, row) => total + (row.recordCount ?? 1), 0);
      const finishedCount = hiddenRows
        .filter(row => row.record.status !== "running" && row.record.status !== "queued")
        .reduce((total, row) => total + (row.recordCount ?? 1), 0);
      const categoryCounts: string[] = [
        ["running", categoryCount("running")] as [string, number],
        ["queued", categoryCount("queued")] as [string, number],
        ["finished", finishedCount] as [string, number],
      ].filter(([, count]) => count > 0).map(([label, count]) => `${count} ${label}`);
      const hidden = hiddenCount(hiddenRows);
      lines.push(truncate(theme.fg("dim", "└─") + ` ${theme.fg("dim", `+${hidden} more (${categoryCounts.join(", ")})`)}`));
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
      const selectedIndex = this.navigationActive && selectedId
        ? rows.findIndex(row => row.record.id === selectedId)
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
      const visibleBody: string[] = [];
      while (end < rows.length && used + heightAt(end) <= contentBudget) {
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

      const countRows = (selectedRows: readonly WidgetRow[]): number =>
        selectedRows.reduce((total, row) => total + (row.recordCount ?? 1), 0);
      const hiddenBefore = countRows(rows.slice(0, start));
      const hiddenAfter = countRows(rows.slice(end));
      const hidden = hiddenBefore + hiddenAfter;
      const hiddenRows = rows.filter((_row, index) => index < start || index >= end);
      const categoryCount = (status: string): number => hiddenRows
        .filter(row => row.record.status === status)
        .reduce((total, row) => total + (row.recordCount ?? 1), 0);
      const categoryCounts: string[] = [
        ["running", categoryCount("running")] as [string, number],
        ["queued", categoryCount("queued")] as [string, number],
        ["finished", hiddenRows
          .filter(row => row.record.status !== "running" && row.record.status !== "queued")
          .reduce((total, row) => total + (row.recordCount ?? 1), 0)] as [string, number],
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
        // Keep a stable footer row when the selected viewport reaches the end.
        lines.push(truncate(theme.fg("dim", "└─")));
      }
    }

    return lines;
  }

  /** Build a render-relevant snapshot without capturing mutable records. */
  private renderKey(allAgents: ReturnType<AgentManager["listAgents"]>): string {
    const activities = allAgents.map(a => {
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
      agents: allAgents.map(a => ({
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
        hasSession: a.session !== undefined,
        transcriptPath: a.transcriptPath,
        openableHistory: this.cachedCanOpenHistory(a),
      })),
      activities,
      navigationActive: this.navigationActive,
      selectedAgentId: this.selectedAgentId,
      viewportStart: this.viewportStart,
    });
  }

  /** Force an immediate widget update. `advanceSpinner` is reserved for the timer. */
  update(advanceSpinner = false) {
    if (!this.uiCtx) return;
    // Refresh the manager snapshot once per lifecycle update. Arrow handling
    // only changes selection and requests a render; it never scans the manager.
    const roster = this.refreshRoster();
    const allAgents = this.widgetAgents();

    // Lightweight existence checks — full categorization happens in renderWidget()
    let runningCount = 0;
    let queuedCount = 0;
    for (const a of roster) {
      if (a.status === "running") runningCount++;
      else if (a.status === "queued") queuedCount++;
    }
    const hasFinished = roster.some(a => a.status !== "running" && a.status !== "queued");
    const hasActive = runningCount > 0 || queuedCount > 0;

    // Nothing to show — clear widget
    if (!hasActive && !hasFinished) {
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
      this.navigationActive = false;
      this.selectedAgentId = undefined;
      this.selectedRosterIndex = 0;
      this.viewportStart = 0;
      this.syncTimer(false);
      return;
    }

    // Status bar — only call setStatus when the text actually changes
    let newStatusText: string | undefined;
    if (hasActive) {
      const statusParts: string[] = [];
      if (runningCount > 0) statusParts.push(`${runningCount} running`);
      if (queuedCount > 0) statusParts.push(`${queuedCount} queued`);
      const total = runningCount + queuedCount;
      newStatusText = `${statusParts.join(", ")} agent${total === 1 ? "" : "s"}`;
    }
    if (newStatusText !== this.lastStatusText) {
      this.uiCtx.setStatus("subagents", newStatusText);
      this.lastStatusText = newStatusText;
    }

    // Spinner animation is driven only by the timer while a visible running
    // agent exists. Event-driven updates refresh changed stats without making
    // an otherwise idle widget advance.
    if (advanceSpinner && runningCount > 0) this.widgetFrame++;
    this.syncTimer(runningCount > 0);
    const selectedIndex = this.selectedIndexOf(roster);
    if (selectedIndex >= 0) {
      this.selectedRosterIndex = selectedIndex;
    } else if (this.navigationActive) {
      if (roster.length === 0) {
        this.navigationActive = false;
        this.selectedAgentId = undefined;
        this.selectedRosterIndex = 0;
        this.viewportStart = 0;
      } else {
        // Keep the selection near the row that disappeared. Both the saved
        // logical index and viewport are clamped as the roster shrinks.
        const fallbackIndex = Math.max(0, Math.min(this.selectedRosterIndex, roster.length - 1));
        this.selectedAgentId = roster[fallbackIndex].id;
        this.selectedRosterIndex = fallbackIndex;
        this.viewportStart = Math.min(this.viewportStart, roster.length - 1);
      }
    }
    const renderKey = this.renderKey(allAgents);

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
      this.tui?.requestRender();
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
    this.navigationSuspensionDepth = 0;
    this.navigationActive = false;
    this.selectedAgentId = undefined;
    this.selectedRosterIndex = 0;
    this.viewportStart = 0;
    this.cachedAgents = [];
    this.cachedRoster = [];
    this.rosterCacheKey = undefined;
    this.rosterCacheInitialized = false;
    this.historyOpenabilityCache.clear();
    this.uiCtx = undefined;
  }
}
