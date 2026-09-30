/**
 * agent-widget-wiring.test.ts — lifecycle wiring of the single Agents panel
 * through the real extension (src/index.ts).
 *
 * These tests prove the extension hands the live UI to AgentWidget, registers
 * only the above-editor `agents` widget, and clears it during shutdown.
 * runAgent is mocked (no LLM); manager, settings, completion routing, and
 * lifecycle handlers remain real.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";

function makePi() {
  const tools = new Map<string, any>();
  const lifecycle = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
    registerCommand: vi.fn(),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  return { pi, tools, lifecycle };
}

/** A UI context with the surfaces AgentWidget uses; setWidget is spied. */
function uiCtx() {
  return {
    setStatus: vi.fn(),
    setWidget: vi.fn(),
    notify: vi.fn(),
    onTerminalInput: vi.fn(() => vi.fn()),
    getEditorText: vi.fn(() => ""),
    custom: vi.fn(),
  };
}

function ctxWith(ui: ReturnType<typeof uiCtx>, branch: any[] = []) {
  return {
    mode: "tui",
    hasUI: true,
    ui,
    cwd: process.cwd(),
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: () => "s1", getBranch: () => branch },
    getSystemPrompt: () => "parent",
  } as any;
}

const flush = async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};

describe("Agents panel wiring (real extension lifecycle)", () => {
  let tmpDir: string;
  let agentDir: string;
  let prevCwd: string;
  let prevAgentDir: string | undefined;
  let prevHome: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-agents-widget-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-agents-widget-agentdir-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    prevHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = agentDir;
    prevCwd = process.cwd();
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    writeFileSync(join(tmpDir, ".pi", "subagents.json"), JSON.stringify({
      schedulingEnabled: false,
      defaultJoinMode: "async",
    }));
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(prevCwd);
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevHome == null) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("captures terminal input on tool_execution_start", async () => {
    const { pi, lifecycle } = makePi();
    subagentsExtension(pi);
    const ui = uiCtx();

    await lifecycle.get("tool_execution_start")?.({}, ctxWith(ui));

    expect(ui.onTerminalInput).toHaveBeenCalledTimes(1);
  });

  it("initializes the above-editor panel on session_start after restoring history", async () => {
    const transcriptPath = join(tmpDir, ".pi-subagents", "agent-transcripts", "restored.jsonl");
    mkdirSync(join(tmpDir, ".pi-subagents", "agent-transcripts"), { recursive: true });
    writeFileSync(transcriptPath, JSON.stringify({ message: { role: "user", content: "hello" } }) + "\n");

    const branch = [{
      type: "custom",
      customType: "subagents:record",
      data: {
        id: "restored-agent",
        type: "general-purpose",
        description: "Restored agent",
        status: "completed",
        startedAt: 1,
        completedAt: 2,
        transcriptPath: ".pi-subagents/agent-transcripts/restored.jsonl",
      },
    }];
    const { pi, lifecycle } = makePi();
    subagentsExtension(pi);
    const ui = uiCtx();

    await lifecycle.get("session_start")?.({}, ctxWith(ui, branch));

    expect(ui.onTerminalInput).toHaveBeenCalledTimes(1);
    expect(ui.setWidget).toHaveBeenCalledWith("agents", expect.any(Function), { placement: "aboveEditor" });
    const registration = ui.setWidget.mock.calls.find(
      (call) => call[0] === "agents" && typeof call[1] === "function",
    );
    const factory = registration?.[1] as ((tui: any, theme: any) => { render(): string[] }) | undefined;
    expect(factory).toBeDefined();
    const rendered = factory?.(
      { terminal: { columns: 120, rows: 24 } },
      { fg: (_c: string, s: string) => s, bold: (s: string) => s },
    ).render().join("\n");
    expect(rendered).toContain("Restored agent");

    await lifecycle.get("session_shutdown")?.({}, ctxWith(ui));
  });

  it("does not add a duplicate terminal input listener at startup and first tool execution", async () => {
    const { pi, lifecycle } = makePi();
    subagentsExtension(pi);
    const ui = uiCtx();
    const ctx = ctxWith(ui);

    await lifecycle.get("session_start")?.({}, ctx);
    await lifecycle.get("tool_execution_start")?.({}, ctx);

    expect(ui.onTerminalInput).toHaveBeenCalledTimes(1);

    await lifecycle.get("session_shutdown")?.({}, ctx);
  });

  it("does not register the Agents widget outside TUI mode", async () => {
    const { pi, lifecycle } = makePi();
    subagentsExtension(pi);
    const ui = uiCtx();
    const nonTuiCtx = { ...ctxWith(ui), mode: "print" };

    await lifecycle.get("session_start")?.({}, nonTuiCtx);

    expect(ui.onTerminalInput).not.toHaveBeenCalled();
    expect(ui.setWidget).not.toHaveBeenCalled();

    await lifecycle.get("session_shutdown")?.({}, nonTuiCtx);
  });

  it("registers only the above-editor agents widget and clears it on shutdown", async () => {
    const liveSession = {
      messages: [],
      subscribe: () => () => {},
      dispose: vi.fn(),
    } as any;
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
      options.onSessionCreated?.(liveSession);
      await new Promise(() => {});
      return { responseText: "done", session: liveSession, aborted: false, steered: false } as any;
    });

    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const ui = uiCtx();
    await lifecycle.get("tool_execution_start")?.({}, ctxWith(ui));

    await tools.get("Agent").execute(
      "tool-call",
      { prompt: "go", description: "live one", subagent_type: "general-purpose", run_in_background: true },
      undefined,
      undefined,
      ctxWith(ui),
    );
    await flush();

    const widgetRegistrations = ui.setWidget.mock.calls.filter(
      (call) => call[0] === "agents" && typeof call[1] === "function",
    );
    expect(widgetRegistrations.length, "agents widget should register with a render factory").toBeGreaterThan(0);
    expect(widgetRegistrations.every((call) => call[2]?.placement === "aboveEditor")).toBe(true);
    expect(ui.setWidget.mock.calls.some((call) => call[0] === "fleet")).toBe(false);

    await lifecycle.get("session_shutdown")?.({}, ctxWith(uiCtx()));
    expect(ui.setWidget).toHaveBeenCalledWith("agents", undefined);
  });
});
