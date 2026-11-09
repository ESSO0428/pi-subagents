import type * as CodingAgentModule from "@earendil-works/pi-coding-agent";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationViewer, createStaticConversationSource } from "../../src/ui/conversation-viewer.js";

const { copyToClipboardMock } = vi.hoisted(() => ({
  copyToClipboardMock: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const original = await importOriginal<typeof CodingAgentModule>();
  return { ...original, copyToClipboard: copyToClipboardMock };
});

const theme = {
  fg: (name: string, text: string) => name === "text" ? `<text>${text}</text>` : text,
  bold: (text: string) => `<bold>${text}</bold>`,
};

function tui() {
  return {
    terminal: { rows: 30 },
    requestRender: vi.fn(),
  } as any;
}

function mouse(type: TuiMouseEvent["type"], x: number): TuiMouseEvent {
  return {
    type,
    button: "left",
    x,
    y: 1,
    screenX: x,
    screenY: 1,
    width: 120,
    height: 30,
    shift: false,
    alt: false,
    ctrl: false,
  };
}

function openPreview(notify: ReturnType<typeof vi.fn>) {
  const output = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\n");
  const viewer = new ConversationViewer(
    tui(),
    createStaticConversationSource([
      { role: "assistant", content: [{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "first" } }] },
      { role: "toolResult", toolCallId: "tool-1", toolName: "read", content: [{ type: "text", text: output }] },
    ] as any),
    {
      id: "agent-1",
      type: "general-purpose",
      description: "test agent",
      status: "completed",
      toolUses: 0,
      startedAt: 0,
      lifetimeUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    } as any,
    undefined,
    theme,
    vi.fn(),
    undefined,
    undefined,
    undefined,
    { pi: {} as any, ctx: { ui: { notify } } as any, readOnly: true },
  );
  viewer.render(120);
  viewer.handleInput("]");
  viewer.handleInput("w");
  return { output, viewer };
}

describe("Full Tool Preview copy controls", () => {
  beforeEach(() => {
    copyToClipboardMock.mockReset();
    copyToClipboardMock.mockResolvedValue(undefined);
  });

  it("renders [copy] before [esc] and copies the complete output from click and M", async () => {
    const notify = vi.fn();
    const { output, viewer } = openPreview(notify);

    const initialHeader = viewer.render(120)[1]!;
    expect(initialHeader.indexOf("[copy]")).toBeLessThan(initialHeader.indexOf("[esc]"));

    const copyX = 109;
    viewer.handleMouse({ ...mouse("move", copyX), button: "none" });
    expect(viewer.render(120).join("\n")).toContain("<text>[copy]</text>");
    expect(viewer.handleMouse(mouse("press", copyX))).toMatchObject({ handled: true, capture: true });
    expect(viewer.handleMouse(mouse("release", copyX))).toMatchObject({ handled: true });
    expect(viewer.handleMouse(mouse("click", copyX))).toMatchObject({ handled: true });
    await Promise.resolve();

    viewer.handleInput("M");
    await Promise.resolve();

    expect(copyToClipboardMock).toHaveBeenCalledTimes(2);
    expect(copyToClipboardMock.mock.calls.map(([text]) => text)).toEqual([output, output]);
    expect(notify).toHaveBeenCalledWith(`Copied tool output (${output.length} chars)`, "info");
  });
});
