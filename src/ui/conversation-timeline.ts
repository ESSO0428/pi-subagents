import * as CodingAgent from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Markdown,
  Text,
  type TUI,
  type TuiMouseEvent,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import type { AgentRecord } from "../types.js";
import type { Theme } from "./agent-widget.js";
import { showMoreHintText } from "./ccstyle/diff/render-utils.js";
import {
  createViewerCcstyleTool,
  type ViewerToolRenderers,
} from "./ccstyle/tool-renderer.js";
import {
  type ConversationBlock,
  type ConversationToolResultSnapshot,
} from "./conversation-blocks.js";
import { renderConversationRoleHeader } from "./conversation-role.js";
import { stripAnsi } from "./conversation-search.js";

export interface TimelineRenderLine {
  text: string;
  plain: string;
  blockIndex: number;
  railable?: boolean;
}

export interface TimelineBlockSpan {
  /** Index into the snapshot's messageBlocks array, not the source block array. */
  blockIndex: number;
  startLine: number;
  height: number;
}

export interface TimelineToolSpan extends TimelineBlockSpan {
  toolCallId: string;
  /** The only row that opens a collapsed card with a single click. */
  clickStartLine?: number;
  clickHeight?: number;
}

export interface ConversationTimelineSnapshot {
  lines: TimelineRenderLine[];
  messageStarts: number[];
  messageBlocks: ConversationBlock[];
  interactiveToolIds: string[];
  blockSpans: TimelineBlockSpan[];
  toolSpans: TimelineToolSpan[];
}

export interface ConversationTimelineMouseResult {
  handled?: boolean;
  capture?: boolean;
  render?: boolean;
  focusedBlockIndex?: number;
}

export interface ConversationTimelineLineRange {
  startLine: number;
  height: number;
}

export interface ConversationTimelineChange {
  kind: "content" | "interaction";
  /** Lines patched in-place for an interaction-only change such as hover. */
  changedRanges?: readonly ConversationTimelineLineRange[];
}

export interface ConversationTimelineOptions {
  cwd?: string;
  record?: AgentRecord;
  onChange?: (change: ConversationTimelineChange) => void;
}

function safeWidth(width: number): number {
  return Math.max(1, Math.floor(Number.isFinite(width) ? width : 1));
}

function resultContent(result: ConversationToolResultSnapshot): Array<Record<string, unknown>> {
  if (Array.isArray(result.content)) return result.content as Array<Record<string, unknown>>;
  if (typeof result.content === "string") return [{ type: "text", text: result.content }];
  return [];
}

function fallbackToolLines(block: ConversationBlock, width: number, expanded = false, hovered = false, theme?: Theme): string[] {
  const summary = block.toolLine || block.fullText || block.toolName || "tool";
  const output = block.toolResult
    ? block.toolResult.content
    : undefined;
  const outputText = typeof output === "string"
    ? output
    : Array.isArray(output)
      ? output.filter((item: any) => item?.type === "text").map((item: any) => String(item.text ?? "")).join("\n")
      : "";
  const outputLines = outputText.split(/\r?\n/);
  const displayOutput = expanded || outputLines.length <= 4
    ? outputLines
    : [...outputLines.slice(0, 4), `… (${outputLines.length - 4} more lines · ${showMoreHintText()})`];
  const body = outputText ? [summary, ...displayOutput].join("\n") : summary;
  return body.split(/\r?\n/).map((line) => {
    const clipped = truncateToWidth(line, width, "");
    if (!hovered || expanded || !theme) return clipped;
    const plain = stripAnsi(clipped);
    const marker = plain.includes(showMoreHintText()) ? showMoreHintText() : "";
    if (!marker) return clipped;
    const markerIndex = plain.indexOf(marker);
    return theme.fg("dim", plain.slice(0, markerIndex)) + theme.fg("text", marker) + theme.fg("dim", plain.slice(markerIndex + marker.length));
  });
}

function applyToolComponentState(component: any, block: ConversationBlock, expanded: boolean): void {
  component.updateArgs?.(block.args ?? block.toolArguments ?? {});
  component.setArgsComplete?.();
  if (block.result ?? block.toolResult) {
    const result = (block.result ?? block.toolResult)!;
    component.updateResult?.({
      content: resultContent(result),
      details: result.details,
      isError: result.isError === true,
    }, false);
  }
  component.setExpanded?.(expanded);
}

function createToolComponent(
  block: ConversationBlock,
  tui: TUI,
  cwd: string,
  expanded: boolean,
  isHovered: () => boolean,
): Component | undefined {
  const Constructor = (CodingAgent as any).ToolExecutionComponent as (new (...args: any[]) => Component) | undefined;
  if (typeof Constructor !== "function" || !block.toolName || !block.toolCallId) return undefined;

  try {
    const renderer = createViewerCcstyleTool(block.toolName, isHovered) as ViewerToolRenderers;
    const component = new Constructor(
      block.toolName,
      block.toolCallId,
      block.args ?? block.toolArguments ?? {},
      { showImages: false },
      renderer,
      tui,
      cwd,
    ) as any;
    component.markExecutionStarted?.();
    applyToolComponentState(component, block, expanded);
    return component;
  } catch {
    return undefined;
  }
}

/**
 * Component-aware, snapshot-driven conversation timeline.
 * ToolExecutionComponent state is rebuilt from normalized blocks when a call id
 * first appears and then reused; history never needs a live session, spinner,
 * stream, or process handle.
 */
export class ConversationTimeline implements Component {
  private blocks: ConversationBlock[] = [];
  private showTools = true;
  private focusedToolCallId: string | undefined;
  private expandedTools = new Set<string>();
  private hoveredToolCallId: string | undefined;
  private hoveredIoView: any;
  private hoveredIoToolCallId: string | undefined;
  private hoveredIoSection: "input" | "output" | null = null;
  private lastClickedToolCallId: string | undefined;
  private lastClickedPoint: { x: number; y: number } | undefined;
  private toolComponents = new Map<string, Component & { handleMouse?: (event: TuiMouseEvent) => unknown }>();
  private snapshot: ConversationTimelineSnapshot = {
    lines: [],
    messageStarts: [],
    messageBlocks: [],
    interactiveToolIds: [],
    blockSpans: [],
    toolSpans: [],
  };
  private lastWidth = 0;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly options: ConversationTimelineOptions = {},
  ) {}

  setBlocks(blocks: readonly ConversationBlock[]): void {
    this.blocks = [...blocks];
    const ids = new Set(this.blocks.filter((block) => block.kind === "tool" && block.toolCallId).map((block) => block.toolCallId!));
    if (this.focusedToolCallId && !ids.has(this.focusedToolCallId)) this.focusedToolCallId = undefined;
    if (this.hoveredToolCallId && !ids.has(this.hoveredToolCallId)) this.hoveredToolCallId = undefined;
    if (this.hoveredIoToolCallId && !ids.has(this.hoveredIoToolCallId)) {
      this.hoveredIoView?.setHoveredSection?.(null);
      this.hoveredIoView = undefined;
      this.hoveredIoToolCallId = undefined;
      this.hoveredIoSection = null;
    }
    for (const id of this.expandedTools) if (!ids.has(id)) this.expandedTools.delete(id);
    for (const id of this.toolComponents.keys()) if (!ids.has(id)) this.toolComponents.delete(id);
    this.invalidate();
  }

  setShowTools(show: boolean): void {
    if (this.showTools === show) return;
    this.showTools = show;
    if (!show) {
      this.focusedToolCallId = undefined;
      this.hoveredToolCallId = undefined;
      this.hoveredIoView?.setHoveredSection?.(null);
      this.hoveredIoView = undefined;
      this.hoveredIoToolCallId = undefined;
      this.hoveredIoSection = null;
    }
    this.invalidate();
  }

  getShowTools(): boolean {
    return this.showTools;
  }

  setFocusedToolCallId(id: string | undefined): void {
    // Focus changes are view state. The rendered rows do not change, so keep
    // the snapshot and its Markdown/tool output cache intact.
    if (this.focusedToolCallId === id) return;
    this.focusedToolCallId = id;
  }

  getFocusedToolCallId(): string | undefined {
    return this.focusedToolCallId;
  }

  getSnapshot(): ConversationTimelineSnapshot {
    if (this.lastWidth <= 0) this.render(80);
    return this.snapshot;
  }

  moveFocus(direction: 1 | -1): boolean {
    const ids = this.getSnapshot().interactiveToolIds;
    if (ids.length === 0) return false;
    const current = this.focusedToolCallId ? ids.indexOf(this.focusedToolCallId) : -1;
    const next = current < 0
      ? direction > 0 ? 0 : ids.length - 1
      : (current + direction + ids.length) % ids.length;
    this.focusedToolCallId = ids[next];
    this.options.onChange?.({ kind: "interaction" });
    return true;
  }

  toggleFocusedTool(): boolean {
    const id = this.focusedToolCallId;
    if (!id) return false;
    if (this.expandedTools.has(id)) this.expandedTools.delete(id);
    else this.expandedTools.add(id);
    this.invalidate();
    this.options.onChange?.({ kind: "content" });
    return true;
  }

  isToolFocused(): boolean {
    return this.focusedToolCallId !== undefined;
  }

  render(width: number): string[] {
    const requestedWidth = safeWidth(width);
    if (this.lastWidth === requestedWidth) return this.snapshot.lines.map((line) => line.text);

    const lines: TimelineRenderLine[] = [];
    const messageStarts: number[] = [];
    const messageBlocks: ConversationBlock[] = [];
    const interactiveToolIds: string[] = [];
    const blockSpans: TimelineBlockSpan[] = [];
    const toolSpans: TimelineToolSpan[] = [];

    if (this.blocks.length === 0 || (!this.showTools && this.blocks.every((block) => block.kind === "tool"))) {
      const text = this.blocks.length === 0 ? "(waiting for first message...)" : "(tools hidden)";
      lines.push({ text: this.theme.fg("dim", text), plain: text, blockIndex: -1 });
    }

    for (let sourceBlockIndex = 0; sourceBlockIndex < this.blocks.length; sourceBlockIndex++) {
      const block = this.blocks[sourceBlockIndex]!;
      if (!this.showTools && block.kind === "tool") continue;
      const blockIndex = sourceBlockIndex;
      if (lines.length > 0) {
        const separator = this.theme.fg("border", "   " + "─ ".repeat(Math.max(1, Math.floor((requestedWidth - 6) / 2))).trimEnd());
        lines.push({ text: truncateToWidth(separator, requestedWidth), plain: stripAnsi(separator), blockIndex });
      }

      const hasRoleHeader = block.role === "user" || block.role === "assistant";
      const blockStartLine = lines.length;
      const snapshotBlockIndex = messageBlocks.length;
      messageStarts.push(blockStartLine);
      messageBlocks.push(block);
      if (hasRoleHeader) {
        const headerLine = ` ${renderConversationRoleHeader(block, this.theme)}`;
        lines.push({ text: truncateToWidth(headerLine, requestedWidth), plain: stripAnsi(headerLine), blockIndex, railable: true });
      }

      if (block.kind === "tool") {
        const id = block.toolCallId;
        if (id) interactiveToolIds.push(id);
        const { rendered, hintLine } = this.renderToolLines(block, requestedWidth);
        for (const line of rendered) {
          lines.push({ text: truncateToWidth(line, requestedWidth), plain: stripAnsi(line), blockIndex, railable: true });
        }
        if (id) {
          const blockHeight = lines.length - blockStartLine;
          blockSpans.push({ blockIndex: snapshotBlockIndex, startLine: blockStartLine, height: blockHeight });
          toolSpans.push({
            blockIndex: snapshotBlockIndex,
            toolCallId: id,
            startLine: blockStartLine,
            height: blockHeight,
            ...(hintLine >= 0 ? { clickStartLine: blockStartLine + (hasRoleHeader ? 1 : 0) + hintLine, clickHeight: 1 } : {}),
          });
        } else {
          blockSpans.push({ blockIndex: snapshotBlockIndex, startLine: blockStartLine, height: lines.length - blockStartLine });
        }
        continue;
      }

      try {
        const markdown = new Markdown(block.markdown || "∅", 2, 0, getMarkdownTheme(), {
          color: (text) => this.theme.fg(block.role === "meta" ? "muted" : "text", text),
        });
        for (const line of markdown.render(requestedWidth)) {
          lines.push({ text: truncateToWidth(line, requestedWidth), plain: stripAnsi(line), blockIndex, railable: true });
        }
      } catch {
        try {
          for (const line of new Text(block.markdown || "∅").render(requestedWidth)) {
            lines.push({ text: truncateToWidth(line, requestedWidth), plain: stripAnsi(line), blockIndex, railable: true });
          }
        } catch {
          for (const line of (block.markdown || "∅").split("\n")) {
            lines.push({ text: truncateToWidth(line, requestedWidth), plain: line, blockIndex, railable: true });
          }
        }
      }
      blockSpans.push({ blockIndex: snapshotBlockIndex, startLine: blockStartLine, height: lines.length - blockStartLine });
    }

    this.lastWidth = requestedWidth;
    this.snapshot = { lines, messageStarts, messageBlocks, interactiveToolIds, blockSpans, toolSpans };
    return lines.map((line) => line.text);
  }

  private renderToolLines(block: ConversationBlock, width: number): { rendered: string[]; hintLine: number } {
    const id = block.toolCallId;
    let component: (Component & { handleMouse?: (event: TuiMouseEvent) => unknown }) | undefined;
    if (id) {
      const existing = this.toolComponents.get(id);
      if (existing) {
        applyToolComponentState(existing, block, this.expandedTools.has(id));
        component = existing;
      } else {
        component = createToolComponent(
          block,
          this.tui,
          this.options.cwd ?? process.cwd(),
          this.expandedTools.has(id),
          () => this.hoveredToolCallId === id,
        ) as (Component & { handleMouse?: (event: TuiMouseEvent) => unknown }) | undefined;
        if (component) this.toolComponents.set(id, component);
      }
    }

    let rendered: string[];
    try {
      rendered = component?.render(width) ?? fallbackToolLines(
        block,
        width,
        id ? this.expandedTools.has(id) : false,
        id ? this.hoveredToolCallId === id : false,
        this.theme,
      );
    } catch {
      rendered = fallbackToolLines(
        block,
        width,
        id ? this.expandedTools.has(id) : false,
        id ? this.hoveredToolCallId === id : false,
        this.theme,
      );
    }
    const hintLine = id && !this.expandedTools.has(id)
      ? rendered.findIndex((line) => {
          const plain = stripAnsi(line);
          return plain.includes(showMoreHintText()) || plain.includes("Enter to expand");
        })
      : -1;
    return { rendered, hintLine };
  }

  /**
   * Hover only changes styling in a tool card. Re-render those rows in place
   * and leave the Markdown rows and their spans untouched.
   */
  private refreshToolSpan(span: TimelineToolSpan): boolean {
    const block = this.snapshot.messageBlocks[span.blockIndex];
    if (!block || block.kind !== "tool") return false;
    const { rendered, hintLine } = this.renderToolLines(block, this.lastWidth);
    if (rendered.length + (block.role === "user" || block.role === "assistant" ? 1 : 0) !== span.height) return false;

    const headerOffset = block.role === "user" || block.role === "assistant" ? 1 : 0;
    const sourceBlockIndex = this.snapshot.lines[span.startLine]?.blockIndex ?? -1;
    for (let index = 0; index < rendered.length; index++) {
      const line = rendered[index];
      this.snapshot.lines[span.startLine + headerOffset + index] = {
        text: truncateToWidth(line, this.lastWidth),
        plain: stripAnsi(line),
        blockIndex: sourceBlockIndex,
        railable: true,
      };
    }
    span.clickStartLine = hintLine >= 0 ? span.startLine + headerOffset + hintLine : undefined;
    span.clickHeight = hintLine >= 0 ? 1 : undefined;
    return true;
  }

  handleMouse(event: TuiMouseEvent): ConversationTimelineMouseResult | undefined {
    if (event.type === "move") {
      const hovered = this.snapshot.toolSpans.find((span) =>
        span.clickStartLine !== undefined &&
        event.y >= span.clickStartLine &&
        event.y < span.clickStartLine + (span.clickHeight ?? 1),
      )?.toolCallId;
      const fullSpan = this.snapshot.toolSpans.find((span) =>
        event.y >= span.startLine && event.y < span.startLine + span.height,
      );
      let nextIoView: any;
      let nextIoSection: "input" | "output" | null = null;
      if (fullSpan) {
        const component = this.toolComponents.get(fullSpan.toolCallId) as any;
        const view = component?.resultRendererComponent;
        const localRow = event.y - fullSpan.startLine;
        if (view && typeof view.sectionAtLine === "function" && typeof view.showMoreLine === "function" && typeof view.setHoveredSection === "function") {
          const section = view.sectionAtLine(localRow);
          if (section && view.showMoreLine(section) === localRow) {
            nextIoView = view;
            nextIoSection = section;
          }
        }
      }
      const unchanged = hovered === this.hoveredToolCallId && nextIoView === this.hoveredIoView && nextIoSection === this.hoveredIoSection;
      if (unchanged) return undefined;
      if (this.hoveredIoView && this.hoveredIoView !== nextIoView && typeof this.hoveredIoView.setHoveredSection === "function") {
        this.hoveredIoView.setHoveredSection(null);
      }
      const previousHoveredToolCallId = this.hoveredToolCallId;
      const previousIoToolCallId = this.hoveredIoToolCallId;
      const nextIoToolCallId = nextIoView ? fullSpan?.toolCallId : undefined;
      this.hoveredToolCallId = hovered;
      this.hoveredIoView = nextIoView;
      this.hoveredIoToolCallId = nextIoToolCallId;
      this.hoveredIoSection = nextIoSection;
      if (nextIoView) nextIoView.setHoveredSection(nextIoSection);

      const changedIds = new Set(
        [previousHoveredToolCallId, hovered, previousIoToolCallId, nextIoToolCallId]
          .filter((id): id is string => id !== undefined),
      );
      const changedRanges: ConversationTimelineLineRange[] = [];
      let patched = true;
      for (const id of changedIds) {
        const span = this.snapshot.toolSpans.find((candidate) => candidate.toolCallId === id);
        if (!span || !this.refreshToolSpan(span)) {
          patched = false;
          break;
        }
        changedRanges.push({ startLine: span.startLine, height: span.height });
      }
      if (!patched) {
        this.invalidate();
        this.options.onChange?.({ kind: "content" });
      } else {
        this.options.onChange?.({ kind: "interaction", changedRanges });
      }
      return { handled: true, render: true };
    }

    if (event.type !== "click" && event.type !== "press") return undefined;
    if (event.button !== "left") return undefined;

    // Keep the hint ahead of the full tool span. Its row has a distinct action.
    const hintSpan = this.snapshot.toolSpans.find((candidate) =>
      candidate.clickStartLine !== undefined &&
      event.y >= candidate.clickStartLine &&
      event.y < candidate.clickStartLine + (candidate.clickHeight ?? 1),
    );
    const fullSpan = this.snapshot.toolSpans.find((candidate) =>
      event.y >= candidate.startLine && event.y < candidate.startLine + candidate.height,
    );
    const blockSpan = this.snapshot.blockSpans.find((candidate) =>
      event.y >= candidate.startLine && event.y < candidate.startLine + candidate.height,
    );
    const target = hintSpan ?? fullSpan ?? blockSpan;
    if (!target) return undefined;
    if (event.type === "press") return { handled: true, capture: true, render: false };

    if (hintSpan || fullSpan) {
      const span = hintSpan ?? fullSpan!;
      const clickCount = event.clickCount ?? 1;
      const previousClickedToolCallId = this.lastClickedToolCallId;
      const lastSpan = this.lastClickedToolCallId
        ? this.snapshot.toolSpans.find((candidate) => candidate.toolCallId === this.lastClickedToolCallId)
        : undefined;
      const sameLastPoint = this.lastClickedPoint !== undefined &&
        event.screenX === this.lastClickedPoint.x && event.screenY === this.lastClickedPoint.y;
      const sameLastSpan = sameLastPoint && span.toolCallId === lastSpan?.toolCallId;
      const isExpanded = this.expandedTools.has(span.toolCallId);
      const shouldExpand = !isExpanded && hintSpan?.toolCallId === span.toolCallId;
      const shouldCollapse = isExpanded && clickCount === 2 && sameLastSpan && span.toolCallId === previousClickedToolCallId;

      this.focusedToolCallId = span.toolCallId;
      this.lastClickedToolCallId = span.toolCallId;
      this.lastClickedPoint = { x: event.screenX, y: event.screenY };
      if (shouldExpand) this.expandedTools.add(span.toolCallId);
      else if (shouldCollapse) this.expandedTools.delete(span.toolCallId);

      if (shouldExpand || shouldCollapse) {
        const component = this.toolComponents.get(span.toolCallId);
        try {
          component?.handleMouse?.({ ...event, y: event.y - span.startLine, height: span.height });
        } catch {
          // A missing/older Pi mouse implementation must not break the viewer.
        }
      }
      if (shouldExpand || shouldCollapse) {
        this.invalidate();
        this.options.onChange?.({ kind: "content" });
      } else {
        this.options.onChange?.({ kind: "interaction" });
      }
      return { handled: true, render: shouldExpand || shouldCollapse, focusedBlockIndex: span.blockIndex };
    }

    // A message click intentionally drops any stale tool focus so Enter cannot
    // toggle a tool that is no longer the selected block.
    this.focusedToolCallId = undefined;
    this.lastClickedToolCallId = undefined;
    this.lastClickedPoint = undefined;
    this.options.onChange?.({ kind: "interaction" });
    return { handled: true, render: true, focusedBlockIndex: target.blockIndex };
  }

  invalidate(): void {
    this.lastWidth = 0;
    this.snapshot = { lines: [], messageStarts: [], messageBlocks: [], interactiveToolIds: [], blockSpans: [], toolSpans: [] };
  }
}
