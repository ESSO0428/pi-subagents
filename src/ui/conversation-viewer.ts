/**
 * conversation-viewer.ts — Live and historical conversation overlay.
 *
 * The viewer deliberately keeps rendering state separate from the transcript:
 * blocks are formatted data, while Markdown/ANSI lines are a bounded cache.
 */

import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import { type Component, Input, Key, matchesKey, type TUI, type TuiMouseEvent, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { renderAgentName } from "../agent-color.js";
import type { AgentRecord, EffectiveThinkingLevel, ViewerMarkdownMode } from "../types.js";
import { getLifetimeCost, getLifetimeTotal, getSessionContextPercent } from "../usage.js";
import type { Theme } from "./agent-widget.js";
import { type AgentActivity, buildInvocationTags, describeActivity, fgPreservingNestedStyles, formatCost, formatDuration, formatSessionTokens, getPromptModeLabel } from "./agent-widget.js";
import { createViewerCcstyleResult } from "./ccstyle/tool-result.js";
import { type ConversationBlock, formatConversationMessages } from "./conversation-blocks.js";
import { editLiveAssistantBlockInNvim, viewConversationBlockInNvim } from "./conversation-nvim.js";
import { renderConversationRoleHeader } from "./conversation-role.js";
import { type ConversationMatch, findConversationMatches, highlightConversationLine, nearestConversationMatchAfter, nearestConversationMatchBefore, stripAnsi } from "./conversation-search.js";
import { ConversationTimeline, type ConversationTimelineChange, type TimelineRenderLine } from "./conversation-timeline.js";
import { createViewerKeys, type ViewerKeybindings, type ViewerKeys } from "./viewer-keys.js";

/** Base lines consumed by the overlay: borders, header, separator and footer. */
const CHROME_LINES_BASE = 6;
const MIN_VIEWPORT = 3;
export const VIEWPORT_HEIGHT_PCT = 70;
const MAX_COPY_CHARS = 500_000;
export const RESULT_MAX_CHARS = 16_000;
const MATCH_BG = "\x1b[48;5;238m";
const MATCH_BG_CURRENT = "\x1b[48;5;220m\x1b[30m";
const BG_RESET = "\x1b[49m\x1b[39m";
const MARKDOWN_MODES: readonly ViewerMarkdownMode[] = ["off", "assistant", "all"];
const MARKDOWN_MODE_LABELS: Record<ViewerMarkdownMode, string> = {
  off: "raw",
  assistant: "md",
  all: "md+",
};

function renderScrollbarCell(
  theme: Theme,
  totalLines: number,
  viewportHeight: number,
  scrollOffset: number,
  lineIndex: number,
  active: boolean,
): string {
  const total = Math.max(0, Math.floor(totalLines));
  const viewport = Math.max(1, Math.floor(viewportHeight));
  if (total <= viewport) return theme.fg("scrollbarTrack", " ");
  const maxOffset = Math.max(0, total - viewport);
  const offset = Math.max(0, Math.min(maxOffset, Math.floor(scrollOffset)));
  const thumbHeight = Math.max(1, Math.round((viewport * viewport) / total));
  const thumbStart = Math.round(((viewport - thumbHeight) * offset) / maxOffset);
  const inThumb = lineIndex >= thumbStart && lineIndex < thumbStart + thumbHeight;
  return theme.fg(
    inThumb ? "scrollbarThumb" : "scrollbarTrack",
    inThumb ? (active ? "█" : "┃") : "│",
  );
}

function renderScrollMoreRule(
  theme: Theme,
  width: number,
  direction: "top" | "bottom",
  hiddenLines: number,
): string {
  const safeWidth = Math.max(1, Math.floor(width));
  if (hiddenLines <= 0) return theme.fg("border", `├${"─".repeat(safeWidth)}┤`);
  const label = `${direction === "top" ? "↑" : "↓"} ${hiddenLines} more`;
  const labelWidth = visibleWidth(label);
  if (labelWidth + 2 > safeWidth) return theme.fg("border", `├${"─".repeat(safeWidth)}┤`);
  const left = Math.floor((safeWidth - labelWidth) / 2);
  const right = Math.max(0, safeWidth - left - labelWidth);
  return `${theme.fg("border", `├${"─".repeat(left)}`)}${theme.fg("dim", label)}${theme.fg("border", `${"─".repeat(right)}┤`)}`;
}

/** The live fields needed by the viewer; historical viewers use a static source. */
export type ConversationSource = Pick<AgentSession, "messages" | "subscribe">;

export function createStaticConversationSource(
  messages: AgentSession["messages"],
): ConversationSource {
  return { messages, subscribe: () => () => {} };
}

type RenderLine = TimelineRenderLine;

function makeRenderLine(fields: TimelineRenderLine): RenderLine {
  return fields;
}

class PublicRenderLines extends Array<string> {
  static get [Symbol.species](): ArrayConstructor { return Array; }

  constructor(values: readonly string[]) {
    super(...values.map(value => Object.assign(new String(value), { text: value }) as unknown as string));
  }

  override includes(searchElement: string, fromIndex?: number): boolean {
    return this.some((value, index) => {
      if (index < (fromIndex ?? 0)) return false;
      const text = String(value);
      return text === searchElement || stripAnsi(text) === searchElement;
    });
  }

  find(predicate: (value: string, index: number, array: string[]) => unknown, thisArg?: unknown): string | undefined {
    for (let index = 0; index < this.length; index++) {
      const value = this[index]!;
      if (predicate.call(thisArg, value, index, this)) return String(value);
    }
    return undefined;
  }
}

function publicRenderLines(lines: readonly RenderLine[]): PublicRenderLines {
  return new PublicRenderLines(lines.map(line => {
    const plain = stripAnsi(line.text);
    const truncationStart = plain.indexOf("... (truncated,");
    return truncationStart >= 0 ? plain.slice(truncationStart).trimEnd() : line.text;
  }));
}

const FULL_TOOL_PREVIEW_MAX_CHARS = 500_000;

class FullToolPreview implements Component {
  private scrollOffset = 0;
  private pageSize = 1;
  private totalLines = 1;
  private pendingTop = false;
  private hoveredClose = false;
  private scrollbarActive = false;

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
    // Reserve the rightmost inner cell for the same track/thumb rail used by
    // pi-tui's native ScrollView layout.
    const bodyWidth = Math.max(1, inner - 1);
    const terminalRows = Math.max(1, this.tui.terminal.rows);
    const viewport = Math.max(1, Math.min(30, Math.floor(terminalRows * 0.8), terminalRows - 6));
    const wrapped = this.body.render(Math.max(1, bodyWidth - 1));
    this.totalLines = wrapped.length;
    this.pageSize = viewport;
    this.scrollOffset = Math.min(this.scrollOffset, Math.max(0, this.totalLines - this.pageSize));
    const visible = wrapped.slice(this.scrollOffset, this.scrollOffset + this.pageSize);
    const border = (text: string) => this.theme.fg("border", text);
    const pad = (text: string, rowWidth = inner): string => {
      const clipped = truncateToWidth(text, rowWidth, "…", true);
      return clipped + " ".repeat(Math.max(0, rowWidth - visibleWidth(clipped)));
    };
    const hiddenAbove = this.scrollOffset;
    const hiddenBelow = Math.max(0, this.totalLines - this.scrollOffset - this.pageSize);
    const close = this.theme.fg(this.hoveredClose ? "text" : "dim", "[esc]");
    const header = this.theme.bold(this.theme.fg("accent", this.title));
    const status = `${this.scrollOffset + 1}-${Math.min(this.totalLines, this.scrollOffset + this.pageSize)} / ${this.totalLines} lines · j/k gg/G ↑↓ PgUp/PgDn · [esc] close`;
    return [
      border(`╭${"─".repeat(inner)}╮`),
      `${border("│")}${pad(` ${header}`, inner - visibleWidth(close))}${close}${border("│")}`,
      renderScrollMoreRule(this.theme, inner, "top", hiddenAbove),
      ...Array.from({ length: viewport }, (_, index) => {
        const content = pad(` ${visible[index] ?? ""}`, bodyWidth);
        const rail = renderScrollbarCell(
          this.theme,
          this.totalLines,
          this.pageSize,
          this.scrollOffset,
          index,
          this.scrollbarActive,
        );
        return `${border("│")}${content}${rail}${border("│")}`;
      }),
      renderScrollMoreRule(this.theme, inner, "bottom", hiddenBelow),
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
    this.scrollbarActive = true;
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
  private lastSessionKey = "";
  private selectedBlockId: string | undefined;
  private scrollOffset = 0;
  private autoScroll = true;
  private unsubscribe: (() => void) | undefined;
  private lastInnerW = 0;
  private closed = false;
  private stopArmed = false;
  private hoveredClose = false;
  private hoveredPreview = false;
  private pressedHeaderAction: "preview" | "close" | undefined;
  private keys: ViewerKeys;
  private composer: Input | undefined;
  private searchMode = false;
  private searchQuery = "";
  private searchMatches: ConversationMatch[] = [];
  private currentMatchIdx = -1;
  /** Follow-up drafts, newest first, matching pi editor history semantics. */
  private steerHistory: string[] = [];
  private steerHistoryIndex = -1;
  private steerHistoryDraft = "";
  private timeline: ConversationTimeline;
  private toolPreview: FullToolPreview | undefined;
  private readonly operations: ConversationViewerOperations | undefined;
  private readonly showCost: boolean;
  private readonly viewerMarkdown: (() => ViewerMarkdownMode) | undefined;
  private readonly onMarkdownMode: ((mode: ViewerMarkdownMode) => void) | undefined;
  private markdownModeOverride: ViewerMarkdownMode | undefined;

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
    /** Cost flag in upstream's constructor; fork callers may pass operations here. */
    showCostOrOperations?: boolean | ConversationViewerOperations,
    viewerMarkdown?: () => ViewerMarkdownMode,
    onMarkdownMode?: (mode: ViewerMarkdownMode) => void,
  ) {
    this.operations = typeof showCostOrOperations === "object" ? showCostOrOperations : undefined;
    this.showCost = typeof showCostOrOperations === "boolean" ? showCostOrOperations : false;
    this.viewerMarkdown = viewerMarkdown;
    this.onMarkdownMode = onMarkdownMode;
    this.keys = createViewerKeys(keybindings);
    this.blocks = formatConversationMessages(session.messages);
    this.lastSessionKey = this.sessionKey();
    this.timeline = new ConversationTimeline(tui, theme, {
      cwd: this.operations?.ctx.cwd,
      record,
      markdownMode: () => this.currentMarkdownMode(),
      onChange: (change) => this.handleTimelineChange(change),
    });
    this.timeline.setBlocks(this.blocks);
    this.unsubscribe = session.subscribe(() => this.scheduleSessionRefresh());
  }

  handleInput(data: string): void {
    if (this.toolPreview) {
      this.toolPreview.handleInput(data);
      return;
    }
    if (this.composer) {
      if (matchesKey(data, Key.alt("up")) || data === "a-up" || data === "alt+up") {
        this.recallSteerDraft();
      } else {
        const before = this.composer.getValue();
        this.composer.handleInput(data);
        if (this.composer && before !== this.composer.getValue()) {
          this.steerHistoryIndex = -1;
          this.steerHistoryDraft = "";
        }
      }
      this.tui.requestRender();
      return;
    }
    if (this.searchMode) {
      this.handleSearchInput(data);
      return;
    }
    if (matchesKey(data, Key.ctrl("c"))) {
      this.closed = true;
      this.done(undefined);
      return;
    }
    if (matchesKey(data, "escape") || matchesKey(data, "q")) {
      this.closed = true;
      this.done(undefined);
      return;
    }
    if (matchesKey(data, "enter")) {
      this.buildContentLines(this.transcriptWidth(this.lastInnerW || 80));
      if (this.timeline.isToolFocused()) {
        this.timeline.toggleFocusedTool();
        return;
      }
      if (this.canSteer()) {
        this.stopArmed = false;
        this.openComposer();
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
    this.buildContentLines(this.transcriptWidth(this.lastInnerW || 80));
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
    } else if (data === "m") {
      this.cycleMarkdownMode();
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
    if (this.toolPreview) return this.toolPreview.handleMouse(event);
    const innerW = Math.max(1, this.lastInnerW || event.width - 4);
    const contentWidth = this.transcriptWidth(innerW);
    const railX = 2 + contentWidth;
    const previewHit = this.isPreviewButtonHit(event.x, event.y, innerW);
    const closeHit = this.isCloseButtonHit(event.x, event.y, innerW);
    if (event.type === "move") {
      const previewChanged = previewHit !== this.hoveredPreview;
      const closeChanged = closeHit !== this.hoveredClose;
      this.hoveredPreview = previewHit;
      this.hoveredClose = closeHit;
      if (this.composer || this.searchMode) {
        return previewChanged || closeChanged ? { handled: true, render: true } : undefined;
      }
      if (event.x === railX) return previewChanged || closeChanged ? { handled: true, render: true } : undefined;
      this.buildContentLines(contentWidth);
      const contentLines = this.cachedLines;
      const viewportHeight = this.viewportHeight();
      const maxScroll = Math.max(0, contentLines.length - viewportHeight);
      if (this.autoScroll) this.scrollOffset = maxScroll;
      const visibleStart = Math.min(this.scrollOffset, maxScroll);
      const contentOrigin = 4;
      const contentY = event.y - contentOrigin + visibleStart;
      const timelineResult = this.timeline.handleMouse({ ...event, y: contentY });
      return timelineResult ?? (previewChanged || closeChanged ? { handled: true, render: true } : undefined);
    }
    if (event.button === "left") {
      if (event.type === "press" && previewHit) {
        this.pressedHeaderAction = "preview";
        return { handled: true, capture: true, render: false };
      }
      if (event.type === "press" && closeHit) {
        this.pressedHeaderAction = "close";
        return { handled: true, capture: true, render: false };
      }
      if (event.type === "release" && this.pressedHeaderAction) {
        this.pressedHeaderAction = undefined;
        return { handled: true, render: false };
      }
      if (event.type === "click" && previewHit) {
        this.pressedHeaderAction = undefined;
        this.openFocusedToolPreview();
        return { handled: true, render: false };
      }
      if (event.type === "click" && closeHit) {
        this.pressedHeaderAction = undefined;
        this.closed = true;
        this.done(undefined);
        return { handled: true, render: false };
      }
    }
    if (this.composer || this.searchMode) return undefined;
    const contentLines = this.buildContentLines(contentWidth);
    const viewportHeight = this.viewportHeight();
    const maxScroll = Math.max(0, contentLines.length - viewportHeight);
    const visibleStart = Math.min(this.scrollOffset, maxScroll);
    const contentOrigin = 4;
    if (event.type === "wheel") {
      if (event.y < contentOrigin || event.y >= contentOrigin + viewportHeight) return undefined;
      this.scrollBy(Math.trunc(event.wheelDelta ?? 0));
      return { handled: true, render: true };
    }
    const contentY = event.y - contentOrigin + visibleStart;
    if (contentY < 0 || contentY >= contentLines.length) return undefined;
    // The reserved rail is visual-only; wheel events above remain handled by the viewport.
    if ((event.type === "click" || event.type === "press") && event.x === railX) return undefined;
    // Rows have one leading space and one trailing space inside the frame.
    // Neither padding, the rail, nor the frame itself is a focus target.
    if ((event.type === "click" || event.type === "press") && (event.x < 2 || event.x >= 2 + contentWidth)) return undefined;
    const result = this.timeline.handleMouse({ ...event, y: contentY });
    if (result?.handled && event.type === "click") {
      let selected = result.focusedBlockIndex;
      if (selected === undefined) {
        const focusedTool = this.timeline.getFocusedToolCallId();
        selected = this.timeline.getSnapshot().messageBlocks.findIndex((block) => block.toolCallId === focusedTool);
      }
      if (selected !== undefined && selected >= 0) {
        this.buildContentLines(contentWidth);
        this.setFocusFromMessageIndex(selected);
        this.autoScroll = false;
        this.scrollTargetIntoView(selected);
        this.tui.requestRender();
      }
    }
    return result;
  }

  private isPreviewButtonHit(x: number, y: number, innerW: number): boolean {
    if (y !== 1) return false;
    const previewWidth = visibleWidth("[preview]");
    const closeWidth = visibleWidth("[Esc]");
    const labelStart = 2 + Math.max(0, innerW - previewWidth - 1 - closeWidth);
    return x >= labelStart && x < labelStart + previewWidth;
  }

  private isCloseButtonHit(x: number, y: number, innerW: number): boolean {
    if (y !== 1) return false;
    const labelWidth = visibleWidth("[Esc]");
    const labelStart = 2 + Math.max(0, innerW - labelWidth);
    return x >= labelStart && x < 2 + innerW;
  }

  render(width: number): string[] {
    if (this.toolPreview) return this.toolPreview.render(width);
    if (width < 6) return [];
    const th = this.theme;
    const innerW = Math.max(1, width - 4);
    this.lastInnerW = innerW;
    const contentWidth = this.transcriptWidth(innerW);
    const lines: string[] = [];
    const pad = (s: string, len: number) => s + " ".repeat(Math.max(0, len - visibleWidth(s)));
    const row = (content: string) => th.fg("border", "│") + " " + truncateToWidth(pad(content, innerW), innerW, "...", true) + " " + th.fg("border", "│");
    const contentRow = (content: string, lineIndex: number, totalLines: number, viewportHeight: number, offset: number) => {
      const isTruncationNote = stripAnsi(content).includes("... (truncated,");
      const text = isTruncationNote
        ? truncateToWidth(content, contentWidth, "...", true)
        : truncateToWidth(pad(content, contentWidth), contentWidth, "...", true);
      const rail = renderScrollbarCell(th, totalLines, viewportHeight, offset, lineIndex, false);
      if (isTruncationNote) return th.fg("border", "│") + " " + text + th.fg("border", "│");
      return th.fg("border", "│") + " " + text + rail + " " + th.fg("border", "│");
    };
    const hrTop = th.fg("border", `╭${"─".repeat(Math.max(0, width - 2))}╮`);
    const hrBot = th.fg("border", `╰${"─".repeat(Math.max(0, width - 2))}╯`);
    const hrMid = row(th.fg("dim", "─".repeat(innerW)));

    lines.push(hrTop);
    const modeLabel = getPromptModeLabel(this.record.type);
    const modeTag = modeLabel ? ` ${th.fg("dim", `(${modeLabel})`)}` : "";
    const statusIcon = this.record.status === "running" ? th.fg("accent", "●") : this.record.status === "completed" ? th.fg("success", "✓") : this.record.status === "error" ? th.fg("error", "✗") : th.fg("dim", "○");
    const duration = formatDuration(this.record.startedAt, this.record.completedAt);
    const headerParts: string[] = [duration];
    const toolUses = this.activity?.toolUses ?? this.record.toolUses;
    if (toolUses > 0) headerParts.unshift(`${toolUses} tool${toolUses === 1 ? "" : "s"}`);
    const usage = this.activity?.lifetimeUsage ?? this.record.lifetimeUsage;
    const tokens = getLifetimeTotal(usage);
    if (tokens > 0) {
      const percent = getSessionContextPercent(this.activity?.session ?? this.record.session);
      const tokenText = formatSessionTokens(tokens, percent, th, this.record.compactionCount);
      const costText = this.showCost ? formatCost(getLifetimeCost(usage)) : "";
      headerParts.push(costText ? `${tokenText} ${costText}` : tokenText);
    }
    const styledName = renderAgentName(this.record.type, th, { bold: true, fallbackColor: "accent" });
    const headerText = `${statusIcon} ${styledName}${modeTag}  ${th.fg("muted", this.record.description)} ${th.fg("dim", "·")} ${fgPreservingNestedStyles(th, "dim", headerParts.join(" · "))}`;
    const previewLabel = this.hoveredPreview ? th.fg("text", th.bold("[preview]")) : th.fg("dim", "[preview]");
    const closeLabel = this.hoveredClose ? th.fg("text", th.bold("[Esc]")) : th.fg("dim", "[Esc]");
    const actionsWidth = visibleWidth(previewLabel) + 1 + visibleWidth(closeLabel);
    const headerLeft = truncateToWidth(headerText, Math.max(0, innerW - actionsWidth - 1), "", true);
    const headerGap = Math.max(1, innerW - visibleWidth(headerLeft) - actionsWidth);
    lines.push(row(headerLeft + " ".repeat(headerGap) + previewLabel + " " + closeLabel));
    const invocationLine = this.invocationLine();
    lines.push(row(invocationLine ?? ""));
    lines.push(hrMid);

    this.buildContentLines(contentWidth);
    const contentLines = this.cachedLines;
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
        displayed[0] = makeRenderLine({ text: ` ${header}`, plain: header, blockIndex: currentBlockIdx, railable: true });
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
      const plainText = stripAnsi(text);
      lines.push(plainText.includes("... (truncated,")
        ? th.fg("border", "│") + " " + text + th.fg("border", "│")
        : contentRow(text, i, contentLines.length, viewportHeight, visibleStart));
    }
    for (let i = displayed.length; i < viewportHeight; i++) {
      lines.push(contentRow("", i, contentLines.length, viewportHeight, visibleStart));
    }

    lines.push(hrMid);
    if (this.composer) {
      lines.push(row(this.composer.render(innerW)[0] ?? ""));
      const hint = th.fg("dim", "Enter send · Esc cancel · Alt+Up recall");
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
      if (this.canSteer()) actions.push(th.fg("dim", innerW < 100 ? "Enter steer (e steer)" : "e steer"));
      if (this.isStoppable()) actions.push(this.stopArmed ? th.fg("error", "x again to STOP") : th.fg("dim", "x stop"));
      const editHint = this.isLive() ? " O" : "";
      const markdownHint = innerW < 100 ? `m ${MARKDOWN_MODE_LABELS[this.currentMarkdownMode()]}` : "";
      const shortcutHints = innerW < 100
        ? [
            `j/k scroll · J/K messages · [/] tools · w preview · g/G   t   ${markdownHint}   M o${editHint}   /n N   q`,
            `[/] tools · w preview · ${markdownHint} · M o${editHint}   /n N   q`,
            `${markdownHint} · M o${editHint} /n N · Esc close`,
          ]
        : [
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
      this.lastSessionKey = this.sessionKey();
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
          if (line) this.cachedLines[index] = makeRenderLine({ ...line });
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

  /** Full inner width includes the one column reserved for the transcript rail. */
  private transcriptWidth(innerW: number): number {
    return Math.max(1, innerW - 1);
  }

  private chromeLines(): number {
    return CHROME_LINES_BASE + 1 + (this.composer ? 1 : 0);
  }

  private invocationLine(): string | undefined {
    const liveModel = this.isLive() ? this.record.session?.model : undefined;
    const captured = this.record.invocation as (AgentRecord["invocation"] & {
      effectiveModelName?: string;
      effectiveModelId?: string;
      effectiveThinking?: EffectiveThinkingLevel;
    }) | undefined;
    const invocation = captured
      ? {
          ...captured,
          ...(captured.modelName === undefined && captured.effectiveModelName !== undefined && { modelName: captured.effectiveModelName }),
          ...(captured.modelId === undefined && captured.effectiveModelId !== undefined && { modelId: captured.effectiveModelId }),
          ...(captured.thinking === undefined && captured.effectiveThinking !== undefined && { thinking: captured.effectiveThinking }),
          ...(liveModel && { modelName: liveModel.name ?? liveModel.id, modelId: `${liveModel.provider}/${liveModel.id}` }),
          ...(this.isLive() && { thinking: this.record.session?.thinkingLevel }),
        }
      : liveModel
        ? { modelName: liveModel.name ?? liveModel.id, modelId: `${liveModel.provider}/${liveModel.id}`, thinking: this.record.session?.thinkingLevel }
        : undefined;
    if (!invocation) return undefined;
    const { modelName, modelId, tags } = buildInvocationTags(invocation);
    const effectiveModelName = modelId ?? modelName;
    if (!effectiveModelName && tags.length === 0) return undefined;
    const displayModel = captured?.effectiveModelName !== undefined
      ? `model: ${captured.effectiveModelName}`
      : effectiveModelName;
    return this.theme.fg("dim", `  ↳ ${[displayModel, ...tags].filter(Boolean).join(" · ")}`);
  }

  private currentMarkdownMode(): ViewerMarkdownMode {
    return this.markdownModeOverride ?? this.viewerMarkdown?.() ?? "assistant";
  }

  private cycleMarkdownMode(): void {
    const current = this.currentMarkdownMode();
    const next = MARKDOWN_MODES[(MARKDOWN_MODES.indexOf(current) + 1) % MARKDOWN_MODES.length]!;
    this.markdownModeOverride = next;
    this.onMarkdownMode?.(next);
    this.timeline.setMarkdownMode(() => this.currentMarkdownMode());
    this.invalidate();
    this.tui.requestRender();
  }

  private sessionKey(): string {
    return this.session.messages.map(message => {
      const value = message as unknown as { role?: unknown; content?: unknown; output?: unknown; command?: unknown };
      const content = value.content;
      const summarize = (text: string): string => `${text.length}:${text.slice(0, 24)}:${text.slice(-24)}`;
      const contentSummary = typeof content === "string"
        ? summarize(content)
        : Array.isArray(content)
          ? content.map(part => typeof part === "object" && part && "text" in part && typeof part.text === "string" ? summarize(part.text) : "").join("|")
          : "";
      return `${String(value.role)}:${contentSummary}:${typeof value.output === "string" ? summarize(value.output) : ""}:${typeof value.command === "string" ? summarize(value.command) : ""}`;
    }).join("\u0001");
  }

  private blockSignature(block: ConversationBlock): string {
    let resultLength = 0;
    const content = block.toolResult?.content;
    if (typeof content === "string") resultLength = content.length;
    else if (Array.isArray(content)) resultLength = content.reduce((total, part) => total + (typeof part === "object" && part && "text" in part && typeof part.text === "string" ? part.text.length : 0), 0);
    return `${block.id}\u0000${block.markdown}\u0000${block.fullText}\u0000${block.toolLine ?? ""}\u0000${resultLength}`;
  }

  private syncBlocksFromSession(): void {
    const sessionKey = this.sessionKey();
    if (sessionKey === this.lastSessionKey) return;
    this.lastSessionKey = sessionKey;
    const refreshed = formatConversationMessages(this.session.messages);
    const sameShape = refreshed.length === this.blocks.length && refreshed.every((block, index) => block.id === this.blocks[index]?.id);
    if (!sameShape) {
      this.blocks = refreshed;
      this.timeline.setBlocks(this.blocks);
      this.cacheVersion++;
      this.cachedVersion = -1;
      return;
    }
    let changed = false;
    for (let index = 0; index < refreshed.length; index++) {
      const current = this.blocks[index]!;
      const next = refreshed[index]!;
      if (this.blockSignature(current) !== this.blockSignature(next)) changed = true;
      Object.assign(current, next);
    }
    if (changed) {
      this.cacheVersion++;
      this.cachedVersion = -1;
    }
  }

  private buildContentLines(width: number): PublicRenderLines {
    if (width <= 0) return new PublicRenderLines([]);
    this.syncBlocksFromSession();
    if (this.cachedVersion === this.cacheVersion && this.cachedWidth === width) {
      this.timeline.render(width);
      return publicRenderLines(this.cachedLines);
    }
    this.timeline.setShowTools(this.showTools);
    this.timeline.render(width);
    const timelineSnapshot = this.timeline.getSnapshot();
    const lines: RenderLine[] = timelineSnapshot.lines.map((line) => {
      const rawText = typeof line?.text === "string" ? line.text : "";
      const text = truncateToWidth(rawText, width, "", true);
      return makeRenderLine({
        text,
        plain: stripAnsi(text),
        blockIndex: typeof line?.blockIndex === "number" ? line.blockIndex : -1,
        ...(line?.railable ? { railable: true } : {}),
      });
    });
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
      lines.push(makeRenderLine({ text: truncateToWidth(this.theme.fg("accent", "▍ ") + this.theme.fg("dim", act), width), plain: text, blockIndex: -1 }));
    }
    this.cachedWidth = width;
    this.cachedVersion = this.cacheVersion;
    this.cachedLines = lines;
    if (this.searchMode || this.searchQuery) this.recomputeMatches();
    return publicRenderLines(lines);
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
    this.buildContentLines(this.transcriptWidth(this.lastInnerW || 80));
    const index = this.cachedMessageBlocks.findIndex((block) => block.toolCallId === focused);
    if (index >= 0) {
      this.setFocusFromMessageIndex(index);
      this.autoScroll = false;
      this.scrollTargetIntoView(index);
    }
    this.tui.requestRender();
  }

  private focusNearbyTool(direction: 1 | -1): void {
    this.buildContentLines(this.transcriptWidth(this.lastInnerW || 80));
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
    this.buildContentLines(this.transcriptWidth(this.lastInnerW || 80));
    const focusedToolCallId = this.timeline.getFocusedToolCallId();
    const block = focusedToolCallId
      ? this.cachedMessageBlocks.find((candidate) => candidate.toolCallId === focusedToolCallId)
      : this.currentBlock();
    if (block?.kind !== "tool") return;

    const toolName = block.toolName || "tool";
    const args = block.args ?? block.toolArguments;
    const result = block.toolResult ?? block.result ?? { content: [] };
    const title = `${toolName} · full preview`;
    const body = createViewerCcstyleResult(
      toolName,
      result,
      { expanded: true, isError: result.isError === true },
      this.theme,
      { args, maxChars: FULL_TOOL_PREVIEW_MAX_CHARS, diffConfig: { expandedPreviewMaxLines: Number.MAX_SAFE_INTEGER } },
    );
    this.toolPreview = new FullToolPreview(this.tui, this.theme, title, body, () => {
      this.toolPreview = undefined;
      this.tui.requestRender();
    });
    this.tui.requestRender();
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
    this.steerHistoryIndex = -1;
    this.steerHistoryDraft = "";
    input.onSubmit = (value: string) => {
      const message = value.trim();
      this.composer = undefined;
      this.steerHistoryIndex = -1;
      this.steerHistoryDraft = "";
      if (message) {
        if (this.steerHistory[0] !== message) this.steerHistory.unshift(message);
        if (this.steerHistory.length > 100) this.steerHistory.pop();
        this.onSteer?.(message);
      }
      this.tui.requestRender();
    };
    input.onEscape = () => {
      this.composer = undefined;
      this.steerHistoryIndex = -1;
      this.steerHistoryDraft = "";
      this.tui.requestRender();
    };
    this.composer = input;
    this.tui.requestRender();
  }

  /** Recall the newest prior steer, preserving the draft for future editing. */
  private recallSteerDraft(): void {
    if (!this.composer || this.steerHistory.length === 0) return;
    if (this.steerHistoryIndex < 0) {
      this.steerHistoryDraft = this.composer.getValue();
      this.steerHistoryIndex = 0;
    } else if (this.steerHistoryIndex < this.steerHistory.length - 1) {
      this.steerHistoryIndex++;
    }
    this.composer.setValue(this.steerHistory[this.steerHistoryIndex] ?? this.steerHistoryDraft);
  }
}
