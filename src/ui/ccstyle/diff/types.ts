export type DiffViewMode = "auto" | "split" | "unified";
export type DiffIndicatorMode = "bars" | "classic" | "none";

/** Immutable viewer-local configuration; no global ccstyle config is consulted. */
export interface ViewerDiffConfig {
  diffWordWrap: boolean;
  diffViewMode: DiffViewMode;
  diffIndicatorMode: DiffIndicatorMode;
  editDiffCollapsedLines: number;
  expandedPreviewMaxLines: number;
  /** Optional compatibility knobs for callers that want split/write tuning. */
  diffSplitMinWidth?: number;
  writeDiffCollapsedLines?: number;
}

/** @deprecated Use ViewerDiffConfig. Kept as a local alias for renderer callers. */
export type ToolDisplayConfig = ViewerDiffConfig;

export const DEFAULT_TOOL_DISPLAY_CONFIG: ViewerDiffConfig = Object.freeze({
  diffWordWrap: true,
  diffViewMode: "auto",
  diffIndicatorMode: "bars",
  editDiffCollapsedLines: 24,
  expandedPreviewMaxLines: 40,
  diffSplitMinWidth: 120,
  writeDiffCollapsedLines: 0,
});

export interface PersistedDiff {
  diff?: string;
  patch?: string;
  diffUnavailableReason?: string;
}
