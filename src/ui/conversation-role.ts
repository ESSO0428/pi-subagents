import type { Component } from "@earendil-works/pi-tui";
import type { ConversationBlock } from "./conversation-blocks.js";
import type { Theme } from "./agent-widget.js";

export type ConversationRoleTheme = Pick<Theme, "fg">;

/**
 * Render a semantic role label without coloring the whole message body.
 * These names intentionally mirror the labels used by peek-style viewers.
 */
export function conversationRoleLabel(block: ConversationBlock): string {
  if (block.kind === "tool") return (block.toolName || "TOOL").toUpperCase();
  if (block.role === "user") return "USER";
  if (block.role === "assistant") return "ASSISTANT";
  if (block.role === "custom") return block.header || "CUSTOM";
  return block.header || "META";
}

export function renderConversationRoleHeader(
  block: ConversationBlock,
  theme: ConversationRoleTheme,
): string {
  const label = conversationRoleLabel(block);
  const color = block.kind === "tool"
    ? "toolTitle"
    : block.role === "user"
      ? "userMessageText"
      : block.role === "assistant"
        ? "accent"
        : block.role === "custom"
          ? "customMessageLabel"
          : "muted";
  const detail = block.kind === "tool" && block.toolCallId
    ? theme.fg("dim", ` · ${block.toolCallId}`)
    : "";
  return `${theme.fg(color, label)}${detail}`;
}

/** Adapter useful to callers that need a Component-shaped role row. */
export function conversationRoleComponent(block: ConversationBlock, theme: ConversationRoleTheme): Component {
  return {
    render: () => [` ${renderConversationRoleHeader(block, theme)}`],
    invalidate() {},
  };
}
