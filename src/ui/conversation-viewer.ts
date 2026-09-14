/**
 * conversation-viewer.ts — Live and historical conversation overlay.
 *
 * The viewer deliberately keeps rendering state separate from the transcript:
 * blocks are formatted data, while Markdown/ANSI lines are a bounded cache.
 */

import type { ExtensionAPI, ExtensionContext, AgentSession } from "@earendil-works/pi-coding-agent";
import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import { type Component, Input, Key, matchesKey, type TUI, type TuiMouseEvent, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentRecord } from "../types.js";
import { getLifetimeTotal, getSessionContextPercent } from "../usage.js";
import type { Theme } from "./agent-widget.js";
import { type AgentActivity, buildInvocationTags, describeActivity, fgPreservingNestedStyles, formatDuration, formatSessionTokens, getDisplayName, getPromptModeLabel } from "./agent-widget.js";
import { formatConversationMessages, type ConversationBlock } from "./conversation-blocks.js";
import { ConversationTimeline, type ConversationTimelineChange, type TimelineRenderLine } from "./conversation-timeline.js";
import { renderConversationRoleHeader } from "./conversation-role.js";
import { editLiveAssistantBlockInNvim, viewConversationBlockInNvim } from "./conversation-nvim.js";
import { findConversationMatches, highlightConversationLine, nearestConversationMatchAfter, nearestConversationMatchBefore, stripAnsi, type ConversationMatch } from "./conversation-search.js";
import { createViewerKeys, type ViewerKeybindings, type ViewerKeys } from "./viewer-keys.js";
import { createViewerCcstyleResult } from "./ccstyle/tool-result.js";

/** Base lines consumed by the overlay: borders, header, separator and footer. */
const CHROME_LINES_BASE = 6;
const MIN_VIEWPORT = 3;
export const VIEWPORT_HEIGHT_PCT = 70;
const MAX_COPY_CHARS = 500_000;
const MATCH_BG = "\x1b[48;5;238m";
const MATCH_BG_CURRENT = "\x1b[48;5;220m\x1b[30m";
const BG_RESET = "\x1b[49m\x1b[39m";

/** The live fields needed by the viewer; historical viewers use a static source. */
export type ConversationSource = Pick<AgentSession, "messages" | "subscribe">;

export function createStaticConversationSource(
  messages: AgentSession["messages"],
): ConversationSource {
  return { messages, subscribe: () => () => {} };
}

type RenderLine = TimelineRenderLine;

const FULL_TOOL_PREVIEW_MAX_CHARS = 500_000;

class FullToolPreview implements Component {
  private scrollOffset = 0;
  private pageSize = 1;
  private totalLines = 1;
  private pendingTop = false;
  private hoveredClose = false;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly title: string,
    private readonly body: Component,
    private readonly done: (result: undefined) => void,
  ) {}

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, "q")) {
      this.done(undefined);
      return;
    }
    if (data === "g") {
      if (this.pendingTop) this.scrollTo(0);
      this.pendingTop = true;
      return;
    }
    const delta = data === "j" || matchesKey(data, Key.down) ? 1 :
      data === "k" || matchesKey(data, Key.up) ? -1 :
      matchesKey(data, "pageUp") ? -this.pageSize : matchesKey(data, "pageDown") ? this.pageSize :
      matchesKey(data, Key.home) ? -this.totalLines : data === "G" || matchesKey(data, Key.end) ? this.totalLines : 0;
    this.pendingTop = false;
    if (delta !== 0) this.scrollTo(this.scrollOffset + delta);
  }

  handleMouse(event: TuiMouseEvent): { handled?: boolean; capture?: boolean; render?: boolean } | undefined {
    const closeHit = event.y === 1 && event.x >= Math.max(0, event.width - 7) && event.x < Math.max(0, event.width - 1);
    if (event.type === "move") {
      if (closeHit === this.hoveredClose) return undefined;
      this.hoveredClose = closeHit;
      return { handled: true, render: true };
    }
    if (closeHit && event.button === "left") {
      if (event.type === "press") return { handled: true, capture: true, render: false };
      if (event.type === "click") {
        this.done(undefined);
        return { handled: true, render: false };
      }
    }
    if (event.type === "wheel") {
      this.scrollTo(this.scrollOffset + Math.trunc(event.wheelDelta ?? 0));
      return { handled: true, render: true };
    }
    return undefined;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(12, Math.floor(Number.isFinite(width) ? width : 12));
    const inner = Math.max(1, safeWidth - 2);
    const bodyWidth = Math.max(1, inner - 1);
    const terminalRows = Math.max(1, this.tui.terminal.rows);
    const viewport = Math.max(1, Math.min(30, Math.floor(terminalRows * 0.8), terminalRows - 6));
    const wrapped = this.body.render(bodyWidth);
    this.totalLines = wrapped.length;
    this.pageSize = viewport;
    this.scrollOffset = Math.min(this.scrollOffset, Math.max(0, this.totalLines - this.pageSize));
    const visible = wrapped.slice(this.scrollOffset, this.scrollOffset + this.pageSize);
    const border = (text: string) => this.theme.fg("border", text);
    const pad = (text: string, rowWidth = inner): string => {
      const clipped = truncateToWidth(text, rowWidth, "…", true);
      return clipped + " ".repeat(Math.max(0, rowWidth - visibleWidth(clipped)));
    };
    const close = this.theme.fg(this.hoveredClose ? "text" : "dim", "[esc]");
    const header = this.theme.bold(this.theme.fg("accent", this.title));
    const status = `${this.scrollOffset + 1}-${Math.min(this.totalLines, this.scrollOffset + this.pageSize)} / ${this.totalLines} lines · j/k gg/G ↑↓ PgUp/PgDn · [esc] close`;
    return [
      border(`╭${"─".repeat(inner)}╮`),
      `${border("│")}${pad(` ${header}`, inner - visibleWidth(close))}${close}${border("│")}`,
      `${border("├")}${border("─".repeat(inner))}${border("┤")}`,
      ...Array.from({ length: viewport }, (_, index) => `${border("│")}${pad(` ${visible[index] ?? ""}`, bodyWidth)}${border("│")}`),
      `${border("├")}${border("─".repeat(inner))}${border("┤")}`,
      `${border("│")}${pad(this.theme.fg("dim", ` ${status}`))}${border("│")}`,
      border(`╰${"─".repeat(inner)}╯`),
    ];
  }

  invalidate(): void {
    this.body.invalidate();
  }

  private scrollTo(offset: number): void {
    const next = Math.max(0, Math.min(Math.max(0, this.totalLines - this.pageSize), offset));
    if (next === this.scrollOffset) return;
    this.scrollOffset = next;
    this.tui.requestRender();
  }
}

/** Optional operations are appended so all existing constructor call sites stay valid. */
export interface ConversationViewerOperations {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  readOnly?: boolean;
}

export class ConversationViewer implements Component {
  private blocks: ConversationBlock[] = [];
  private showTools = true;
  private selectedMessageIdx = 0;
  private hasFocusedBlock = false;
  private cachedWidth = 0;
  private cachedLines: RenderLine[] = [];
  private cachedMessageStarts: number[] = [];
  private cachedMessageBlocks: ConversationBlock[] = [];
  private cacheVersion = 0;
  private cachedVersion = -1;
  private sessionRefreshQueued = false;
  private selectedBlockId: string | undefined;
  private scrollOffset = 0;
  private autoScroll = true;
  private unsubscribe: (() => void) | undefined;
  private lastInnerW = 0;
  private closed = false;
  private stopArmed = false;
  private hoveredClose = false;
  private keys: ViewerKeys;
  private composer: Input | undefined;
  private searchMode = false;
  private searchQuery = "";
  private searchMatches: ConversationMatch[] = [];
  private currentMatchIdx = -1;
  private timeline: ConversationTimeline;

  constructor(
    private tui: TUI,
    private session: ConversationSource,
    private record: AgentRecord,
    private activity: AgentActivity | undefined,
    private theme: Theme,
    private done: (result: undefined) => void,
    /** Abort the agent shown here. Omitted means read-only history. */
    private onStop?: () => void,
    /** User keybindings from ctx.ui.custom(). */
    keybindings?: ViewerKeybindings,
    /** Send a steering message to the agent. */
    private onSteer?: (message: string) => void,
    /** Optional clipboard/nvim operation context, appended for compatibility. */
    private operations?: ConversationViewerOperations,
  ) {
    this.keys = createViewerKeys(keybindings);
    this.blocks = formatConversationMessages(session.messages);
    this.timeline = new ConversationTimeline(tui, theme, {
      cwd: operations?.ctx.cwd,
      record,
      onChange: (change) => this.handleTimelineChange(change),
    });
    this.timeline.setBlocks(this.blocks);
    this.unsubscribe = session.subscribe(() => this.scheduleSessionRefresh());
  }

  handleInput(data: string): void {
    if (this.composer) {
      this.composer.handleInput(data);
      this.tui.requestRender();
      return;
    }
    if (this.searchMode) {
      this.handleSearchInput(data);
      return;
    }
    if (matchesKey(data, "escape") || matchesKey(data, "q")) {
      this.closed = true;
      this.done(undefined);
      return;
    }
    if (matchesKey(data, "enter")) {
      this.buildContentLines(this.lastInnerW || 80);
      if (this.timeline.isToolFocused()) {
        this.timeline.toggleFocusedTool();
        return;
      }
    }
    if (data === "e" && this.canSteer()) {
      this.stopArmed = false;
      this.openComposer();
      return;
    }
    if (matchesKey(data, "x")) {
      if (this.isStoppable()) {
        if (this.stopArmed) {
          this.stopArmed = false;
          this.onStop?.();
        } else {
          this.stopArmed = true;
        }
        this.tui.requestRender();
      }
      return;
    }
    if (this.stopArmed) this.stopArmed = false;

    // Input can arrive before the first render in tests and in a freshly-opened overlay.
    this.buildContentLines(this.lastInnerW || 80);
    const viewportHeight = this.viewportHeight();
    const maxScroll = Math.max(0, this.cachedLines.length - viewportHeight);

    if (data === "t") {
      this.showTools = !this.showTools;
      this.timeline.setShowTools(this.showTools);
      this.invalidate();
      this.tui.requestRender();
    } else if (data === "\t") {
      this.moveToolFocus(1);
    } else if (matchesKey(data, Key.shift("tab"))) {
      this.moveToolFocus(-1);
    } else if (data === "J" || matchesKey(data, Key.shift("j"))) {
      this.jumpToMessage(1);
    } else if (data === "K" || matchesKey(data, Key.shift("k"))) {
      this.jumpToMessage(-1);
    } else if (data === "]") {
      this.focusNearbyTool(1);
    } else if (data === "[") {
      this.focusNearbyTool(-1);
    } else if (data === "w") {
      this.openFocusedToolPreview();
    } else if (data === "g") {
      this.scrollToTop();
    } else if (data === "G" || matchesKey(data, Key.shift("g"))) {
      this.scrollToBottom();
    } else if (data === "/") {
      this.enterSearch();
    } else if (data === "n") {
      this.gotoMatch(1);
    } else if (data === "N") {
      this.gotoMatch(-1);
    } else if (data === "M") {
      void this.copyCurrentMessage();
    } else if (data === "o") {
      void this.viewCurrentInNvim();
    } else if (data === "O" && this.isLive()) {
      void this.editCurrentInNvim();
    } else if (this.keys.scrollUp(data)) {
      this.scrollBy(-1);
    } else if (this.keys.scrollDown(data)) {
      this.scrollBy(1);
    } else if (this.keys.pageUp(data)) {
      this.scrollBy(-viewportHeight);
    } else if (this.keys.pageDown(data)) {
      this.scrollBy(viewportHeight);
    } else if (matchesKey(data, "home")) {
      this.scrollOffset = 0;
      this.setFocusFromMessageIndex(0);
      this.autoScroll = false;
      this.invalidate();
      this.tui.requestRender();
    } else if (matchesKey(data, "end")) {
      this.scrollToBottom();
    }

    // Keep the computed max alive for the key path even when the cache is empty.
    void maxScroll;
  }

  handleMouse(event: TuiMouseEvent): { handled?: boolean; capture?: boolean; render?: boolean } | undefined {
    const innerW = Math.max(1, this.lastInnerW || event.width - 4);
    const closeHit = this.isCloseButtonHit(event.x, event.y, innerW);
    if (event.type === "move") {
      const closeChanged = closeHit !== this.hoveredClose;
      this.hoveredClose = closeHit;
      if (this.composer || this.searchMode) return closeChanged ? { handled: true, render: true } : undefined;
      const contentLines = this.buildContentLines(innerW);
      const viewportHeight = this.viewportHeight();
      const maxScroll = Math.max(0, contentLines.length - viewportHeight);
      if (this.autoScroll) this.scrollOffset = maxScroll;
      const visibleStart = Math.min(this.scrollOffset, maxScroll);
      const contentOrigin = 3 + (this.invocationLine() ? 1 : 0);
      const contentY = event.y - contentOrigin + visibleStart;
      const timelineResult = this.timeline.handleMouse({ ...event, y: contentY });
      return timelineResult ?? (closeChanged ? { handled: true, render: true } : undefined);
    }
    if (closeHit && event.button === "left") {
      if (event.type === "press") return { handled: true, capture: true, render: false };
      if (event.type === "click") {
        this.closed = true;
        this.done(undefined);
        return { handled: true, render: false };
      }
    }
    if (this.composer || this.searchMode) return undefined;
    const contentLines = this.buildContentLines(innerW);
    const viewportHeight = this.viewportHeight();
    const maxScroll = Math.max(0, contentLines.length - viewportHeight);
    const visibleStart = Math.min(this.scrollOffset, maxScroll);
    const contentOrigin = 3 + (this.invocationLine() ? 1 : 0);
    if (event.type === "wheel") {
      if (event.y < contentOrigin || event.y >= contentOrigin + viewportHeight) return undefined;
      this.scrollBy(Math.trunc(event.wheelDelta ?? 0));
      return { handled: true, render: true };
    }
    const contentY = event.y - contentOrigin + visibleStart;
    if (contentY < 0 || contentY >= contentLines.length) return undefined;
    // Rows have one leading space and one trailing space inside the frame.
    // Neither padding nor the frame itself is a focus target.
    if ((event.type === "click" || event.type === "press") && (event.x < 2 || event.x >= 2 + innerW)) return undefined;
    const result = this.timeline.handleMouse({ ...event, y: contentY });
    if (result?.handled && event.type === "click") {
      let selected = result.focusedBlockIndex;
      if (selected === undefined) {
        const focusedTool = this.timeline.getFocusedToolCallId();
        selected = this.timeline.getSnapshot().messageBlocks.findIndex((block) => block.toolCallId === focusedTool);
      }
      if (selected !== undefined && selected >= 0) {
        this.buildContentLines(innerW);
        this.setFocusFromMessageIndex(selected);
        this.autoScroll = false;
        this.scrollTargetIntoView(selected);
        this.tui.requestRender();
      }
    }
    return result;
  }

  private isCloseButtonHit(x: number, y: number, innerW: number): boolean {
    if (y !== 1) return false;
    const labelWidth = visibleWidth("[esc]");
    const labelStart = 2 + Math.max(0, innerW - labelWidth);
    return x >= labelStart && x < 2 + innerW;
  }

  render(width: number): string[] {
    if (width < 6) return [];
    const th = this.theme;
    const innerW = Math.max(1, width - 4);
    this.lastInnerW = innerW;
    const lines: string[] = [];
    const pad = (s: string, len: number) => s + " ".repeat(Math.max(0, len - visibleWidth(s)));
    const row = (content: string) => th.fg("border", "│") + " " + truncateToWidth(pad(content, innerW), innerW, "...", true) + " " + th.fg("border", "│");
    const hrTop = th.fg("border", `╭${"─".repeat(Math.max(0, width - 2))}╮`);
    const hrBot = th.fg("border", `╰${"─".repeat(Math.max(0, width - 2))}╯`);
    const hrMid = row(th.fg("dim", "─".repeat(innerW)));

    lines.push(hrTop);
    const name = getDisplayName(this.record.type);
    const modeLabel = getPromptModeLabel(this.record.type);
    const modeTag = modeLabel ? ` ${th.fg("dim", `(${modeLabel})`)}` : "";
    const statusIcon = this.record.status === "running" ? th.fg("accent", "●") : this.record.status === "completed" ? th.fg("success", "✓") : this.record.status === "error" ? th.fg("error", "✗") : th.fg("dim", "○");
    const duration = formatDuration(this.record.startedAt, this.record.completedAt);
    const headerParts: string[] = [duration];
    const toolUses = this.activity?.toolUses ?? this.record.toolUses;
    if (toolUses > 0) headerParts.unshift(`${toolUses} tool${toolUses === 1 ? "" : "s"}`);
    const tokens = getLifetimeTotal(this.activity?.lifetimeUsage);
    if (tokens > 0) {
      const percent = getSessionContextPercent(this.activity?.session);
      headerParts.push(formatSessionTokens(tokens, percent, th, this.record.compactionCount));
    }
    const headerText = `${statusIcon} ${th.bold(name)}${modeTag}  ${th.fg("muted", this.record.description)} ${th.fg("dim", "·")} ${fgPreservingNestedStyles(th, "dim", headerParts.join(" · "))}`;
    const closeLabel = this.hoveredClose ? th.fg("text", th.bold("[esc]")) : th.fg("dim", "[esc]");
    const closeWidth = visibleWidth(closeLabel);
    const headerLeft = truncateToWidth(headerText, Math.max(0, innerW - closeWidth - 1), "", true);
    const headerGap = Math.max(1, innerW - visibleWidth(headerLeft) - closeWidth);
    lines.push(row(headerLeft + " ".repeat(headerGap) + closeLabel));
    const invocationLine = this.invocationLine();
    if (invocationLine) lines.push(row(invocationLine));
    lines.push(hrMid);

    const contentLines = this.buildContentLines(innerW);
    const viewportHeight = this.viewportHeight();
    const maxScroll = Math.max(0, contentLines.length - viewportHeight);
    if (this.autoScroll) this.scrollOffset = maxScroll;
    const visibleStart = Math.min(this.scrollOffset, maxScroll);
    const visible = contentLines.slice(visibleStart, visibleStart + viewportHeight);
    const currentBlockIdx = this.currentBlockGlobalIndex();
    const headerLine = this.activeHeaderLine();
    const showSticky = headerLine >= 0 && headerLine < visibleStart && visible.length > 0;
    const displayed = visible.slice();
    if (showSticky) {
      const block = this.cachedMessageBlocks[this.currentMessageIndex()];
      if (block) {
        const header = renderConversationRoleHeader(block, this.theme);
        displayed[0] = { text: ` ${header}`, plain: header, blockIndex: currentBlockIdx, railable: true };
      }
    }
    for (let i = 0; i < displayed.length; i++) {
      const line = displayed[i];
      let text = line.text;
      if (this.searchMatches.length > 0 && !(showSticky && i === 0)) {
        const hits = this.searchMatches.filter((match) => match.lineIdx === visibleStart + i).map((match) => ({ lineIdx: match.lineIdx, col: match.col, len: match.len, current: this.searchMatches.indexOf(match) === this.currentMatchIdx }));
        if (hits.length > 0) text = highlightConversationLine(text, hits, MATCH_BG, MATCH_BG_CURRENT, BG_RESET);
      }
      if (line.railable && line.blockIndex === currentBlockIdx) {
        const currentBlock = this.cachedMessageBlocks[this.currentMessageIndex()];
        const railColor = currentBlock?.kind === "tool" ? "toolTitle" : "accent";
        const railGlyph = currentBlock?.kind === "tool" ? "▌" : "▎";
        text = text.startsWith(" ") ? th.fg(railColor, railGlyph) + text.slice(1) : th.fg(railColor, railGlyph) + text;
      }
      lines.push(row(text));
    }
    for (let i = displayed.length; i < viewportHeight; i++) lines.push(row(""));

    lines.push(hrMid);
    if (this.composer) {
      lines.push(row(this.composer.render(innerW)[0] ?? ""));
      const hint = th.fg("dim", "Enter send · Esc cancel");
      const label = th.fg("accent", "✎ steer");
      lines.push(row(label + " ".repeat(Math.max(1, innerW - visibleWidth(label) - visibleWidth(hint))) + hint));
    } else if (this.searchMode) {
      const query = `/${this.searchQuery}`;
      const matchCount = this.searchMatches.length > 0
        ? ` · ${this.searchMatches.length} match${this.searchMatches.length === 1 ? "" : "es"}`
        : "";
      const hints = th.fg("dim", " · Enter apply · Esc cancel");
      lines.push(row(truncateToWidth(th.fg("accent", query) + th.fg("dim", matchCount) + hints, innerW, "...", true)));
    } else {
      const actions: string[] = [];
      if (this.canSteer()) actions.push(th.fg("dim", "e steer"));
      if (this.isStoppable()) actions.push(this.stopArmed ? th.fg("error", "x again to STOP") : th.fg("dim", "x stop"));
      const editHint = this.isLive() ? " O" : "";
      const shortcutHints = [
        `j/k scroll · J/K messages · [/] tools · w preview · g/G   t   M o${editHint}   /n N   q`,
        `[/] tools · w preview · M o${editHint}   /n N   q`,
        `[/] tools · w · M o${editHint} /n N q`,
      ];
      const scrollPct = contentLines.length <= viewportHeight ? "100%" : `${Math.round(((visibleStart + viewportHeight) / contentLines.length) * 100)}%`;
      const count = th.fg("dim", `${contentLines.length} lines · ${scrollPct}`);
      const countWidth = visibleWidth(count);
      let status = "";
      for (const hint of shortcutHints) {
        const styledHint = th.fg("dim", hint);
        const withActions = [styledHint, ...actions].join("   ");
        if (visibleWidth(withActions) <= innerW) {
          status = withActions;
          break;
        }
        if (visibleWidth(styledHint) <= innerW) status ||= styledHint;
      }
      if (!status) status = th.fg("dim", shortcutHints[shortcutHints.length - 1]);
      const statusWidth = visibleWidth(status);
      const footer = statusWidth + countWidth + 1 <= innerW
        ? status + " ".repeat(Math.max(1, innerW - statusWidth - countWidth)) + count
        : status;
      lines.push(row(truncateToWidth(footer, innerW, "...", true)));
    }
    lines.push(hrBot);
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = 0;
    this.cachedLines = [];
    this.cachedMessageStarts = [];
    this.cachedMessageBlocks = [];
    this.cachedVersion = -1;
  }

  private scheduleSessionRefresh(): void {
    if (this.closed || this.sessionRefreshQueued) return;
    this.sessionRefreshQueued = true;
    queueMicrotask(() => {
      this.sessionRefreshQueued = false;
      if (this.closed) return;
      if (this.hasFocusedBlock) this.selectedBlockId = this.currentBlock()?.id;
      this.blocks = formatConversationMessages(this.session.messages);
      this.timeline.setBlocks(this.blocks);
      this.cacheVersion++;
      this.invalidate();
      this.tui.requestRender();
    });
  }

  private handleTimelineChange(change: ConversationTimelineChange): void {
    if (change.kind === "content") {
      this.cacheVersion++;
      this.invalidate();
    } else if (change.changedRanges && this.cachedWidth > 0 && this.cachedVersion === this.cacheVersion) {
      const snapshotLines = this.timeline.getSnapshot().lines;
      for (const range of change.changedRanges) {
        const start = Math.max(0, range.startLine);
        const end = Math.min(this.cachedLines.length, start + Math.max(0, range.height));
        for (let index = start; index < end; index++) {
          const line = snapshotLines[index];
          if (line) this.cachedLines[index] = { ...line };
        }
      }
    }
    this.tui.requestRender();
  }

  dispose(): void {
    this.closed = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  private viewportHeight(): number {
    const maxRows = Math.floor((this.tui.terminal.rows * VIEWPORT_HEIGHT_PCT) / 100);
    return Math.max(MIN_VIEWPORT, maxRows - this.chromeLines());
  }

  private chromeLines(): number {
    return CHROME_LINES_BASE + (this.invocationLine() ? 1 : 0) + (this.composer ? 1 : 0);
  }

  private invocationLine(): string | undefined {
    const liveModel = this.isLive() ? this.record.session?.model : undefined;
    const invocation = this.record.invocation
      ? {
          ...this.record.invocation,
          ...(liveModel && { effectiveModelName: liveModel.name ?? liveModel.id }),
          ...(this.isLive() && { effectiveThinking: this.record.session?.thinkingLevel }),
        }
      : liveModel || (this.isLive() && this.record.session?.thinkingLevel)
        ? {
            effectiveModelName: liveModel?.name ?? liveModel?.id,
            effectiveThinking: this.record.session?.thinkingLevel,
          }
        : undefined;
    if (!invocation) return this.theme.fg("dim", "  ↳ model: unknown · thinking: unknown");
    const { modelName, tags } = buildInvocationTags(invocation);
    const effectiveModelName = invocation.effectiveModelName ?? modelName;
    const parts = effectiveModelName ? [`model: ${effectiveModelName}`, ...tags] : ["model: inherit", ...tags];
    return this.theme.fg("dim", `  ↳ ${parts.join(" · ")}`);
  }

  private buildContentLines(width: number): RenderLine[] {
    if (width <= 0) return [];
    if (this.cachedVersion === this.cacheVersion && this.cachedWidth === width) return this.cachedLines;
    this.timeline.setShowTools(this.showTools);
    this.timeline.render(width);
    const timelineSnapshot = this.timeline.getSnapshot();
    const lines: RenderLine[] = timelineSnapshot.lines.map((line) => ({ ...line }));
    this.cachedMessageStarts = [...timelineSnapshot.messageStarts];
    this.cachedMessageBlocks = [...timelineSnapshot.messageBlocks];
    if (this.hasFocusedBlock) {
      const selectedIndex = this.selectedBlockId
        ? this.cachedMessageBlocks.findIndex((block) => block.id === this.selectedBlockId)
        : -1;
      const focusedToolIndex = this.timeline.getFocusedToolCallId()
        ? this.cachedMessageBlocks.findIndex((block) => block.toolCallId === this.timeline.getFocusedToolCallId())
        : -1;
      const restoredIndex = selectedIndex >= 0 ? selectedIndex : focusedToolIndex;
      if (restoredIndex >= 0) {
        this.selectedMessageIdx = restoredIndex;
        this.selectedBlockId = this.cachedMessageBlocks[restoredIndex]?.id;
      }
    }
    if (this.record.status === "running" && this.activity) {
      const act = describeActivity(this.activity.activeTools, this.activity.responseText);
      const text = `▍ ${act}`;
      lines.push({ text: truncateToWidth(this.theme.fg("accent", "▍ ") + this.theme.fg("dim", act), width), plain: text, blockIndex: -1 });
    }
    this.cachedWidth = width;
    this.cachedVersion = this.cacheVersion;
    this.cachedLines = lines;
    if (this.searchMode || this.searchQuery) this.recomputeMatches();
    return lines;
  }

  private currentMessageIndex(): number {
    return this.cachedMessageStarts.length === 0 ? 0 : Math.max(0, Math.min(this.selectedMessageIdx, this.cachedMessageStarts.length - 1));
  }

  /** Keep the selected transcript block and the tool focus as one target. */
  private setFocusFromMessageIndex(index: number): boolean {
    if (index < 0 || index >= this.cachedMessageBlocks.length) return false;
    this.selectedMessageIdx = index;
    this.hasFocusedBlock = true;
    const block = this.cachedMessageBlocks[index];
    this.selectedBlockId = block.id;
    this.timeline.setFocusedToolCallId(block.kind === "tool" ? block.toolCallId : undefined);
    return true;
  }

  private currentBlockGlobalIndex(): number {
    const block = this.cachedMessageBlocks[this.currentMessageIndex()];
    return block ? this.blocks.indexOf(block) : -1;
  }

  private activeHeaderLine(): number {
    const block = this.cachedMessageBlocks[this.currentMessageIndex()];
    return block?.role === "user" || block?.role === "assistant"
      ? this.cachedMessageStarts[this.currentMessageIndex()] ?? -1
      : -1;
  }

  private currentBlock(): ConversationBlock | undefined {
    return this.cachedMessageBlocks[this.currentMessageIndex()];
  }

  private messageIndexForOffset(offset: number): number {
    let result = 0;
    for (let i = 0; i < this.cachedMessageStarts.length; i++) {
      if (this.cachedMessageStarts[i] <= offset) result = i;
      else break;
    }
    return result;
  }

  private jumpToMessage(dir: 1 | -1): void {
    const messageIndices = this.cachedMessageBlocks
      .map((block, index) => block.role === "user" || block.role === "assistant" ? index : -1)
      .filter((index): index is number => index >= 0);
    if (messageIndices.length === 0) return;
    const current = this.currentMessageIndex();
    const currentPosition = messageIndices.indexOf(current);
    const precedingPosition = messageIndices.reduce((last, index, position) => index < current ? position : last, -1);
    const nextPosition = messageIndices.findIndex((index) => index > current);
    const position = currentPosition >= 0
      ? currentPosition + dir
      : dir > 0 ? nextPosition : precedingPosition;
    if (position < 0 || position >= messageIndices.length) return;
    const target = messageIndices[position];
    this.setFocusFromMessageIndex(target);
    this.scrollOffset = Math.min(this.cachedMessageStarts[target], Math.max(0, this.cachedLines.length - this.viewportHeight()));
    this.autoScroll = false;
    this.tui.requestRender();
  }

  private moveToolFocus(direction: 1 | -1): void {
    if (!this.timeline.moveFocus(direction)) return;
    const focused = this.timeline.getFocusedToolCallId();
    this.buildContentLines(this.lastInnerW || 80);
    const index = this.cachedMessageBlocks.findIndex((block) => block.toolCallId === focused);
    if (index >= 0) {
      this.setFocusFromMessageIndex(index);
      this.autoScroll = false;
      this.scrollTargetIntoView(index);
    }
    this.tui.requestRender();
  }

  private focusNearbyTool(direction: 1 | -1): void {
    this.buildContentLines(this.lastInnerW || 80);
    const toolIndices = this.cachedMessageBlocks
      .map((block, index) => block.kind === "tool" && block.toolCallId ? index : -1)
      .filter((index): index is number => index >= 0);
    if (toolIndices.length === 0) return;

    const current = this.currentMessageIndex();
    const resolvedTarget = !this.hasFocusedBlock
      ? direction > 0 ? toolIndices[0] : toolIndices[toolIndices.length - 1]
      : direction > 0
        ? toolIndices.find((index) => index > current)
        : [...toolIndices].reverse().find((index) => index < current);
    if (resolvedTarget === undefined) return;

    this.setFocusFromMessageIndex(resolvedTarget);
    this.autoScroll = false;
    this.scrollTargetIntoView(resolvedTarget);
    this.tui.requestRender();
  }

  private scrollTargetIntoView(index: number): void {
    if (index < 0 || index >= this.cachedMessageStarts.length) return;
    const targetLine = this.cachedMessageStarts[index];
    const viewportHeight = this.viewportHeight();
    const maxScroll = Math.max(0, this.cachedLines.length - viewportHeight);
    if (targetLine < this.scrollOffset) this.scrollOffset = targetLine;
    else if (targetLine >= this.scrollOffset + viewportHeight) this.scrollOffset = targetLine - viewportHeight + 1;
    this.scrollOffset = Math.max(0, Math.min(maxScroll, this.scrollOffset));
  }

  private openFocusedToolPreview(): void {
    this.buildContentLines(this.lastInnerW || 80);
    const focusedToolCallId = this.timeline.getFocusedToolCallId();
    const block = focusedToolCallId
      ? this.cachedMessageBlocks.find((candidate) => candidate.toolCallId === focusedToolCallId)
      : this.currentBlock();
    const custom = this.operations?.ctx?.ui?.custom;
    if (block?.kind !== "tool" || typeof custom !== "function") return;

    const toolName = block.toolName || "tool";
    const args = block.args ?? block.toolArguments;
    const result = block.toolResult ?? block.result ?? { content: [] };
    const title = `${toolName} · full preview`;
    void custom.call(this.operations!.ctx.ui, (tui, overlayTheme, _keybindings, done) => {
      const body = createViewerCcstyleResult(
        toolName,
        result,
        { expanded: true, isError: result.isError === true },
        overlayTheme,
        { args, maxChars: FULL_TOOL_PREVIEW_MAX_CHARS, diffConfig: { expandedPreviewMaxLines: Number.MAX_SAFE_INTEGER } },
      );
      return new FullToolPreview(tui, overlayTheme as Theme, title, body, done);
    }, {
      overlay: true,
      overlayOptions: { anchor: "center", width: "85%", minWidth: 50, maxHeight: "80%", margin: 2 },
    }).catch(() => undefined);
  }

  private scrollBy(delta: number): void {
    const max = Math.max(0, this.cachedLines.length - this.viewportHeight());
    this.scrollOffset = Math.max(0, Math.min(max, this.scrollOffset + delta));
    const selected = this.messageIndexForOffset(this.scrollOffset);
    this.setFocusFromMessageIndex(selected);
    this.autoScroll = this.scrollOffset >= max;
    this.tui.requestRender();
  }

  private scrollToTop(): void {
    this.scrollOffset = 0;
    this.setFocusFromMessageIndex(0);
    this.autoScroll = false;
    this.tui.requestRender();
  }

  private scrollToBottom(): void {
    this.scrollOffset = Math.max(0, this.cachedLines.length - this.viewportHeight());
    this.setFocusFromMessageIndex(Math.max(0, this.cachedMessageStarts.length - 1));
    this.autoScroll = true;
    this.tui.requestRender();
  }

  private enterSearch(): void {
    this.searchMode = true;
    this.searchQuery = "";
    this.searchMatches = [];
    this.currentMatchIdx = -1;
    this.tui.requestRender();
  }

  private handleSearchInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, Key.ctrl("c"))) {
      this.searchMode = false;
      this.searchQuery = "";
      this.searchMatches = [];
      this.currentMatchIdx = -1;
    } else if (matchesKey(data, "enter") || data === "\r" || data === "\n") {
      this.searchMode = false;
      if (this.searchMatches.length > 0) this.scrollToMatch(this.currentMatchIdx < 0 ? 0 : this.currentMatchIdx);
    } else if (matchesKey(data, "backspace") || data === "\x7f" || data === "\b") {
      this.searchQuery = this.searchQuery.slice(0, -1);
      this.recomputeMatches();
    } else if (data.length === 1 && data >= " " && data !== "\x7f") {
      this.searchQuery += data;
      this.recomputeMatches();
    }
    this.tui.requestRender();
  }

  private recomputeMatches(): void {
    this.searchMatches = findConversationMatches(this.cachedLines, this.searchQuery);
    this.currentMatchIdx = this.searchMatches.length > 0 ? Math.min(Math.max(this.currentMatchIdx, 0), this.searchMatches.length - 1) : -1;
  }

  private gotoMatch(dir: 1 | -1): void {
    if (this.searchMatches.length === 0) return;
    this.currentMatchIdx = this.currentMatchIdx < 0
      ? (dir === 1 ? nearestConversationMatchAfter(this.searchMatches, this.scrollOffset) : nearestConversationMatchBefore(this.searchMatches, this.scrollOffset))
      : (this.currentMatchIdx + dir + this.searchMatches.length) % this.searchMatches.length;
    this.scrollToMatch(this.currentMatchIdx);
    this.tui.requestRender();
  }

  private scrollToMatch(index: number): void {
    const match = this.searchMatches[index];
    if (!match) return;
    const max = Math.max(0, this.cachedLines.length - this.viewportHeight());
    this.scrollOffset = Math.max(0, Math.min(max, match.lineIdx - Math.floor(this.viewportHeight() / 2)));
    this.setFocusFromMessageIndex(this.messageIndexForOffset(this.scrollOffset));
    this.autoScroll = false;
  }

  private async copyCurrentMessage(): Promise<void> {
    const block = this.currentBlock();
    if (!block || !this.operations) {
      if (!this.operations) return;
      return;
    }
    const source = `${stripAnsi(block.header)}\n${block.copyText}`.trimEnd();
    const clipped = source.length > MAX_COPY_CHARS ? `${source.slice(0, MAX_COPY_CHARS)}\n… [truncated by subagent copy]` : source;
    try {
      await copyToClipboard(clipped);
      this.operations.ctx.ui.notify(`Copied current message (${clipped.length} chars)`, "info");
    } catch (error) {
      this.operations.ctx.ui.notify(`Copy failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }

  private async viewCurrentInNvim(): Promise<void> {
    const block = this.currentBlock();
    if (!block || !this.operations) return;
    await viewConversationBlockInNvim(this.tui, this.operations.ctx, block);
    this.invalidate();
    this.tui.requestRender(true);
  }

  private async editCurrentInNvim(): Promise<void> {
    const block = this.currentBlock();
    if (!block || !this.operations || !this.isLive() || block.role !== "assistant") return;
    const sent = await editLiveAssistantBlockInNvim(this.operations.pi, this.tui, this.operations.ctx, block);
    if (sent) this.done(undefined);
    else {
      this.invalidate();
      this.tui.requestRender(true);
    }
  }

  private isReadOnly(): boolean {
    return this.operations?.readOnly === true;
  }

  private isLive(): boolean {
    return !this.isReadOnly() && this.record.session !== undefined;
  }

  private isStoppable(): boolean {
    return !this.isReadOnly() && !!this.onStop && (this.record.status === "running" || this.record.status === "queued");
  }

  private canSteer(): boolean {
    return !this.isReadOnly() && !!this.onSteer && (this.record.status === "running" || this.record.status === "queued");
  }

  private openComposer(): void {
    const input = new Input();
    input.focused = true;
    input.onSubmit = (value: string) => {
      const message = value.trim();
      this.composer = undefined;
      if (message) this.onSteer?.(message);
      this.tui.requestRender();
    };
    input.onEscape = () => {
      this.composer = undefined;
      this.tui.requestRender();
    };
    this.composer = input;
    this.tui.requestRender();
  }
}
