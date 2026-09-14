import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { createViewerCcstyleResult, oneLine } from "./tool-result.js";
import { DEFAULT_TOOL_DISPLAY_CONFIG } from "./diff/types.js";

export interface ViewerToolRenderers {
  name: string;
  label: string;
  renderShell: "self";
  renderCall?: (args: unknown, theme: any, context: any) => Component;
  renderResult?: (result: any, options: any, theme: any, context: any) => Component;
}

function titleForTool(toolName: string): string {
  return toolName
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function summaryForCall(toolName: string, args: any): { main: string; detail: string } {
  const title = titleForTool(toolName);
  if (!args || typeof args !== "object") return { main: title, detail: "" };
  if (toolName.toLowerCase() === "read") {
    const path = args.path ?? args.file_path;
    const details = [
      args.offset !== undefined ? `offset=${args.offset}` : "",
      args.limit !== undefined ? `limit=${args.limit}` : "",
    ].filter(Boolean);
    return {
      main: path === undefined ? title : `${title} ${oneLine(path)}`,
      detail: details.length ? ` (${details.join(", ")})` : "",
    };
  }
  const value = args.path ?? args.file_path ?? args.command ?? args.query ?? args.pattern ?? args.url ?? args.name;
  return value === undefined ? { main: title, detail: "" } : { main: `${title} ${oneLine(value)}`, detail: "" };
}

function renderCallComponent(toolName: string, args: any, theme: any, context: any): Component {
  const pending = context?.isPartial || context?.executionStarted;
  const icon = pending ? "●" : context?.isError ? "✗" : "✓";
  const color = pending ? "accent" : context?.isError ? "error" : "success";
  return {
    render(width: number): string[] {
      const safeWidth = Math.max(1, Math.floor(Number.isFinite(width) ? width : 1));
      const prefix = ` ${theme.fg(color, icon)} `;
      const summary = summaryForCall(toolName, args);
      return [truncateToWidth(prefix + theme.fg("toolTitle", summary.main) + theme.fg("dim", summary.detail), safeWidth, "")];
    },
    invalidate() {},
  };
}

/**
 * Create a renderer definition consumed by the public ToolExecutionComponent
 * renderer hooks. It is viewer-local: no Pi prototype or terminal listener is
 * installed, and no global ccstyle configuration is read.
 */
export function createViewerCcstyleTool(toolName: string, isHovered: () => boolean = () => false): ViewerToolRenderers {
  const name = String(toolName || "tool");
  // ToolExecutionComponent does not expose its result to renderCall. Keep a
  // renderer-local settled bit so a rebuilt history card can show ✓/✗ rather
  // than treating every reconstructed call as still running.
  let settled = false;
  return {
    name,
    label: name,
    renderShell: "self",
    renderCall(args, theme, context) {
      return renderCallComponent(name, args, theme, {
        ...context,
        executionStarted: settled ? false : context?.executionStarted,
      });
    },
    renderResult(result, options, theme, context) {
      settled = true;
      return createViewerCcstyleResult(name, result, { ...options, isHovered }, theme, {
        ...context,
        isHovered,
        diffConfig: { ...DEFAULT_TOOL_DISPLAY_CONFIG },
      });
    },
  };
}

export { renderRichToolResult } from "./tool-result.js";
export type { PersistedDiff, ViewerDiffConfig } from "./diff/types.js";
