import { describe, expect, it } from "vitest";
import { formatConversationMessages } from "../../src/ui/conversation-blocks.js";

describe("formatConversationMessages", () => {
  it("keeps markdown source for user and assistant blocks", () => {
    const blocks = formatConversationMessages([
      { role: "user", content: "# Ask\n\nUse `x`." },
      { role: "assistant", content: [
        { type: "text", text: "## Answer\n\n```ts\nconst x: number = 1;\n```" },
      ] },
    ] as any);

    expect(blocks.filter((b) => b.kind === "text").map((b) => b.markdown)).toEqual([
      "# Ask\n\nUse `x`.",
      "## Answer\n\n```ts\nconst x: number = 1;\n```",
    ]);
  });

  it("separates assistant tool calls and bounds tool results", () => {
    const blocks = formatConversationMessages([
      { role: "assistant", content: [
        { type: "toolCall", name: "read", arguments: { path: "src/index.ts" } },
      ] },
      { role: "toolResult", toolName: "read", isError: false, content: [
        { type: "text", text: "a".repeat(100) },
      ] },
    ] as any, { maxToolResultChars: 40 });

    expect(blocks.some((b) => b.toolLine?.includes("read"))).toBe(true);
    const result = blocks.find((b) => b.role === "tool" && b.fullText.includes("read"));
    expect(result?.fullText.length).toBeLessThanOrEqual(40);
  });

  it("pairs tool results by id, then same-name source order, and preserves orphans", () => {
    const blocks = formatConversationMessages([
      { role: "assistant", content: [
        { type: "toolCall", id: "call-read", name: "read", arguments: { path: "a.ts" } },
        { type: "toolCall", id: "call-write", name: "write", arguments: { path: "b.ts", content: "new" } },
      ] },
      { role: "toolResult", toolCallId: "call-read", toolName: "read", isError: false, details: { source: "id" }, content: [{ type: "text", text: "read output" }] },
      { role: "toolResult", toolName: "write", isError: true, details: { source: "name" }, content: [{ type: "text", text: "write failed" }] },
      { role: "toolResult", toolCallId: "missing", toolName: "bash", isError: true, content: [{ type: "text", text: "orphan" }] },
    ] as any);

    const tools = blocks.filter((block) => block.kind === "tool");
    expect(tools).toHaveLength(3);
    expect(tools[0]?.toolCallId).toBe("call-read");
    expect(tools[0]?.toolResult?.details).toEqual({ source: "id" });
    expect(tools[1]?.toolCallId).toBe("call-write");
    expect(tools[1]?.toolResult?.isError).toBe(true);
    expect(tools[2]?.toolResult?.content).toEqual([{ type: "text", text: "orphan" }]);
    expect(tools[2]?.fullText).toContain("orphan");
  });

  it("uses a stable synthetic id when a tool call omits its id", () => {
    const blocks = formatConversationMessages([
      { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "a.ts" } }] },
      { role: "toolResult", toolName: "read", content: [{ type: "text", text: "ok" }] },
    ] as any);

    expect(blocks[0]?.toolCallId).toBe("message-0-tool-0");
    expect(blocks[0]?.toolResult?.content).toEqual([{ type: "text", text: "ok" }]);
  });

  it("normalizes CRLF and bounds text with a deterministic truncation marker", () => {
    const blocks = formatConversationMessages([
      { role: "user", content: "one\r\ntwo\rthree\nfour" },
    ] as any, { maxEntryChars: 12 });

    expect(blocks[0]?.markdown).toBe("\n… [truncate");
    expect(blocks[0]?.id).toBe("message-0");
    expect(blocks[0]?.fullText.length).toBeLessThanOrEqual(12);
  });

  it("formats bash, images, summaries, and deterministic tool ids", () => {
    const blocks = formatConversationMessages([
      { role: "assistant", content: [
        { type: "text", text: "answer" },
        { type: "toolCall", name: "read", arguments: { path: "a.ts" } },
        { type: "toolCall", name: "write", arguments: { path: "b.ts" } },
      ] },
      { role: "bashExecution", command: "echo hi", output: "hi" },
      { role: "custom", customType: "note", content: [{ type: "image" }] },
      { role: "compactionSummary", summary: "Earlier context" },
    ] as any);

    expect(blocks.map((block) => block.id)).toEqual([
      "message-0", "message-0-tool-0", "message-0-tool-1", "message-1", "message-2", "message-3",
    ]);
    expect(blocks[1]?.toolLine).toContain("· read → a.ts");
    expect(blocks[3]?.fullText).toContain("$ echo hi\nhi");
    expect(blocks[4]?.markdown).toBe("[image]");
    expect(blocks[5]?.role).toBe("meta");
  });

  it("skips unsupported or empty messages without throwing", () => {
    expect(formatConversationMessages([
      { role: "unknown", content: { not: "text" } },
      { role: "user", content: [{ type: "thinking", thinking: "hidden" }] },
      { role: "custom", display: false, content: "hidden" },
    ] as any)).toEqual([]);
  });
});
