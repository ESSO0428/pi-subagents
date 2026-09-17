import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { ConversationViewer, createStaticConversationSource } from "../../src/ui/conversation-viewer.js";

const theme = {
  fg: (name: string, text: string) => name === "text" ? `\x1b[36m${text}\x1b[39m` : text,
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
};

function record(extra: Record<string, unknown> = {}): any {
  return {
    id: "agent-1",
    type: "general-purpose",
    description: "test agent",
    status: "completed",
    toolUses: 0,
    startedAt: 0,
    lifetimeUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...extra,
  };
}

function tui() {
  return {
    terminal: { rows: 30 },
    requestRender: vi.fn(),
    stop: vi.fn(),
    start: vi.fn(),
  } as any;
}

function mouse(type: TuiMouseEvent["type"], y: number, overrides: Partial<TuiMouseEvent> = {}): TuiMouseEvent {
  return {
    type,
    button: "left",
    x: 2,
    y,
    screenX: 2,
    screenY: y,
    width: 120,
    height: 30,
    shift: false,
    alt: false,
    ctrl: false,
    ...overrides,
  };
}

// The test record has the default invocation row, so timeline line 0 is viewer row 4.
function viewerY(timelineLine: number): number {
  return 4 + timelineLine;
}

describe("ConversationViewer", () => {
  it("renders assistant fenced code through the Markdown renderer", () => {
    const ui = tui();
    const viewer = new ConversationViewer(
      ui,
      createStaticConversationSource([
        { role: "assistant", content: [{ type: "text", text: "```ts\nconst answer: number = 42;\n```" }] },
      ] as any),
      record(),
      undefined,
      theme,
      vi.fn(),
    );

    const rendered = viewer.render(100).join("\n");
    expect(rendered).toContain("answer");
    expect(rendered).toMatch(/\x1b\[/);
  });

  it("toggles compact tool rows without changing the transcript", () => {
    const ui = tui();
    const viewer = new ConversationViewer(
      ui,
      createStaticConversationSource([
        { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "src/index.ts" } }] },
        { role: "toolResult", toolName: "read", content: [{ type: "text", text: "contents" }] },
      ] as any),
      record(),
      undefined,
      theme,
      vi.fn(),
    );

    expect(viewer.render(100).join("\n")).toContain("read");
    viewer.handleInput("t");
    expect(viewer.render(100).join("\n")).not.toContain("contents");
    viewer.handleInput("t");
    expect(viewer.render(100).join("\n")).toContain("contents");
  });

  it("shows pi-peek hints for live viewers and hides O in history", () => {
    const live = new ConversationViewer(
      tui(),
      createStaticConversationSource([{ role: "assistant", content: "live" }] as any),
      record({ status: "running", session: {} }),
      undefined,
      theme,
      vi.fn(),
      vi.fn(),
      undefined,
      vi.fn(),
      { pi: {} as any, ctx: {} as any, readOnly: false },
    );
    const liveFooter = live.render(120).join("\n");
    expect(liveFooter).toContain("j/k scroll · J/K messages · [/] tools · w preview · g/G   t   M o O   /n N   q");
    expect(liveFooter).toContain("e steer");
    expect(liveFooter).toContain("x stop");
    live.handleInput("e");
    expect(live.render(120).join("\n")).toContain("Enter send");
    live.handleInput("\x1b");

    const history = new ConversationViewer(
      tui(),
      createStaticConversationSource([{ role: "assistant", content: "history" }] as any),
      record({ session: {} }),
      undefined,
      theme,
      vi.fn(),
      undefined,
      undefined,
      undefined,
      { pi: {} as any, ctx: {} as any, readOnly: true },
    );
    const historyFooter = history.render(120).join("\n");
    expect(historyFooter).toContain("j/k scroll · J/K messages · [/] tools · w preview · g/G   t   M o   /n N   q");
    expect(historyFooter).not.toContain("M o O");
  });

  it("shows semantic role headers, effective invocation metadata, and the search row", () => {
    const semanticTheme = {
      fg: (name: string, text: string) => `<${name}>${text}</${name}>`,
      bold: (text: string) => `<bold>${text}</bold>`,
    };
    const viewer = new ConversationViewer(
      tui(),
      createStaticConversationSource([
        { role: "user", content: "find model" },
        { role: "assistant", content: [{ type: "text", text: "model found" }] },
      ] as any),
      record({ invocation: { effectiveModelName: "claude-sonnet", effectiveThinking: "high" } }),
      undefined,
      semanticTheme,
      vi.fn(),
    );

    const initial = viewer.render(120).join("\n");
    expect(initial).toContain("<userMessageText>USER</userMessageText>");
    expect(initial).toContain("<userMessageText>find model</userMessageText>");
    expect(initial).toContain("<accent>ASSISTANT</accent>");
    expect(initial).toContain("model: claude-sonnet");
    expect(initial).toContain("thinking: high");

    viewer.handleInput("/");
    const searchRow = viewer.render(120).join("\n");
    expect(searchRow).toContain("<accent>/</accent>");
    expect(searchRow).toContain("Enter apply · Esc cancel");
    for (const character of "model") viewer.handleInput(character);
    expect(viewer.render(120).join("\n")).toContain("model");
  });

  it("focuses and expands a bounded fallback tool card", () => {
    const viewer = new ConversationViewer(
      tui(),
      createStaticConversationSource([
        { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "x" } }] },
        { role: "toolResult", toolName: "read", content: [{ type: "text", text: "one\ntwo\nthree\nfour\nfive\nsix" }] },
      ] as any),
      record(),
      undefined,
      theme,
      vi.fn(),
    );

    expect(viewer.render(120).join("\n")).not.toContain("six");
    viewer.handleInput("\t");
    viewer.handleInput("\r");
    expect(viewer.render(120).join("\n")).toContain("six");
  });

  it("toggles mouse expansion only on the normalized click event", () => {
    const viewer = new ConversationViewer(
      tui(),
      createStaticConversationSource([
        { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "x" } }] },
        { role: "toolResult", toolName: "read", content: [{ type: "text", text: "one\ntwo\nthree\nfour\nfive\nsix" }] },
      ] as any),
      record(),
      undefined,
      theme,
      vi.fn(),
    );
    expect(viewer.render(120).join("\n")).not.toContain("six");
    const span = (viewer as any).timeline.getSnapshot().toolSpans[0];
    expect(span.clickStartLine).toEqual(expect.any(Number));
    const hintY = viewerY(span.clickStartLine);
    expect(viewer.handleMouse(mouse("press", hintY))?.handled).toBe(true);
    expect(viewer.render(120).join("\n")).not.toContain("six");
    viewer.handleMouse(mouse("click", hintY, { clickCount: 1 }));
    expect(viewer.render(120).join("\n")).toContain("six");
  });

  it("focuses USER and ASSISTANT blocks from their rendered spans", () => {
    const viewer = new ConversationViewer(
      tui(),
      createStaticConversationSource([
        { role: "user", content: "user text" },
        { role: "assistant", content: [{ type: "text", text: "assistant text" }] },
      ] as any),
      record(),
      undefined,
      theme,
      vi.fn(),
    );

    viewer.render(120);
    const timeline = (viewer as any).timeline;
    const spans = timeline.getSnapshot().blockSpans;
    expect(spans).toHaveLength(2);
    viewer.handleMouse(mouse("click", viewerY(spans[1].startLine), { clickCount: 1 }));
    expect((viewer as any).selectedMessageIdx).toBe(1);
    expect(timeline.getFocusedToolCallId()).toBeUndefined();
    viewer.handleMouse(mouse("click", viewerY(spans[0].startLine), { clickCount: 1 }));
    expect((viewer as any).selectedMessageIdx).toBe(0);
    expect(timeline.getFocusedToolCallId()).toBeUndefined();
  });

  it("focuses normal tool rows without expanding, while hint clicks expand", () => {
    const viewer = new ConversationViewer(
      tui(),
      createStaticConversationSource([
        { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "x" } }] },
        { role: "toolResult", toolName: "read", content: [{ type: "text", text: "one\ntwo\nthree\nfour\nfive\nsix" }] },
      ] as any),
      record(),
      undefined,
      theme,
      vi.fn(),
    );

    expect(viewer.render(120).join("\n")).not.toContain("six");
    const timeline = (viewer as any).timeline;
    const initialSpan = timeline.getSnapshot().toolSpans[0];
    const toolId = initialSpan.toolCallId;
    const hintLine = initialSpan.clickStartLine as number;
    const normalOutputLine = hintLine - 1;

    const press = viewer.handleMouse(mouse("press", viewerY(hintLine)));
    expect(press).toMatchObject({ handled: true, capture: true });
    expect(timeline.getFocusedToolCallId()).toBeUndefined();
    expect(viewer.render(120).join("\n")).not.toContain("six");

    viewer.handleMouse(mouse("click", viewerY(normalOutputLine), { clickCount: 1 }));
    expect(timeline.getFocusedToolCallId()).toBe(toolId);
    expect((viewer as any).selectedMessageIdx).toBe(initialSpan.blockIndex);
    expect(viewer.render(120).join("\n")).not.toContain("six");

    const collapsedSpan = timeline.getSnapshot().toolSpans[0];
    viewer.handleMouse(mouse("click", viewerY(collapsedSpan.clickStartLine as number), { clickCount: 1 }));
    expect(timeline.getFocusedToolCallId()).toBe(toolId);
    expect(viewer.render(120).join("\n")).toContain("six");
  });

  it("synchronizes J/K message focus and anchors [/] around the selected message", () => {
    const viewer = new ConversationViewer(
      tui(),
      createStaticConversationSource([
        { role: "user", content: "user one" },
        { role: "assistant", content: [{ type: "text", text: "assistant one" }] },
        { role: "assistant", content: [{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "one" } }] },
        { role: "toolResult", toolCallId: "tool-1", toolName: "read", content: [{ type: "text", text: "one" }] },
        { role: "assistant", content: [{ type: "text", text: "assistant two" }] },
        { role: "assistant", content: [{ type: "toolCall", id: "tool-2", name: "read", arguments: { path: "two" } }] },
        { role: "toolResult", toolCallId: "tool-2", toolName: "read", content: [{ type: "text", text: "two" }] },
      ] as any),
      record(),
      undefined,
      theme,
      vi.fn(),
    );

    viewer.render(120);
    const timeline = (viewer as any).timeline;
    const snapshot = timeline.getSnapshot();
    viewer.handleInput("]");
    expect((viewer as any).selectedMessageIdx).toBe(snapshot.toolSpans[0].blockIndex);
    expect(timeline.getFocusedToolCallId()).toBe("tool-1");

    viewer.handleInput("J");
    expect((viewer as any).selectedMessageIdx).toBe(3);
    expect(timeline.getFocusedToolCallId()).toBeUndefined();
    viewer.handleInput("]");
    expect((viewer as any).selectedMessageIdx).toBe(snapshot.toolSpans[1].blockIndex);
    expect(timeline.getFocusedToolCallId()).toBe("tool-2");

    viewer.handleInput("K");
    expect((viewer as any).selectedMessageIdx).toBe(3);
    expect(timeline.getFocusedToolCallId()).toBeUndefined();
    viewer.handleInput("[");
    expect((viewer as any).selectedMessageIdx).toBe(snapshot.toolSpans[0].blockIndex);
    expect(timeline.getFocusedToolCallId()).toBe("tool-1");
  });

  it("uses the first or last tool for initial [/], before an explicit focus exists", () => {
    const source = createStaticConversationSource([
      { role: "assistant", content: [{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "one" } }] },
      { role: "toolResult", toolCallId: "tool-1", toolName: "read", content: [{ type: "text", text: "one" }] },
      { role: "assistant", content: [{ type: "toolCall", id: "tool-2", name: "read", arguments: { path: "two" } }] },
      { role: "toolResult", toolCallId: "tool-2", toolName: "read", content: [{ type: "text", text: "two" }] },
    ] as any);
    const makeViewer = () => new ConversationViewer(tui(), source, record(), undefined, theme, vi.fn());

    const left = makeViewer();
    left.render(120);
    left.handleInput("[");
    expect((left as any).timeline.getFocusedToolCallId()).toBe("tool-2");

    const right = makeViewer();
    right.render(120);
    right.handleInput("]");
    expect((right as any).timeline.getFocusedToolCallId()).toBe("tool-1");
  });

  it("highlights the collapsed tool hint and the viewer close control independently", () => {
    const semanticTheme = {
      fg: (name: string, text: string) => `<${name}>${text}</${name}>`,
      bold: (text: string) => `<bold>${text}</bold>`,
    };
    const done = vi.fn();
    const viewer = new ConversationViewer(
      tui(),
      createStaticConversationSource([
        { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "x" } }] },
        { role: "toolResult", toolName: "read", content: [{ type: "text", text: "one\ntwo\nthree\nfour\nfive\nsix" }] },
      ] as any),
      record(),
      undefined,
      semanticTheme,
      done,
    );
    const initial = viewer.render(120).join("\n");
    const span = (viewer as any).timeline.getSnapshot().toolSpans[0];
    const hintY = viewerY(span.clickStartLine);
    expect(initial).not.toContain("<text>click to show more</text>");
    viewer.handleMouse(mouse("move", hintY, { button: "none" }));
    expect(viewer.render(120).join("\n")).toContain("<text>click to show more</text>");
    viewer.handleMouse(mouse("move", 1, { button: "none", x: 114, screenX: 114, screenY: 1 }));
    expect(viewer.render(120).join("\n")).toContain("<text><bold>[esc]</bold></text>");
    expect(viewer.handleMouse(mouse("press", 1, { x: 114, screenX: 114 }))?.handled).toBe(true);
    expect(viewer.handleMouse(mouse("click", 1, { x: 114, screenX: 114, clickCount: 1 }))?.handled).toBe(true);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("focuses nearby tools with [ and ] and opens a complete read-only preview with w", () => {
    const ui = tui();
    let preview: any;
    const previewDone = vi.fn();
    const custom = vi.fn((factory: any) => {
      preview = factory(ui, theme, undefined, previewDone);
      const initialLines = preview.render(100);
      const initial = initialLines.join("\\n");
      expect(initial).toContain("Input");
      expect(initial).toContain("Output");
      expect(initial).toContain("line 1");
      expect(initial).not.toContain("line 40");
      expect(initialLines.at(-3)).toContain("↓");
      expect(initialLines.slice(3, -3).some((line: string) => /[┃█]│$/.test(line))).toBe(true);
      preview.handleInput("G");
      const bottomLines = preview.render(100);
      expect(bottomLines.join("\\n")).toContain("line 40");
      expect(bottomLines[2]).toContain("↑");
      preview.handleInput("k");
      preview.handleInput("j");
      preview.handleInput("g");
      preview.handleInput("g");
      expect(preview.render(100).join("\\n")).toContain("line 1");
      preview.handleInput("q");
      expect(previewDone).toHaveBeenCalledTimes(1);
      return Promise.resolve(undefined);
    });
    const viewer = new ConversationViewer(
      ui,
      createStaticConversationSource([
        { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "first" } }] },
        { role: "toolResult", toolName: "read", content: [{ type: "text", text: Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\n") }] },
        { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "second" } }] },
        { role: "toolResult", toolName: "read", content: [{ type: "text", text: "second output" }] },
      ] as any),
      record(),
      undefined,
      theme,
      vi.fn(),
      undefined,
      undefined,
      undefined,
      { pi: {} as any, ctx: { ui: { custom } } as any, readOnly: true },
    );
    viewer.render(120);
    const timeline = (viewer as any).timeline;
    const ids = timeline.getSnapshot().interactiveToolIds;
    viewer.handleInput("]");
    expect(timeline.getFocusedToolCallId()).toBe(ids[0]);
    viewer.render(120);
    viewer.handleInput("w");
    expect(custom).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ overlay: true }));
    preview.handleInput("G");
    preview.handleInput("g");
    preview.handleInput("g");
    preview.handleInput("q");
    viewer.handleInput("]");
    expect(timeline.getFocusedToolCallId()).toBe(ids[1]);
    viewer.handleInput("[");
    expect(timeline.getFocusedToolCallId()).toBe(ids[0]);
  });

  it("recalls submitted steer drafts with Alt+Up and its a-up alias", () => {
    const ui = tui();
    const steer = vi.fn();
    const viewer = new ConversationViewer(
      ui,
      createStaticConversationSource([{ role: "assistant", content: "running" }] as any),
      record({ status: "running", session: {} }),
      undefined,
      theme,
      vi.fn(),
      undefined,
      undefined,
      steer,
      { pi: {} as any, ctx: {} as any, readOnly: false },
    );

    viewer.handleInput("e");
    for (const character of "check output") viewer.handleInput(character);
    viewer.handleInput("\r");
    expect(steer).toHaveBeenCalledWith("check output");

    viewer.handleInput("e");
    viewer.handleInput("\u001bp");
    expect((viewer as unknown as { composer?: { getValue(): string } }).composer?.getValue()).toBe("check output");
    viewer.handleInput("a-up");
    expect((viewer as unknown as { composer?: { getValue(): string } }).composer?.getValue()).toBe("check output");
  });

  it("keeps historical viewers read-only and closes on Escape", () => {
    const ui = tui();
    const steer = vi.fn();
    const stop = vi.fn();
    const done = vi.fn();
    const viewer = new ConversationViewer(
      ui,
      createStaticConversationSource([{ role: "assistant", content: "history" }] as any),
      record({ status: "running", session: {} }),
      undefined,
      theme,
      done,
      stop,
      undefined,
      steer,
      { pi: {} as any, ctx: {} as any, readOnly: true },
    );

    viewer.handleInput("\r");
    viewer.handleInput("x");
    viewer.handleInput("O");
    expect(steer).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    viewer.handleInput("\x1b");
    expect(done).toHaveBeenCalledTimes(1);
  });
});
