/**
 * fleet-list.ts — Claude Code-style "FleetView" list rendered below the editor.
 *
 * Shows `main` + each running/queued subagent as a navigable list. Pressing ↓ (or
 * `j`) at an empty prompt activates the list; ↑/↓ move the selection (filled ● marker),
 * Enter opens the selected agent's live conversation overlay, Esc returns to the prompt.
 * A viewer stays open when its agent finishes so the final output remains readable.
 *
 * Mechanics (see plan): the list is a `belowEditor` widget (render-only), and ALL key
 * handling goes through `onTerminalInput` — which fires before the focused editor and
 * can `consume` keys — gated on `getEditorText() === ""` so normal typing is untouched.
 */

import { Editor, isKeyRelease, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "../agent-manager.js";
import { canOpenActiveAgent } from "../agent-history-list.js";
import type { AgentRecord } from "../types.js";
import { getLifetimeTotal } from "../usage.js";
import { type AgentActivity, getDisplayName, type Theme } from "./agent-widget.js";
import { ConversationViewer, VIEWPORT_HEIGHT_PCT } from "./conversation-viewer.js";

/** Widget key for the below-editor fleet list. */
const FLEET_KEY = "fleet";
/** Maximum total rows contributed by FleetView, including hint and indicators. */
export const FLEET_MAX_RENDER_ROWS = 6;
const FLEET_BASE_ROWS = 2; // hint + main
const FLEET_BODY_ROWS = FLEET_MAX_RENDER_ROWS - FLEET_BASE_ROWS;
/** Re-render cadence so elapsed/token stats tick while agents run. */
const TICK_MS = 200;
/** Normalized mouse input accepted by FleetView's widget surface. */
export type FleetMouseEvent = { type: string; wheelDelta?: number };

type FleetMouseResult = { handled: true; render: true };

type FleetWidgetContent = {
  render(width: number): string[];
  invalidate(): void;
  dispose?(): void;
  handleMouse?(event: FleetMouseEvent): FleetMouseResult | undefined;
};

/** Minimal UI surface the FleetView needs from `ctx.ui` (structural subset). */
export type FleetUICtx = {
  setWidget(
    key: string,
    content: undefined | ((tui: any, theme: Theme) => FleetWidgetContent),
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
  onTerminalInput(handler: (data: string) => { consume?: boolean; data?: string } | undefined): () => void;
  getEditorText(): string;
  notify(message: string, type?: "info" | "warning" | "error"): void;
  custom<T>(
    factory: (tui: any, theme: Theme, keybindings: any, done: (result: T) => void) => { render(width: number): string[]; invalidate(): void; dispose?(): void },
    options?: { overlay?: boolean; overlayOptions?: unknown; onHandle?: (handle: unknown) => void },
  ): Promise<T>;
};

type MainEntry = { kind: "main" };
type AgentEntry = { kind: "agent"; record: AgentRecord };
type FleetEntry = MainEntry | AgentEntry;

/** `11s` — integer seconds, no decimal/suffix (matches Claude Code, unlike formatMs). */
export function formatFleetElapsed(ms: number): string {
  return `${Math.max(0, Math.round(ms / 1000))}s`;
}

/** `↓ 13.1k tokens` — down-arrow prefix, compact magnitude, plural "tokens". */
export function formatFleetTokens(count: number): string {
  let compact: string;
  if (count >= 1_000_000) compact = `${(count / 1_000_000).toFixed(1)}M`;
  else if (count >= 1_000) compact = `${(count / 1_000).toFixed(1)}k`;
  else compact = `${count}`;
  return `↓ ${compact} tokens`;
}

/** A bounded slice of the agent-only roster rendered by FleetView. */
export type FleetAgentWindow = {
  start: number;
  end: number;
  hiddenAbove: number;
  hiddenBelow: number;
};

/**
 * Calculate a bounded agent slice from an agent-only viewport start.
 * `end` is exclusive; `main` is rendered separately and is not part of this
 * window. Marker rows are reserved only when the corresponding side is hidden.
 */
export function calculateFleetAgentWindow(
  agentCount: number,
  viewportStart: number,
): FleetAgentWindow {
  const count = Math.max(0, Math.floor(agentCount));
  if (count === 0) return { start: 0, end: 0, hiddenAbove: 0, hiddenBelow: 0 };

  const maxStart = Math.max(0, count - (FLEET_BODY_ROWS - 1));
  const start = Math.min(maxStart, Math.max(0, Math.floor(viewportStart)));
  const hasAbove = start > 0;
  const agentBudget = Math.max(1, FLEET_BODY_ROWS - (hasAbove ? 1 : 0));
  let end = Math.min(count, start + agentBudget);
  if (end < count) end -= 1; // reserve the ↓ marker row

  return {
    start,
    end,
    hiddenAbove: start,
    hiddenBelow: count - end,
  };
}

/**
 * Return the smallest viewport adjustment that makes an agent visible. The
 * selected index is 0-based within the agent-only roster; `main` is handled by
 * FleetList rather than this pure helper.
 */
export function ensureFleetSelectionVisible(
  agentCount: number,
  selectedAgentIndex: number,
  viewportStart: number,
): number {
  const count = Math.max(0, Math.floor(agentCount));
  if (count === 0) return 0;

  const selected = Math.min(
    count - 1,
    Math.max(0, Math.floor(selectedAgentIndex)),
  );
  const maxStart = Math.max(0, count - (FLEET_BODY_ROWS - 1));
  let start = Math.min(maxStart, Math.max(0, Math.floor(viewportStart)));
  const current = calculateFleetAgentWindow(count, start);

  if (selected < current.start) {
    return Math.min(maxStart, selected);
  }
  if (selected < current.end) return start;

  // With a possible ↓ marker, selected - 1 is the least forward shift that
  // exposes the selected row while preserving the marker row budget.
  return Math.min(maxStart, Math.max(start, selected - 1));
}

/**
 * Place `right` flush to `width`, truncating `left` first so the stats survive.
 * The final clamp guarantees the line never exceeds `width` (which would wrap and
 * desync pi's line-diff → flicker) even on a terminal too narrow for the stats.
 */
function rightAlign(left: string, right: string, width: number): string {
  const rightW = visibleWidth(right);
  const maxLeft = Math.max(0, width - rightW - 1);
  const leftClamped = truncateToWidth(left, maxLeft);
  const gap = Math.max(1, width - visibleWidth(leftClamped) - rightW);
  return truncateToWidth(leftClamped + " ".repeat(gap) + right, width);
}

export class FleetList {
  private ui: FleetUICtx | undefined;
  private tui: any | undefined;
  private inputUnsub: (() => void) | undefined;
  private widgetRegistered = false;
  private lastRosterKey: string | undefined;
  private lastRenderKey: string | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

  private enabled = true;
  /** Whether arrow keys currently navigate the list (vs. flow to the editor). */
  private active = false;
  /** 0 = `main`, 1..N = subagents. */
  private selectedIndex = 0;
  /** 0-based start in the agent-only roster; main is rendered separately. */
  private viewportStart = 0;
  /** Set while a conversation overlay is open; calling it closes the overlay. */
  private viewerClose: (() => void) | undefined;
  private viewingAgentId: string | undefined;

  constructor(
    private manager: AgentManager,
    private agentActivity: Map<string, AgentActivity>,
    private getCwd: () => string | undefined = () => undefined,
    private pi?: ExtensionAPI,
    private getCtx: () => ExtensionContext | undefined = () => undefined,
  ) {}

  // ---- Lifecycle ----

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (!enabled) this.active = false;
    this.update();
  }

  /** Capture the UI context and (re)register the global input handler. */
  setUICtx(ui: FleetUICtx): boolean {
    if (ui === this.ui) return false;
    this.inputUnsub?.();
    this.ui = ui;
    this.widgetRegistered = false;
    this.lastRosterKey = undefined;
    this.lastRenderKey = undefined;
    this.tui = undefined;
    this.inputUnsub = ui.onTerminalInput(data => this.handleKey(data));
    return true;
  }

  /** Request a render on the currently registered TUI without touching input. */
  requestUiRefresh(force = true): boolean {
    if (!this.tui) return false;
    this.tui.requestRender(force);
    return true;
  }

  /** Ensure the re-render timer is running (called when an agent spawns). */
  ensureTimer(): void {
    if (!this.timer) this.timer = setInterval(() => this.update(), TICK_MS);
  }

  /**
   * Called when an agent finishes. The viewer (if open on it) stays open so the
   * final output remains readable; refresh the active-only roster.
   */
  onAgentFinished(_id: string): void {
    this.update();
  }

  dispose(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    this.inputUnsub?.();
    this.inputUnsub = undefined;
    if (this.viewerClose) { this.viewerClose(); this.viewerClose = undefined; }
    this.viewingAgentId = undefined;
    if (this.ui && this.widgetRegistered) this.ui.setWidget(FLEET_KEY, undefined);
    this.widgetRegistered = false;
    this.lastRosterKey = undefined;
    this.lastRenderKey = undefined;
    this.tui = undefined;
    this.active = false;
    this.selectedIndex = 0;
    this.viewportStart = 0;
    // Null last so a `viewerClose()` microtask above can't re-register the widget.
    this.ui = undefined;
  }

  /** Re-register/refresh the below-editor widget; clears it when no agents remain. */
  update(): void {
    if (!this.ui) return;
    const records = this.agentRecords();
    const hasAgents = this.enabled && records.length > 0;
    const rosterKey = records.map(record => record.id).join("\0");
    const rosterChanged = rosterKey !== this.lastRosterKey;
    this.lastRosterKey = rosterKey;

    if (!hasAgents) {
      if (this.widgetRegistered) {
        this.ui.setWidget(FLEET_KEY, undefined);
        this.widgetRegistered = false;
        this.tui = undefined;
      }
      if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
      this.active = false;
      this.selectedIndex = 0;
      this.viewportStart = 0;
      this.lastRosterKey = undefined;
      this.lastRenderKey = undefined;
      return;
    }

    this.clampSelection();
    this.ensureSelectionVisible();
    this.ensureTimer(); // keep stats ticking whenever the list is shown (e.g. after a re-enable)
    const renderKey = this.renderKey(records);

    if (!this.widgetRegistered) {
      this.ui.setWidget(FLEET_KEY, (tui, theme) => {
        this.tui = tui;
        return {
          render: (w: number) => this.renderBar(w, theme),
          invalidate: () => { this.widgetRegistered = false; this.tui = undefined; },
          handleMouse: (event: FleetMouseEvent) => this.handleMouse(event),
        };
      }, { placement: "belowEditor" });
      this.widgetRegistered = true;
    } else if (renderKey !== this.lastRenderKey) {
      // The timer runs more frequently than elapsed time is displayed. Avoid
      // waking the TUI when the visible FleetView snapshot is unchanged, but
      // preserve a forced redraw when rows were added/removed.
      this.tui?.requestRender(rosterChanged);
    }
    this.lastRenderKey = renderKey;
  }

  /**
   * Return only values that affect `renderBar()`. Elapsed time is rendered in
   * whole seconds, so the 200ms timer can skip four out of five updates while
   * still refreshing the row at the visible cadence.
   */
  private renderKey(records: AgentRecord[]): string {
    const now = Date.now();
    const agentState = records.map(record => {
      const activity = this.agentActivity.get(record.id);
      const usage = activity?.lifetimeUsage ?? record.lifetimeUsage;
      return [
        record.id,
        record.type,
        record.description,
        record.status,
        record.startedAt,
        record.completedAt ?? "",
        getLifetimeTotal(usage),
        Math.round(((record.completedAt ?? now) - record.startedAt) / 1000),
      ].join("\u001f");
    });
    return [
      this.enabled ? "1" : "0",
      this.active ? "1" : "0",
      String(this.selectedIndex),
      String(this.viewportStart),
      ...agentState,
    ].join("\u001e");
  }

  // ---- Roster ----

  /**
   * Active agents shown in the list, ordered earliest-launched first so the
   * ones you started sooner sit at the top. Pending agents with no session yet
   * are hidden until they start. (`listAgents()` is newest-first, so we
   * re-sort.)
   */
  private agentRecords(): AgentRecord[] {
    return this.manager.listAgents()
      .filter(record => canOpenActiveAgent(record))
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  private roster(): FleetEntry[] {
    return [{ kind: "main" }, ...this.agentRecords().map(record => ({ kind: "agent" as const, record }))];
  }

  private clampSelection(): void {
    const max = this.roster().length - 1;
    if (this.selectedIndex > max) this.selectedIndex = Math.max(0, max);
    if (this.selectedIndex < 0) this.selectedIndex = 0;
  }

  /** Keep the selected agent visible without recentering an already-valid window. */
  private ensureSelectionVisible(): void {
    const agents = this.agentRecords();
    if (agents.length === 0) {
      this.viewportStart = 0;
      return;
    }
    if (this.selectedIndex > 0) {
      this.viewportStart = ensureFleetSelectionVisible(
        agents.length,
        this.selectedIndex - 1,
        this.viewportStart,
      );
      return;
    }
    // `main` does not constrain the agent window, but a roster shrink can make
    // its previous start invalid. Use the same pure clamp as renderBar.
    this.viewportStart = calculateFleetAgentWindow(agents.length, this.viewportStart).start;
  }

  // ---- Key handling ----

  /**
   * Move the selection while keeping keyboard and wheel input on one path.
   * Returns whether the direction was handled; inactive upward input and input
   * that cannot activate the list are left for the editor/transcript.
   */
  private moveSelection(direction: -1 | 1): boolean {
    const max = this.roster().length - 1;
    if (max < 0) return false;

    if (!this.active) {
      // Match ↓ activation: only a downward direction at an empty prompt with
      // the editor focused enters the list. Upward input remains a no-op.
      if (direction !== 1 || !this.editorHasFocus() || this.agentRecords().length === 0 || this.ui?.getEditorText() !== "") {
        return false;
      }
      this.active = true;
      this.selectedIndex = 0;
      this.viewportStart = 0;
      this.update();
      return true;
    }

    this.clampSelection();
    if (direction === -1 && this.selectedIndex === 0) {
      this.deactivate();
      return true;
    }
    this.selectedIndex = direction === 1
      ? Math.min(max, this.selectedIndex + 1)
      : Math.max(0, this.selectedIndex - 1);
    this.ensureSelectionVisible();
    this.update();
    return true;
  }

  /** Handle normalized wheel input from the registered widget. */
  handleMouse(event: FleetMouseEvent): FleetMouseResult | undefined {
    if (!this.enabled || !this.ui || this.viewerClose) return undefined;
    if (event.type !== "wheel") return undefined;

    const wheelDelta = event.wheelDelta;
    const direction: -1 | 1 | undefined = wheelDelta == null
      ? undefined
      : wheelDelta < 0
        ? -1
        : wheelDelta > 0
          ? 1
          : undefined;
    if (!direction || !this.moveSelection(direction)) return undefined;

    // The widget handled the normalized wheel, including at selection
    // boundaries; explicitly request a redraw so it never falls through to
    // Pi's transcript fallback.
    return { handled: true, render: true };
  }

  /** Returns `{consume:true}` to swallow a key, or undefined to let it through. */
  handleKey(data: string): { consume?: boolean; data?: string } | undefined {
    if (!this.enabled || !this.ui) return undefined;
    // Input listeners receive BOTH key-press and key-release (the kitty protocol
    // emits both, and matchesKey matches either) — act on press only, or every
    // tap would move/fire twice. Repeats still pass through for held-key nav.
    if (isKeyRelease(data)) return undefined;
    // While an overlay is open, let it own all input.
    if (this.viewerClose) return undefined;
    // Input listeners fire BEFORE the focused component, and dialogs
    // (ctx.ui.select/confirm/input, pi's own menus) swap the prompt editor out
    // while getEditorText() still reads the detached — empty — editor. So when
    // anything but the editor owns the keyboard, stay out of its keys (#123).
    if (!this.editorHasFocus()) {
      if (this.active) this.deactivate();
      return undefined;
    }

    const direction: -1 | 1 | undefined = matchesKey(data, "down") || matchesKey(data, "j")
      || (!this.active && matchesKey(data, "left"))
      ? 1
      : matchesKey(data, "up") || matchesKey(data, "k")
        ? -1
        : undefined;
    if (direction && this.moveSelection(direction)) return { consume: true };

    if (!this.active) return undefined;

    // Active — Enter opens, Esc / Up-past-top exits.
    if (matchesKey(data, "escape")) { this.deactivate(); return { consume: true }; }
    if (matchesKey(data, Key.enter)) { this.openSelected(); return { consume: true }; }

    // Any other key cancels navigation and flows to the editor.
    this.deactivate();
    return undefined;
  }

  /**
   * True when pi's prompt editor owns the keyboard. pi's editor is an `Editor`
   * subclass (CustomEditor) while every dialog/selector is not, and the loader
   * aliases pi-tui to pi's own copy, so `instanceof` is a reliable identity
   * check. `focusedComponent` is TUI-private (no public accessor), hence the
   * best-effort peek: unknowable focus (no tui seen yet, nothing focused)
   * counts as the editor so activation keeps working.
   */
  private editorHasFocus(): boolean {
    const focused = (this.tui as { focusedComponent?: unknown } | undefined)?.focusedComponent;
    return focused == null || focused instanceof Editor;
  }

  private deactivate(): void {
    this.active = false;
    this.selectedIndex = 0;
    this.viewportStart = 0;
    this.update();
  }

  private openSelected(): void {
    const entry = this.roster()[this.selectedIndex];
    if (!entry || entry.kind === "main") {
      // `main` = return to the prompt; the native transcript is already shown.
      this.deactivate();
      return;
    }
    const record = entry.record;
    if (!this.ui) return;
    if (!canOpenActiveAgent(record) || !record.session) {
      this.ui.notify(`Agent is ${record.status} — no live session available.`, "info");
      return;
    }
    const session = record.session;
    const ctx = this.getCtx();
    const pi = this.pi;
    if (!ctx || !pi) {
      this.ui.notify("Agent conversation is unavailable — no active session.", "info");
      return;
    }
    const activity = this.agentActivity.get(record.id);
    this.viewingAgentId = record.id;

    void this.ui.custom<undefined>(
      (tui, theme, keybindings, done) => {
        this.viewerClose = () => done(undefined);
        return new ConversationViewer(
          tui,
          session,
          record,
          activity,
          theme,
          done,
          () => {
            if (this.manager.abort(record.id)) this.ui?.notify(`Stopped "${record.description}".`, "info");
          },
          keybindings,
          (message: string) => this.manager.steer(record.id, message),
          { pi, ctx, readOnly: false },
        );
      },
      {
        overlay: true,
        overlayOptions: { anchor: "center", width: "90%", maxHeight: `${VIEWPORT_HEIGHT_PCT}%` },
      },
    ).then(() => this.clearViewer(), () => this.clearViewer());
  }

  /** Reset overlay state and return to the list (on close, auto-close, or error). */
  private clearViewer(): void {
    // Keep the cursor on the agent we were viewing — re-resolve by id so it
    // still feels natural if the list reordered (an earlier agent finished)
    // while the overlay was open. If that agent is gone, leave the index for
    // update()'s clamp to settle.
    if (this.viewingAgentId) {
      const idx = this.roster().findIndex(e => e.kind === "agent" && e.record.id === this.viewingAgentId);
      if (idx >= 0) this.selectedIndex = idx;
    }
    this.viewerClose = undefined;
    this.viewingAgentId = undefined;
    this.update();
  }

  // ---- Rendering ----

  private renderBar(width: number, theme: Theme): string[] {
    const agents = this.roster().slice(1) as AgentEntry[];
    if (agents.length === 0) return [];
    // Clamp locally so a render between a roster shrink and the next update()
    // (e.g. on terminal resize) never loses the selection marker.
    const sel = Math.min(this.selectedIndex, agents.length);

    const hint = this.active
      ? "↑↓ select · enter view · esc back"
      : "esc to interrupt · ↓ to manage";
    const lines: string[] = [];
    lines.push(truncateToWidth("  " + theme.fg("dim", hint), width));
    lines.push(truncateToWidth(`  ${this.bullet(0, sel, theme)} main`, width));

    const window = calculateFleetAgentWindow(agents.length, this.viewportStart);
    if (window.hiddenAbove > 0) {
      lines.push(rightAlign("", theme.fg("dim", `↑ ${window.hiddenAbove} more`), width));
    }
    for (let a = window.start; a < window.end; a++) {
      lines.push(this.renderAgentRow(a + 1, sel, agents[a].record, width, theme));
    }
    if (window.hiddenBelow > 0) {
      lines.push(rightAlign("", theme.fg("dim", `↓ ${window.hiddenBelow} more`), width));
    }

    return lines;
  }

  private bullet(rosterIndex: number, sel: number, theme: Theme): string {
    return rosterIndex === sel ? theme.fg("accent", "●") : theme.fg("dim", "○");
  }

  private renderAgentRow(rosterIndex: number, sel: number, record: AgentRecord, width: number, theme: Theme): string {
    const left = `  ${this.bullet(rosterIndex, sel, theme)} ${theme.fg("muted", getDisplayName(record.type))}  ${record.description}`;
    const tokens = getLifetimeTotal(this.agentActivity.get(record.id)?.lifetimeUsage ?? record.lifetimeUsage);
    const elapsedMs = (record.completedAt ?? Date.now()) - record.startedAt; // freezes once finished
    const right = theme.fg("dim", `${formatFleetElapsed(elapsedMs)} · ${formatFleetTokens(tokens)}`);
    return rightAlign(left, right, width);
  }
}
