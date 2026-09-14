import { Text, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import {
  renderEditDiffResult,
  renderWriteDiffResult,
  type DisplayConfigInput,
} from "./diff/diff-renderer.js";
import { DEFAULT_TOOL_DISPLAY_CONFIG, type PersistedDiff, type ViewerDiffConfig } from "./diff/types.js";
import { sanitizeToolResultText, showMoreHintText } from "./diff/render-utils.js";

export function toolViewportWidth(width: number): number {
  return Math.max(1, Math.floor(Number.isFinite(width) ? width : 1));
}

export function oneLine(value: unknown, max = 4096): string {
  const text = sanitizeToolResultText(String(value ?? "")).replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

function rawTextFromResult(result: any): string {
  return Array.isArray(result?.content)
    ? result.content
        .filter((item: any) => item?.type === "text")
        .map((item: any) => String(item.text ?? ""))
        .join("\n")
    : "";
}

export function textFromResult(result: any, expanded = false, maxChars = 16_384): string {
  const content = sanitizeToolResultText(rawTextFromResult(result), maxChars);
  const detail = result?.details;
  if (!expanded || detail === undefined) return content;
  const details = sanitizeToolResultText(
    typeof detail === "string" ? detail : safeJson(detail),
    maxChars,
  );
  if (!details || details === content) return content;
  return content ? `${content}\nDetails:\n${details}` : details;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return String(value);
  }
}

export function outputLineCount(result: any): number {
  const text = rawTextFromResult(result).replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  return text ? text.split("\n").length : 0;
}

export function countLines(text: string): number {
  return text.trim() ? text.trim().split("\n").filter((line) => line.trim()).length : 0;
}

/** Format arguments as stable, readable `key: value` rows for the Input rail. */
export function formatToolInputArgs(args: unknown, maxChars = 8_000): string {
  if (args === undefined || args === null) return "";
  if (typeof args !== "object" || Array.isArray(args)) {
    const rendered = typeof args === "string" ? sanitizeToolResultText(args) : safeJson(args);
    return rendered.length > maxChars ? `${rendered.slice(0, maxChars)}…` : rendered;
  }
  const preferred = [
    "path", "file_path", "command", "query", "pattern", "url", "name",
    "message", "content", "old_string", "new_string",
  ];
  const entries = Object.entries(args as Record<string, unknown>)
    .filter(([, value]) => value !== undefined)
    .sort(([left], [right]) => {
      const li = preferred.indexOf(left);
      const ri = preferred.indexOf(right);
      if (li < 0 && ri < 0) return left.localeCompare(right);
      if (li < 0) return 1;
      if (ri < 0) return -1;
      return li - ri;
    });
  const lines: string[] = [];
  for (const [key, value] of entries) {
    const safeKey = sanitizeToolResultText(key);
    if (typeof value === "string") {
      const safeValue = sanitizeToolResultText(value);
      if (safeValue.includes("\n")) {
        lines.push(`${safeKey}:`);
        lines.push(...safeValue.split("\n").map((line) => `  ${line}`));
      } else lines.push(`${safeKey}: ${safeValue}`);
    } else {
      const rendered = safeJson(value);
      if (rendered.includes("\n")) {
        lines.push(`${safeKey}:`);
        lines.push(...rendered.split("\n").map((line) => `  ${line}`));
      } else lines.push(`${safeKey}: ${rendered}`);
    }
  }
  const rendered = lines.join("\n");
  return rendered.length > maxChars ? `${rendered.slice(0, maxChars)}…` : rendered;
}

function hasExpandableDetail(text: string, args: unknown): boolean {
  return countLines(text) > 1 || formatToolInputArgs(args).trim().length > 0;
}

export type ToolIoSection = "input" | "output";

/** Viewer-local adaptation of pi-cc's structured Input/Output tool card. */
export class ExpandedToolIoView implements Component {
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;
  private lineSections: Array<ToolIoSection | null> = [];
  private hoveredSection: ToolIoSection | null = null;
  private showMoreRows: Partial<Record<ToolIoSection, number>> = {};

  constructor(
    private input: string,
    private output: string,
    private readonly isError: boolean,
    private readonly maxOutputLines = DEFAULT_TOOL_DISPLAY_CONFIG.expandedPreviewMaxLines,
    private readonly maxInputLines = DEFAULT_TOOL_DISPLAY_CONFIG.expandedPreviewMaxLines,
    private readonly theme?: any,
  ) {}

  getInputBody(): string { return this.input; }
  getOutputBody(): string { return this.output.trim() ? this.output : "Done"; }

  setHoveredSection(section: ToolIoSection | null): void {
    if (this.hoveredSection === section) return;
    this.hoveredSection = section;
    this.invalidate();
  }

  sectionAtLine(line: number): ToolIoSection | null { return this.lineSections[line] ?? null; }
  showMoreLine(section: ToolIoSection): number | undefined { return this.showMoreRows[section]; }

  render(width: number): string[] {
    const safeWidth = toolViewportWidth(width);
    if (this.cachedLines && this.cachedWidth === safeWidth) return this.cachedLines;
    const theme = this.theme;
    const color = (name: string, value: string): string => typeof theme?.fg === "function" ? theme.fg(name, value) : value;
    const bold = (value: string): string => typeof theme?.bold === "function" ? theme.bold(value) : value;
    const rail = " │ ";
    const contentWidth = Math.max(1, safeWidth - visibleWidth(rail));
    const bodyColor = this.isError ? "error" : "toolOutput";
    const rows: string[] = [];
    this.lineSections = [];
    this.showMoreRows = {};
    const push = (line: string, section: ToolIoSection | null) => {
      rows.push(truncateToWidth(line, safeWidth, ""));
      this.lineSections.push(section);
    };
    const pushHeader = (corner: "├" | "└", title: string) => {
      push(color("dim", ` ${corner} `) + color("accent", bold(title)), null);
    };
    const pushRail = (line: string, section: ToolIoSection, continued: boolean) => {
      push(color("dim", continued ? rail : "   ") + line, section);
    };
    const pushBody = (body: string, section: ToolIoSection, limit: number, continued: boolean, input: boolean) => {
      const raw = body.replace(/\t/g, "   ").replace(/\n+$/, "");
      if (!raw.trim()) {
        pushRail(color("dim", "(empty)"), section, continued);
        return;
      }
      const sources = raw.split("\n");
      const wrapped: string[] = [];
      const styleInput = (line: string): string => {
        const match = line.match(/^([A-Za-z_][\w.-]*)(:\s*)(.*)$/);
        return match
          ? color("dim", `${match[1]}${match[2]}`) + color("muted", match[3] ?? "")
          : color("muted", line);
      };
      for (const source of sources) {
        const styled = input ? styleInput(source) : color(bodyColor, source);
        const lines = wrapTextWithAnsi(styled, contentWidth);
        wrapped.push(...(lines.length ? lines : [styled]));
      }
      const truncated = sources.length > limit || wrapped.length > limit;
      const visible = truncated ? wrapped.slice(0, limit) : wrapped;
      for (const line of visible) pushRail(line, section, continued);
      if (truncated && wrapped.length > visible.length) {
        const hidden = wrapped.length - visible.length;
        const hintColor = this.hoveredSection === section ? "text" : "dim";
        pushRail(
          color("dim", `… +${hidden} more lines`) + color("dim", " •") + color(hintColor, ` ${showMoreHintText()}`),
          section,
          continued,
        );
        this.showMoreRows[section] = rows.length - 1;
      }
    };

    const hasInput = this.input.trim().length > 0;
    if (hasInput) {
      pushHeader("├", "Input");
      pushBody(this.input, "input", Math.max(1, this.maxInputLines), true, true);
      push(color("dim", " │"), null);
    }
    pushHeader("└", "Output");
    pushBody(this.getOutputBody(), "output", Math.max(1, this.maxOutputLines), false, false);
    this.cachedWidth = safeWidth;
    this.cachedLines = rows;
    return rows;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}

function unavailableComponent(reason: string, theme: any): Component {
  return {
    render(width: number): string[] {
      return [truncateToWidth(theme.fg("warning", `↳ diff unavailable: ${oneLine(reason, 512)}`), toolViewportWidth(width), "")];
    },
    invalidate() {},
  };
}

function resultText(result: any): string { return rawTextFromResult(result); }

function persistedFromDetails(details: any): PersistedDiff | undefined {
  if (!details || typeof details !== "object") return undefined;
  const persisted: PersistedDiff = {};
  if (typeof details.diff === "string") persisted.diff = details.diff;
  if (typeof details.patch === "string") persisted.patch = details.patch;
  if (typeof details.diffUnavailableReason === "string") persisted.diffUnavailableReason = details.diffUnavailableReason;
  return Object.keys(persisted).length ? persisted : undefined;
}

function viewerConfig(context: any): ViewerDiffConfig {
  const candidate = context?.diffConfig;
  return candidate && typeof candidate === "object"
    ? { ...DEFAULT_TOOL_DISPLAY_CONFIG, ...candidate }
    : DEFAULT_TOOL_DISPLAY_CONFIG;
}

export function renderRichToolResult(
  toolName: string,
  result: any,
  options: any,
  theme: any,
  context: any,
): Component | undefined {
  if (options?.isPartial || options?.isError || context?.isError) return undefined;
  const expanded = options?.expanded === true || context?.expanded === true;
  const args = context?.args ?? options?.args;
  const details = result?.details;
  const persistedDiff = context?.persistedDiff ?? persistedFromDetails(details);
  const fileExistedBeforeWrite = typeof context?.fileExistedBeforeWrite === "boolean"
    ? context.fileExistedBeforeWrite
    : typeof details?.fileExistedBeforeWrite === "boolean" ? details.fileExistedBeforeWrite : undefined;

  if (toolName === "edit") {
    return renderEditDiffResult(details, {
      expanded, filePath: args?.file_path ?? args?.path, persistedDiff,
      isHovered: options?.isHovered, invalidate: context?.invalidate,
    }, viewerConfig(context), theme, resultText(result));
  }
  if (toolName !== "write") return undefined;
  if (persistedDiff?.diffUnavailableReason && !persistedDiff.diff && !persistedDiff.patch) {
    return unavailableComponent(persistedDiff.diffUnavailableReason, theme);
  }
  const content = typeof args?.content === "string" ? args.content : undefined;
  if (typeof content !== "string" && !persistedDiff?.diff && !persistedDiff?.patch) {
    return unavailableComponent("execution metadata is unavailable", theme);
  }
  return renderWriteDiffResult(content, {
    expanded,
    filePath: args?.file_path ?? args?.path,
    persistedDiff,
    previousContent: context?.previousContent,
    fileExistedBeforeWrite,
    isHovered: options?.isHovered,
    invalidate: context?.invalidate,
  }, viewerConfig(context), theme, resultText(result));
}

function renderFallbackResult(result: any, options: any, theme: any, context: any): Component {
  const error = options?.isError || context?.isError;
  const expanded = options?.expanded === true || context?.expanded === true;
  const maxChars = Number.isFinite(context?.maxChars) ? Math.max(0, Math.floor(context.maxChars)) : 16_384;
  const text = textFromResult(result, expanded, maxChars);
  const input = formatToolInputArgs(context?.args, maxChars);
  if (expanded && (text.trim() || input.trim())) {
    const maxLines = Number.isFinite(context?.diffConfig?.expandedPreviewMaxLines)
      ? Math.max(1, Math.floor(context.diffConfig.expandedPreviewMaxLines))
      : DEFAULT_TOOL_DISPLAY_CONFIG.expandedPreviewMaxLines;
    return new ExpandedToolIoView(input, text, Boolean(error), maxLines, maxLines, theme);
  }
  const count = text ? text.split("\n").length : 0;
  const summary = error ? oneLine(text) || "Failed" : count ? `${count} ${count === 1 ? "line" : "lines"} returned` : "Done";
  const expandable = !expanded && hasExpandableDetail(text, context?.args);
  return {
    render(width: number): string[] {
      const hovered = options?.isHovered?.() ?? context?.isHovered?.() ?? false;
      const hint = expandable ? ` • ${showMoreHintText()}` : "";
      const line = expandable && hovered
        ? theme.fg(error ? "error" : "muted", `   ↳ ${summary} • `) + theme.fg("text", showMoreHintText())
        : theme.fg(error ? "error" : "muted", `   ↳ ${summary}${hint}`);
      return [truncateToWidth(line, toolViewportWidth(width), "")];
    },
    invalidate() {},
  };
}

export function createViewerCcstyleResult(toolName: string, result: any, options: any, theme: any, context: any): Component {
  return renderRichToolResult(toolName, result, options, theme, context) ?? renderFallbackResult(result, options, theme, context);
}

export type { DisplayConfigInput };
