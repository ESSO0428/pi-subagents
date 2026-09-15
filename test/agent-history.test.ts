import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentHistoryLocator, createAgentHistoryPath, readAgentHistoryResult } from "../src/agent-history.js";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("readAgentHistoryResult", () => {
  it("returns the last non-empty assistant text from a durable transcript", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-agent-history-result-"));
    tempDirectories.push(cwd);
    const path = createAgentHistoryPath(cwd, "agent-1");
    writeFileSync(path, [
      "not json",
      JSON.stringify({ message: { role: "user", content: "prompt" } }),
      JSON.stringify({ message: { role: "assistant", content: " first answer " } }),
      JSON.stringify({ message: { role: "toolResult", content: "ignored" } }),
      JSON.stringify({ message: { role: "assistant", content: [
        { type: "toolCall", name: "read" },
        { type: "text", text: " second answer " },
      ] } }),
    ].join("\n") + "\n");

    expect(readAgentHistoryResult(cwd, agentHistoryLocator(cwd, path))).toBe("second answer");
  });

  it("returns undefined when the transcript has no assistant text", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-agent-history-result-"));
    tempDirectories.push(cwd);
    const path = createAgentHistoryPath(cwd, "agent-2");
    writeFileSync(path, JSON.stringify({ message: { role: "user", content: "prompt" } }) + "\n");

    expect(readAgentHistoryResult(cwd, agentHistoryLocator(cwd, path))).toBeUndefined();
  });
});
