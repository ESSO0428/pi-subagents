import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readAgentHistory } from "../src/agent-history.js";
import { streamToOutputFile, writeInitialEntry } from "../src/output-file.js";
import { formatConversationMessages } from "../src/ui/conversation-blocks.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("streamToOutputFile durable message snapshots", () => {
  it("writes tool result details to both output and project history files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-subagents-output-test-"));
    tempDirs.push(dir);
    const outputPath = join(dir, "agent.output");
    const historyPath = join(dir, "history.jsonl");
    writeInitialEntry(outputPath, "agent-1", "run", dir);
    writeInitialEntry(historyPath, "agent-1", "run", dir);

    let listener: ((event: any) => void) | undefined;
    const session = {
      messages: [
        { role: "user", content: "run" },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "write",
          content: [{ type: "text", text: "Successfully wrote to file.txt" }],
          details: { diff: "+1 new", patch: "+new" },
        },
      ],
      subscribe(next: (event: any) => void) {
        listener = next;
        return () => { listener = undefined; };
      },
    } as any;

    const cleanup = streamToOutputFile(session, outputPath, "agent-1", dir, historyPath);
    listener?.({ type: "turn_end" });
    cleanup();

    for (const path of [outputPath, historyPath]) {
      const entries = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(entries).toHaveLength(2);
      expect(entries[1].message.details).toEqual({ diff: "+1 new", patch: "+new" });
    }
  });

  it("flushes a completed Write call and result before turn_end for reload history", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-subagents-output-test-"));
    tempDirs.push(dir);
    const locator = ".pi-subagents/agent-transcripts/agent-1.jsonl";
    const historyPath = join(dir, locator);
    await mkdir(dirname(historyPath), { recursive: true });
    writeInitialEntry(historyPath, "agent-1", "run", dir);

    let listener: ((event: any) => void) | undefined;
    const session = {
      messages: [{ role: "user", content: "run" }],
      subscribe(next: (event: any) => void) {
        listener = next;
        return () => { listener = undefined; };
      },
    } as any;
    const cleanup = streamToOutputFile(session, historyPath, "agent-1", dir);
    const call = {
      role: "assistant",
      content: [{
        type: "toolCall",
        id: "write-1",
        name: "write",
        arguments: { path: "file.ts", content: "const answer = 42;\n" },
      }],
    };
    session.messages.push(call);
    listener?.({ type: "message_end", message: call });

    const result = {
      role: "toolResult",
      toolCallId: "write-1",
      toolName: "write",
      content: [{ type: "text", text: "Successfully wrote to file.ts" }],
      details: { diff: "+const answer = 42;", patch: "+const answer = 42;" },
    };
    session.messages.push(result);
    listener?.({ type: "message_end", message: result });

    const reloaded = readAgentHistory(dir, locator);
    const write = formatConversationMessages(reloaded ?? []).find(block => block.kind === "tool" && block.toolName === "write");
    expect(write).toMatchObject({
      args: { content: "const answer = 42;\n" },
      result: { details: { diff: "+const answer = 42;", patch: "+const answer = 42;" } },
    });
    cleanup();
  });
});
