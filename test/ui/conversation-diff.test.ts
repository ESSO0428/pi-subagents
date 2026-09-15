import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
  renderEditDiffResult,
  renderWriteDiffResult,
} from "../../src/ui/ccstyle/diff/diff-renderer.js";
import { DEFAULT_TOOL_DISPLAY_CONFIG } from "../../src/ui/ccstyle/diff/types.js";
import {
  createViewerCcstyleResult,
  renderRichToolResult,
  resolveToolOutputLanguage,
} from "../../src/ui/ccstyle/tool-result.js";

const theme = {
  fg(color: string, text: string) {
    return `<${color}>${text}</${color}>`;
  },
  bg(color: string, text: string) {
    return `<bg:${color}>${text}</bg:${color}>`;
  },
  bold(text: string) {
    return `<bold>${text}</bold>`;
  },
  getBgAnsi() {
    return "";
  },
  getFgAnsi() {
    return "";
  },
};

const config = {
  ...DEFAULT_TOOL_DISPLAY_CONFIG,
  diffViewMode: "unified" as const,
};

describe("viewer-local ccstyle diff renderer", () => {
  it("renders persisted write diff after the underlying file changes", () => {
    const persisted = {
      diff: "-1 old\n+1 new",
      patch: "--- file.txt\n+++ file.txt\n@@ -1,1 +1,1 @@\n-old\n+new\n",
    };

    const first = renderWriteDiffResult(undefined, {
      expanded: true,
      filePath: "file.txt",
      persistedDiff: persisted,
    }, config, theme, "");
    const second = renderWriteDiffResult(undefined, {
      expanded: true,
      filePath: "file.txt",
      persistedDiff: persisted,
    }, config, theme, "");

    expect(second.render(100).join("\n")).toContain("new");
    expect(second.render(100).join("\n")).toBe(first.render(100).join("\n"));
  });

  it("prefers persisted write diff over the current content fallback", () => {
    const component = renderWriteDiffResult("later\n", {
      expanded: true,
      filePath: "file.txt",
      previousContent: "old\n",
      fileExistedBeforeWrite: true,
      persistedDiff: { diff: "-1 old\n+1 new", patch: "--- file.txt\n+++ file.txt\n@@ -1,1 +1,1 @@\n-old\n+new\n" },
    }, config, theme, "");

    const rendered = component.render(100).join("\n");
    expect(rendered).toContain("new");
    expect(rendered).not.toContain("later");
  });

  it("returns an explicit unavailable row instead of an empty success card", () => {
    const component = renderRichToolResult("write", {
      content: [{ type: "text", text: "Successfully wrote" }],
      details: { diffUnavailableReason: "durable diff exceeds limit" },
    }, { expanded: true }, theme, { args: { path: "large.txt" } });

    expect(component?.render(100).join("\n")).toContain("diff unavailable");
  });

  it("keeps edit diff and all output rows within the requested width", () => {
    const component = renderEditDiffResult(
      { diff: "-1 a very long removed line\n+1 a very long added line" },
      { expanded: true, filePath: "file.ts" },
      config,
      theme,
      "",
    );

    for (const width of [20, 40, 100]) {
      expect(component.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
    }
  });

  it("uses path metadata before an explicit fence and leaves untagged output plain", () => {
    expect(resolveToolOutputLanguage({ path: "src/result.ts" }, "```python\nprint(1)\n```")).toBe("typescript");
    expect(resolveToolOutputLanguage(undefined, "echo hi\nplain output")).toBeUndefined();
  });

  it("renders ordinary expanded output through the shared Input/Output card", () => {
    const component = createViewerCcstyleResult(
      "read",
      { content: [{ type: "text", text: "const answer = 42;" }] },
      { expanded: true },
      theme,
      { args: { file_path: "src/result.ts" } },
    );
    const rendered = component?.render(100).join("\n") ?? "";
    expect(rendered).toContain("Input");
    expect(rendered).toContain("Output");
    expect(rendered).toContain("answer");
  });
});
