import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agentHistoryLocator } from "../src/agent-history.js";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import extension from "../src/index.js";

const tempDirectories: string[] = [];

beforeAll(() => initTheme(undefined, false));

afterAll(() => initTheme(undefined, false));

afterEach(() => {
  vi.mocked(runAgent).mockReset();
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

type CustomComponent = {
  render?: (width: number) => string[];
  handleInput?: (data: string) => void;
};
type CustomFactory = (
  tui: unknown,
  theme: unknown,
  keybindings: unknown,
  done: (value?: unknown) => void,
) => CustomComponent;

type Harness = {
  command: { handler: (_args: unknown, ctx: any) => Promise<void> };
  handlers: Map<string, (...args: any[]) => any>;
  tools: Map<string, any>;
};

function selectedRow(component: CustomComponent): string {
  return component.render?.(240).find(line => line.includes("→")) ?? "";
}

function makeHarness(custom: (factory: CustomFactory, options?: unknown) => Promise<unknown>) {
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
  const tools = new Map<string, any>();
  let command: Harness["command"] | undefined;
  const pi: any = {
    events,
    registerMessageRenderer: () => {},
    registerTool: (tool: any) => { tools.set(tool.name, tool); },
    registerCommand: (_name: string, definition: Harness["command"]) => { command = definition; },
    on: (name: string, handler: (...args: any[]) => any) => { handlers.set(name, handler); },
    appendEntry: () => {},
    sendMessage: () => {},
  };
  extension(pi);

  let agentsMenuVisits = 0;
  const ui = {
    notify: () => {},
    setWidget: () => {},
    setStatus: () => {},
    onTerminalInput: () => () => {},
    select: async (title: string, options: string[]) => {
      if (title !== "Agents" || agentsMenuVisits++ > 0) return undefined;
      return options.find(option => option.startsWith("Agent history ("));
    },
    custom,
  };

  return {
    command: command!,
    handlers,
    tools,
    context: (cwd: string, branch: unknown[]) => ({
      cwd,
      ui,
      model: undefined,
      modelRegistry: { find: () => undefined, getAvailable: () => [] },
      sessionManager: {
        getSessionId: () => undefined,
        getBranch: () => branch,
      },
    }),
  };
}

function makeRecord(cwd: string, id: string, description: string, startedAt: number) {
  const transcript = `.pi-subagents/agent-transcripts/${id}.jsonl`;
  mkdirSync(join(cwd, ".pi-subagents", "agent-transcripts"), { recursive: true });
  writeFileSync(join(cwd, transcript), JSON.stringify({ message: { role: "user", content: description } }) + "\n");
  return {
    type: "custom",
    customType: "subagents:record",
    data: {
      id,
      type: "Explore",
      description,
      status: "completed",
      startedAt,
      completedAt: startedAt + 1,
      transcriptPath: agentHistoryLocator(cwd, join(cwd, transcript)),
    },
  };
}

describe("/agents history navigation", () => {
  it("returns to Agent history and restores the selected row", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-subagents-menu-test-"));
    tempDirectories.push(cwd);
    const first = makeRecord(cwd, "agent-1", "First history", 2);
    const second = makeRecord(cwd, "agent-2", "Second history", 1);
    const selectedRows: string[] = [];
    let customCalls = 0;

    const harness = makeHarness(async (factory) => {
      const call = customCalls++;
      if (call === 1) return undefined; // Close the read-only conversation viewer.
      if (call === 0 || call === 2) {
        return new Promise(resolve => {
          const component = factory({}, {}, {}, resolve);
          selectedRows.push(selectedRow(component));
          if (call === 0) {
            component.handleInput?.("\x1b[B");
            component.handleInput?.("\r");
          } else {
            component.handleInput?.("\x1b");
          }
        });
      }
      throw new Error(`unexpected custom call ${call}`);
    });
    const ctx = harness.context(cwd, [first, second]);

    await harness.handlers.get("session_start")?.({}, ctx);
    await harness.command.handler({}, ctx);
    await harness.handlers.get("session_shutdown")?.();

    expect(selectedRows).toHaveLength(2);
    expect(selectedRows[0]).toContain("First history");
    expect(selectedRows[1]).toContain("Second history");
  });

  it("keeps Running selection separate from History selection", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-subagents-menu-test-"));
    tempDirectories.push(cwd);
    const first = makeRecord(cwd, "agent-1", "First history", 2);
    const second = makeRecord(cwd, "agent-2", "Second history", 1);
    const selectedRows: string[] = [];
    let customCalls = 0;

    vi.mocked(runAgent).mockImplementation(async (_ctx: any, _type: any, _prompt: any, options: any) => {
      options.onSessionCreated?.({ messages: [], dispose: () => {} });
      return await new Promise<any>(() => {});
    });

    const harness = makeHarness(async (factory) => {
      const call = customCalls++;
      if (call === 1) return undefined; // Close the running conversation viewer.
      if (call === 0 || call === 2 || call === 3) {
        return new Promise(resolve => {
          const component = factory({}, {}, {}, resolve);
          selectedRows.push(selectedRow(component));
          if (call === 0) {
            component.handleInput?.("\x1b[B");
            component.handleInput?.("\r");
          } else {
            component.handleInput?.("\x1b");
          }
        });
      }
      throw new Error(`unexpected custom call ${call}`);
    });
    const ctx: any = harness.context(cwd, [first, second]);
    ctx.sessionManager.getSessionId = () => "test-session";
    let agentsMenuCalls = 0;
    ctx.ui.select = async (title: string, options: string[]) => {
      if (title !== "Agents") return undefined;
      agentsMenuCalls++;
      if (agentsMenuCalls === 1) return options.find(option => option.startsWith("Running agents ("));
      if (agentsMenuCalls === 2) return options.find(option => option.startsWith("Agent history ("));
      return undefined;
    };

    await harness.handlers.get("session_start")?.({}, ctx);
    await harness.tools.get("Agent").execute(
      "tool-1",
      { prompt: "one", description: "Live one", subagent_type: "general-purpose", run_in_background: true },
      undefined,
      undefined,
      ctx,
    );
    await harness.tools.get("Agent").execute(
      "tool-2",
      { prompt: "two", description: "Live two", subagent_type: "general-purpose", run_in_background: true },
      undefined,
      undefined,
      ctx,
    );
    await harness.command.handler({}, ctx);
    await harness.handlers.get("session_shutdown")?.();

    expect(selectedRows).toHaveLength(3);
    expect(selectedRows[0]).toContain("Live two");
    expect(selectedRows[1]).toContain("Live one");
    // Running selection does not become the initial History row.
    expect(selectedRows[2]).toContain("First history");
  });

  it("resets history selection on session start", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-subagents-menu-test-"));
    tempDirectories.push(cwd);
    const first = makeRecord(cwd, "agent-1", "First history", 2);
    const second = makeRecord(cwd, "agent-2", "Second history", 1);
    const selectedRows: string[] = [];
    let customCalls = 0;
    let agentsMenuCalls = 0;

    const harness = makeHarness(async (factory) => {
      const call = customCalls++;
      if (call === 0 || call === 2 || call === 3) {
        return new Promise(resolve => {
          const component = factory({}, {}, {}, resolve);
          selectedRows.push(selectedRow(component));
          if (call === 0) {
            component.handleInput?.("\x1b[B");
            component.handleInput?.("\r");
          } else {
            component.handleInput?.("\x1b");
          }
        });
      }
      if (call === 1) return undefined; // Close the history viewer.
      throw new Error(`unexpected custom call ${call}`);
    });
    const branch = [first, second];
    const ctx: any = harness.context(cwd, branch);
    ctx.ui.select = async (title: string, options: string[]) => {
      if (title !== "Agents") return undefined;
      // The first submenu selection is history. The second command also starts
      // in history; the list itself is what proves the state was reset.
      agentsMenuCalls++;
      return agentsMenuCalls % 2 === 1
        ? options.find(option => option.startsWith("Agent history ("))
        : undefined;
    };
    await harness.handlers.get("session_start")?.({}, ctx);
    await harness.command.handler({}, ctx);
    await harness.handlers.get("session_before_switch")?.();
    await harness.handlers.get("session_start")?.({}, ctx);
    await harness.command.handler({}, ctx);
    await harness.handlers.get("session_shutdown")?.();

    expect(selectedRows).toHaveLength(3);
    expect(selectedRows[0]).toContain("First history");
    expect(selectedRows[1]).toContain("Second history");
    // A new session starts at row zero instead of retaining the prior history row.
    expect(selectedRows[2]).toContain("First history");
  });
});
