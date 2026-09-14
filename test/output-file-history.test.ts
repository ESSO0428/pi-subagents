import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { streamToOutputFile, writeInitialEntry } from "../src/output-file.js";

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
});
