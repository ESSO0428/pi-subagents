import { getLanguageFromPath, highlightCode } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
  type DisplayConfigInput,
  renderEditDiffResult,
  renderWriteDiffResult,
} from "./diff/diff-renderer.js";
import { sanitizeAnsiForThemedOutput, sanitizeToolResultText, showMoreHintText } from "./diff/render-utils.js";
import { MAX_HL_CHARS, shikiHighlightCache } from "./diff/shiki-highlight.js";
import { DEFAULT_TOOL_DISPLAY_CONFIG, type PersistedDiff, type ViewerDiffConfig } from "./diff/types.js";

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

type FencedCodeRegion = {
  bodyStart: number;
  bodyEnd: number;
  language?: string;
};

type OutputHighlightPlan = {
  lines: string[];
  code: string;
  codeLineIndexes: number[];
};

function parseFenceOpening(line: string): { marker: string; language?: string } | undefined {
  const match = line.match(/^\s*(`{3,}|~{3,})(?:\s*([A-Za-z][\w+.-]*))?(?:\s+.*)?\s*$/);
  if (!match) return undefined;
  return { marker: match[1]!, language: match[2] };
}

function isFenceClosing(line: string, marker: string): boolean {
  const trimmed = line.trim();
  return trimmed.length >= marker.length &&
    trimmed[0] === marker[0] &&
    [...trimmed].every((character) => character === marker[0]);
}

function findFencedCodeRegion(lines: readonly string[]): FencedCodeRegion | undefined {
  for (let openingIndex = 0; openingIndex < lines.length; openingIndex++) {
    const opening = parseFenceOpening(lines[openingIndex]!);
    if (!opening) continue;
    let bodyEnd = lines.length;
    for (let index = openingIndex + 1; index < lines.length; index++) {
      if (isFenceClosing(lines[index]!, opening.marker)) {
        bodyEnd = index;
        break;
      }
    }
    return {
      bodyStart: openingIndex + 1,
      bodyEnd,
      ...(opening.language ? { language: opening.language } : {}),
    };
  }
  return undefined;
}

function pathFromToolArgs(args: unknown): string | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const record = args as Record<string, unknown>;
  const path = record.file_path ?? record.path;
  return typeof path === "string" && path.trim() ? path : undefined;
}

/** Resolve only explicit tool/path or fenced metadata; no command/log heuristics. */
export function resolveToolOutputLanguage(args: unknown, output: string): string | undefined {
  const path = pathFromToolArgs(args)?.replace(/^@/, "").trim();
  if (path) {
    try {
      const language = getLanguageFromPath(path);
      if (language) return language;
    } catch {
      // Fall through to an explicit fence when the path mapping is unavailable.
    }
  }
  const lines = output.replace(/\t/g, "   ").replace(/\n+$/, "").split("\n");
  return findFencedCodeRegion(lines)?.language;
}

function outputHighlightPlan(output: string, language: string | undefined): OutputHighlightPlan | undefined {
  if (!language || !output.trim() || output.length > MAX_HL_CHARS) return undefined;
  const lines = output.replace(/\t/g, "   ").replace(/\n+$/, "").split("\n");
  // A path language follows Pi's read renderer and applies to the complete
  // output. A fence-only language is also highlighted as a normal code body;
  // keeping one line-to-line mapping preserves fences and wrapping safely.
  const codeLineIndexes = lines.map((_, index) => index);
  const codeLines = codeLineIndexes.map((index) => sanitizeToolResultText(lines[index] ?? "").replace(/\n/g, ""));
  const code = codeLines.join("\n");
  if (!code || code.length > MAX_HL_CHARS) return undefined;
  return { lines, code, codeLineIndexes };
}

function syncHighlight(code: string, language: string, fallback: readonly string[]): string[] {
  try {
    const highlighted = highlightCode(code, language).map(sanitizeAnsiForThemedOutput);
    return highlighted.length === fallback.length
      ? highlighted
      : fallback.map((line, index) => highlighted[index] ?? line);
  } catch {
    return fallback.map(sanitizeAnsiForThemedOutput);
  }
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
  private readonly outputLanguage?: string;
  private readonly invalidateCard?: () => void;
  private outputHighlightKey: string | undefined;
  private outputHighlightState: {
    plan: OutputHighlightPlan;
    fallback: string[];
    fallbackReady: boolean;
    shiki?: string[];
  } | undefined;
  private readonly onHighlightReady = (): void => {
    this.invalidate();
    this.invalidateCard?.();
  };

  constructor(
    private input: string,
    private output: string,
    private readonly isError: boolean,
    private readonly maxOutputLines = DEFAULT_TOOL_DISPLAY_CONFIG.expandedPreviewMaxLines,
    private readonly maxInputLines = DEFAULT_TOOL_DISPLAY_CONFIG.expandedPreviewMaxLines,
    private readonly theme?: any,
    outputLanguage?: string,
    invalidateCard?: () => void,
  ) {
    this.outputLanguage = outputLanguage;
    this.invalidateCard = invalidateCard;
  }

  getInputBody(): string { return this.input; }
  getOutputBody(): string { return this.output.trim() ? this.output : "Done"; }

  private highlightedOutputLines(body: string): string[] {
    const plainLines = body.split("\n");
    const plan = outputHighlightPlan(body, this.outputLanguage);
    if (!plan) return plainLines;

    const key = `${this.outputLanguage ?? ""}\0${plan.code}\0${plan.lines.join("\n")}`;
    if (this.outputHighlightKey !== key || !this.outputHighlightState) {
      this.outputHighlightKey = key;
      this.outputHighlightState = {
        plan,
        // A plain fallback lets a cache hit avoid running the synchronous
        // highlighter again. On a miss it is replaced below before paint.
        fallback: plan.code.split("\n"),
        fallbackReady: false,
      };
    }

    const state = this.outputHighlightState;
    const shikiLines = state.shiki ?? shikiHighlightCache.get(
      plan.code,
      this.outputLanguage,
      process.env.DIFF_THEME || "github-dark",
      state.fallback,
      this.onHighlightReady,
    );
    if (shikiLines) {
      state.shiki = shikiLines.map(sanitizeAnsiForThemedOutput);
    } else if (!state.fallbackReady) {
      state.fallback = syncHighlight(plan.code, this.outputLanguage!, state.fallback);
      state.fallbackReady = true;
    }

    const highlightedCode = state.shiki ?? state.fallback;
    const lines = plan.lines.slice();
    for (const [codeIndex, lineIndex] of plan.codeLineIndexes.entries()) {
      lines[lineIndex] = highlightedCode[codeIndex] ?? lines[lineIndex] ?? "";
    }
    return lines;
  }

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
      const highlighted = input ? undefined : this.highlightedOutputLines(raw);
      const wrapped: string[] = [];
      const styleInput = (line: string): string => {
        const match = line.match(/^([A-Za-z_][\w.-]*)(:\s*)(.*)$/);
        return match
          ? color("dim", `${match[1]}${match[2]}`) + color("muted", match[3] ?? "")
          : color("muted", line);
      };
      for (const [index, source] of sources.entries()) {
        const outputLine = highlighted?.[index] ?? source;
        // Shiki/core ANSI carries the actual token colors. Do not wrap it in
        // theme.fg(), whose closing reset would erase nested token styles.
        const hasAnsi = /\x1b\[[0-?]*[ -/]*[@-~]/.test(outputLine);
        const styled = input
          ? styleInput(source)
          : hasAnsi ? sanitizeAnsiForThemedOutput(outputLine) : color(bodyColor, outputLine);
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
    const language = resolveToolOutputLanguage(context?.args, text);
    return new ExpandedToolIoView(
      input,
      text,
      Boolean(error),
      maxLines,
      maxLines,
      theme,
      language,
      context?.invalidate,
    );
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
