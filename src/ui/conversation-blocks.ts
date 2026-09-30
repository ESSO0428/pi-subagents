import type { AgentSession } from "@earendil-works/pi-coding-agent";

export type ConversationBlockKind = "text" | "tool" | "meta";
export type ConversationBlockRole = "user" | "assistant" | "tool" | "custom" | "meta";

/** The durable result snapshot attached to a normalized tool block. */
export interface ConversationToolResultSnapshot {
  toolCallId?: string;
  toolName?: string;
  content?: unknown;
  details?: unknown;
  isError?: boolean;
}

export interface ConversationBlock {
  id: string;
  kind: ConversationBlockKind;
  role: ConversationBlockRole;
  header: string;
  markdown: string;
  copyText: string;
  fullText: string;
  toolLine?: string;
  /** Stable call id, including a synthetic id when the provider omitted one. */
  toolCallId?: string;
  toolName?: string;
  /** Original tool arguments are retained for rich input rendering. */
  toolArguments?: unknown;
  /** Compatibility-facing short alias used by the timeline renderer. */
  args?: unknown;
  /** Result details/content are retained for rich output and durable diff rendering. */
  toolResult?: ConversationToolResultSnapshot;
  /** Compatibility-facing short alias used by the timeline renderer. */
  result?: ConversationToolResultSnapshot;
  toolStatus?: "pending" | "success" | "error";
}

export interface ConversationFormatOptions {
  maxEntryChars?: number;
  maxToolResultChars?: number;
}

const DEFAULT_MAX_CHARS = 16_000;
const TRUNCATION_NOTICE = "\n… [truncated in subagent viewer]";

type UnknownMessage = {
  role?: unknown;
  content?: unknown;
  summary?: unknown;
  command?: unknown;
  output?: unknown;
  toolName?: unknown;
  toolCallId?: unknown;
  id?: unknown;
  name?: unknown;
  details?: unknown;
  isError?: unknown;
  customType?: unknown;
  display?: unknown;
};

type UnknownToolCall = Record<string, unknown>;

function charLimit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

/** Normalize terminal/platform line endings, then keep the result bounded. */
function bound(value: string, limit: number): string {
  const text = value.replace(/\r\n?/g, "\n");
  if (text.length <= limit) return text;
  if (limit <= 0) return "";
  if (limit <= TRUNCATION_NOTICE.length) return TRUNCATION_NOTICE.slice(0, limit);
  return text.slice(0, limit - TRUNCATION_NOTICE.length) + TRUNCATION_NOTICE;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Extract displayable text without leaking provider-specific or unknown parts. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const item = part as Record<string, unknown>;
    if (item.type === "text" && typeof item.text === "string") {
      parts.push(item.text);
    } else if (item.type === "image") {
      parts.push("[image]");
    }
  }
  return parts.join("\n");
}

function firstNonEmptyLine(text: string): string {
  const line = text.split("\n").find((candidate) => candidate.trim().length > 0);
  if (!line) return "(no output)";
  return line.trim().replace(/\s+/g, " ");
}

function toolSummary(name: string, call: UnknownToolCall): string {
  const args = call.arguments && typeof call.arguments === "object"
    ? call.arguments as Record<string, unknown>
    : call.input && typeof call.input === "object"
      ? call.input as Record<string, unknown>
      : {};

  const path = asString(args.path) ?? asString(args.filePath) ?? asString(args.filename);
  if (["read", "edit", "write"].includes(name) && path) return path;
  if (asString(args.command)) return asString(args.command)!;
  if (path) return path;
  try {
    const encoded = JSON.stringify(args);
    return encoded === "{}" ? "" : encoded;
  } catch {
    return "";
  }
}

function blockId(messageIndex: number, emitted: number, toolIndex?: number): string {
  if (emitted === 0) return `message-${messageIndex}`;
  return `message-${messageIndex}-tool-${toolIndex ?? emitted}`;
}

function uniqueBlockId(preferred: string, used: Set<string>): string {
  if (!used.has(preferred)) {
    used.add(preferred);
    return preferred;
  }
  let suffix = 2;
  while (used.has(`${preferred}-${suffix}`)) suffix++;
  const id = `${preferred}-${suffix}`;
  used.add(id);
  return id;
}

function textBlock(
  id: string,
  role: "user" | "assistant",
  markdown: string,
): ConversationBlock {
  return {
    id,
    kind: "text",
    role,
    header: role === "user" ? "User" : "Assistant",
    markdown,
    copyText: markdown,
    fullText: markdown,
  };
}

function toolCallBlock(
  id: string,
  callId: string,
  name: string,
  call: UnknownToolCall,
  summary: string,
): ConversationBlock {
  const toolLine = `· ${name} → ${summary || "(no details)"}`;
  return {
    id,
    kind: "tool",
    role: "tool",
    header: name,
    markdown: "",
    copyText: toolLine,
    fullText: toolLine,
    toolLine,
    toolCallId: callId,
    toolName: name,
    toolArguments: call.arguments ?? call.input,
    args: call.arguments ?? call.input,
    toolStatus: "pending",
  };
}

function resultSnapshot(message: UnknownMessage): ConversationToolResultSnapshot {
  return {
    toolCallId: asString(message.toolCallId) ?? asString(message.id),
    toolName: asString(message.toolName) ?? asString(message.name),
    content: message.content,
    details: message.details,
    isError: message.isError === true,
  };
}

function applyToolResult(
  block: ConversationBlock,
  result: ConversationToolResultSnapshot,
  maxChars: number,
): void {
  const name = result.toolName ?? block.toolName ?? "tool";
  const normalized = contentText(result.content).replace(/\r\n?/g, "\n");
  const success = result.isError ? "✗" : "✓";
  const lineCount = normalized.length === 0 ? 0 : normalized.split("\n").length;
  const charCount = normalized.length;
  const summary = firstNonEmptyLine(normalized);
  block.toolResult = result;
  block.result = result;
  block.toolStatus = result.isError ? "error" : "success";
  block.toolName = name;
  block.header = name;
  block.copyText = bound(`${name} ${success}\n${normalized}`, maxChars);
  block.fullText = block.copyText;
  block.toolLine = `· ${name} ${success} ${summary} ${lineCount}L/${charCount}c`;
}

function orphanToolResultBlock(
  id: string,
  result: ConversationToolResultSnapshot,
  maxChars: number,
): ConversationBlock {
  const name = result.toolName ?? "tool";
  const output = contentText(result.content).replace(/\r\n?/g, "\n");
  const success = result.isError ? "✗" : "✓";
  const lineCount = output.length === 0 ? 0 : output.split("\n").length;
  const charCount = output.length;
  const summary = firstNonEmptyLine(output);
  const toolLine = `· ${name} ${success} ${summary} ${lineCount}L/${charCount}c`;
  const fullText = bound(`${name} ${success}\n${output}`, maxChars);
  return {
    id,
    kind: "tool",
    role: "tool",
    header: `${name} result`,
    markdown: "",
    copyText: fullText,
    fullText,
    toolLine,
    toolCallId: result.toolCallId,
    toolName: name,
    toolResult: result,
    result,
    toolStatus: result.isError ? "error" : "success",
  };
}

function bashBlock(
  id: string,
  message: UnknownMessage,
  maxChars: number,
): ConversationBlock {
  const command = asString(message.command) ?? "";
  const output = asString(message.output) ?? contentText(message.content);
  const body = command ? `$ ${command}${output ? `\n${output}` : ""}` : output;
  const toolLine = `· bash → ${command || "(no command)"}`;
  const fullText = bound(body, maxChars);
  return {
    id,
    kind: "tool",
    role: "tool",
    header: "bash",
    markdown: "",
    copyText: fullText,
    fullText,
    toolLine,
    toolName: "bash",
  };
}

function metaBlock(
  id: string,
  header: string,
  value: unknown,
  maxChars: number,
): ConversationBlock | undefined {
  const text = typeof value === "string" ? value : contentText(value);
  const markdown = bound(text, maxChars);
  if (!markdown.trim()) return undefined;
  return {
    id,
    kind: "meta",
    role: "meta",
    header,
    markdown,
    copyText: markdown,
    fullText: markdown,
  };
}

/**
 * Convert provider messages into stable, render-oriented blocks.
 *
 * Tool results are attached to the original call when possible. This keeps the
 * block in call/source order while preserving the complete result snapshot for
 * rich rendering. Results that cannot be matched remain visible as orphan cards.
 */
export function formatConversationMessages(
  messages: AgentSession["messages"],
  options?: ConversationFormatOptions,
): ConversationBlock[] {
  const maxEntryChars = charLimit(options?.maxEntryChars, DEFAULT_MAX_CHARS);
  const maxToolResultChars = charLimit(options?.maxToolResultChars, DEFAULT_MAX_CHARS);
  const blocks: ConversationBlock[] = [];
  const usedBlockIds = new Set<string>();
  const callsById = new Map<string, ConversationBlock>();
  const callsByName = new Map<string, { blocks: ConversationBlock[]; next: number }>();

  const registerCall = (name: string, block: ConversationBlock) => {
    callsById.set(block.toolCallId!, block);
    const nameKey = name.toLowerCase();
    const queue = callsByName.get(nameKey) ?? { blocks: [], next: 0 };
    queue.blocks.push(block);
    callsByName.set(nameKey, queue);
  };
  const unregisterCall = (block: ConversationBlock) => {
    // Calls remain in their name queue as tombstones. Advancing its cursor is
    // amortized O(1), unlike removing from the middle of a same-name array.
    if (block.toolCallId) callsById.delete(block.toolCallId);
  };
  const nextCallByName = (name: string): ConversationBlock | undefined => {
    const queue = callsByName.get(name.toLowerCase());
    if (!queue) return undefined;
    while (queue.next < queue.blocks.length && queue.blocks[queue.next]?.toolStatus !== "pending") queue.next++;
    return queue.blocks[queue.next];
  };

  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const message = messages[messageIndex] as unknown as UnknownMessage;
    const role = message?.role;
    let emitted = 0;

    if (role === "user") {
      const text = bound(contentText(message.content), maxEntryChars);
      if (text.trim()) {
        blocks.push(textBlock(uniqueBlockId(blockId(messageIndex, emitted), usedBlockIds), "user", text));
      }
      continue;
    }

    if (role === "assistant") {
      const parts = Array.isArray(message.content) ? message.content : [];
      const text = bound(contentText(parts), maxEntryChars);
      if (text.trim()) {
        blocks.push(textBlock(uniqueBlockId(blockId(messageIndex, emitted++), usedBlockIds), "assistant", text));
      }

      let toolIndex = 0;
      for (const part of parts) {
        if (!part || typeof part !== "object" || (part as any).type !== "toolCall") continue;
        const call = part as UnknownToolCall;
        const name = asString(call.name) ?? asString(call.toolName) ?? "unknown";
        const preferredId = asString(call.id) ?? asString(call.toolCallId)
          ?? `message-${messageIndex}-tool-${toolIndex}`;
        const callId = callsById.has(preferredId)
          ? uniqueBlockId(preferredId, new Set(callsById.keys()))
          : preferredId;
        const block = toolCallBlock(
          uniqueBlockId(blockId(messageIndex, emitted++, toolIndex), usedBlockIds),
          callId,
          name,
          call,
          toolSummary(name, call),
        );
        blocks.push(block);
        registerCall(name, block);
        toolIndex++;
      }
      continue;
    }

    if (role === "toolResult") {
      const result = resultSnapshot(message);
      const direct = result.toolCallId ? callsById.get(result.toolCallId) : undefined;
      let match = direct;
      if (!match && result.toolName) {
        match = nextCallByName(result.toolName);
      }
      if (match) {
        applyToolResult(match, result, maxToolResultChars);
        unregisterCall(match);
      } else {
        const preferred = blockId(messageIndex, emitted);
        blocks.push(orphanToolResultBlock(uniqueBlockId(preferred, usedBlockIds), result, maxToolResultChars));
      }
      continue;
    }

    if (role === "bashExecution") {
      blocks.push(bashBlock(uniqueBlockId(blockId(messageIndex, emitted), usedBlockIds), message, maxToolResultChars));
      continue;
    }

    if (role === "custom") {
      if (message.display === false) continue;
      const header = asString(message.customType) || "Custom";
      const block = metaBlock(uniqueBlockId(blockId(messageIndex, emitted), usedBlockIds), header, message.content, maxEntryChars);
      if (block) blocks.push({ ...block, role: "custom" });
      continue;
    }

    if (role === "compactionSummary" || role === "branchSummary" || role === "summary") {
      const header = role === "summary" ? "Summary" : role === "compactionSummary" ? "Compaction summary" : "Branch summary";
      const block = metaBlock(uniqueBlockId(blockId(messageIndex, emitted), usedBlockIds), header, message.summary, maxEntryChars);
      if (block) blocks.push(block);
    }
  }

  return blocks;
}
