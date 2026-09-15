import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentHistoryLocator } from "../src/agent-history.js";
import extension from "../src/index.js";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("/agents history navigation", () => {
  it("returns to the Agents menu after closing a history viewer", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-subagents-menu-test-"));
    tempDirectories.push(cwd);
    const transcript = ".pi-subagents/agent-transcripts/agent-1.jsonl";
    mkdirSync(join(cwd, ".pi-subagents/agent-transcripts"), { recursive: true });
    writeFileSync(join(cwd, transcript), JSON.stringify({ message: { role: "user", content: "hello" } }) + "\n");

    const eventHandlers = new Map<string, Set<(...args: any[]) => any>>();
    const events = {
      on: (name: string, handler: (...args: any[]) => any) => {
        const handlersForEvent = eventHandlers.get(name) ?? new Set<(...args: any[]) => any>();
        handlersForEvent.add(handler);
        eventHandlers.set(name, handlersForEvent);
        return () => handlersForEvent.delete(handler);
      },
      emit: (name: string, ...args: any[]) => {
        for (const handler of eventHandlers.get(name) ?? []) handler(...args);
      },
    };
    const handlers = new Map<string, (...args: any[]) => any>();
    let command: { handler: (_args: unknown, ctx: any) => Promise<void> } | undefined;
    const pi: any = {
      events,
      registerMessageRenderer: () => {},
      registerTool: () => {},
      registerCommand: (_name: string, definition: typeof command) => { command = definition; },
      on: (name: string, handler: (...args: any[]) => any) => { handlers.set(name, handler); },
      appendEntry: () => {},
      sendMessage: () => {},
    };
    extension(pi);

    const titles: string[] = [];
    let historySelections = 0;
    const ui = {
      notify: () => {},
      setWidget: () => {},
      setStatus: () => {},
      onTerminalInput: () => () => {},
      select: async (title: string, options: string[]) => {
        titles.push(title);
        if (title === "Agents" && titles.filter(item => item === "Agents").length === 1) {
          return options.find(option => option.startsWith("Agent history ("));
        }
        if (title === "Agent history" && historySelections++ === 0) return options[0];
        return undefined;
      },
      custom: async () => undefined,
    };
    const ctx = {
      cwd,
      ui,
      sessionManager: {
        getSessionId: () => undefined,
        getBranch: () => [{
          type: "custom",
          customType: "subagents:record",
          data: {
            id: "agent-1", type: "Explore", description: "Inspect", status: "completed",
            startedAt: 1, completedAt: 2, transcriptPath: agentHistoryLocator(cwd, join(cwd, transcript)),
          },
        }],
      },
    };

    await handlers.get("session_start")?.({}, ctx);
    await command?.handler({}, ctx);
    await handlers.get("session_shutdown")?.();

    expect(titles).toEqual(["Agents", "Agent history", "Agents"]);
  });
});
