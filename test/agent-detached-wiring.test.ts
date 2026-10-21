/** End-to-end wiring for top-level Agent blocking and detached modes. */
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

function ctx() {
  return {
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    cwd: process.cwd(),
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

const textOf = (result: any): string => result.content[0].text;

async function shutdown(lifecycle: Map<string, any>, context: ReturnType<typeof ctx>) {
  await lifecycle.get("session_shutdown")?.({}, context);
}

const completedRun = () => ({
  responseText: "done",
  session: { dispose: vi.fn() } as any,
  aborted: false,
  steered: false,
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Agent execution mode wiring", () => {
  it("blocks by default, returns the complete result inline, and sends no notification", async () => {
    vi.mocked(runAgent).mockResolvedValue(completedRun());

    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const context = ctx();
    const result = await tools.get("Agent").execute(
      "plain-call",
      { prompt: "go", description: "plain blocking", subagent_type: "general-purpose" },
      undefined,
      undefined,
      context,
    );

    expect(textOf(result)).toContain("done");
    expect(textOf(result)).not.toContain("Agent ID:");
    expect(result.details.status).toBe("completed");
    expect(pi.sendMessage).not.toHaveBeenCalled();
    await shutdown(lifecycle, context);
  });

  it("explicit false uses the same blocking inline path", async () => {
    vi.mocked(runAgent).mockResolvedValue(completedRun());

    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const context = ctx();
    const result = await tools.get("Agent").execute(
      "false-call",
      { prompt: "go", description: "explicit blocking", subagent_type: "general-purpose", run_in_background: false },
      undefined,
      undefined,
      context,
    );

    expect(textOf(result)).toContain("done");
    expect(textOf(result)).not.toContain("started in background");
    expect(pi.sendMessage).not.toHaveBeenCalled();
    await shutdown(lifecycle, context);
  });

  it("explicit true returns an ID immediately and keeps completion notification", async () => {
    let resolveRun: ((value: unknown) => void) | undefined;
    vi.mocked(runAgent).mockImplementation(() => new Promise(resolve => {
      resolveRun = resolve;
    }) as any);

    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const context = ctx();
    const execution = tools.get("Agent").execute(
      "detached-call",
      { prompt: "go", description: "plain detached", subagent_type: "general-purpose", run_in_background: true },
      undefined,
      undefined,
      context,
    );

    const result = await Promise.race([
      execution,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Agent call blocked")), 100)),
    ]);

    expect(textOf(result)).toContain("Agent ID:");
    expect(textOf(result)).toContain("started in background");

    resolveRun?.(completedRun());
    await execution;
    await new Promise(resolve => setTimeout(resolve, 350));
    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: "subagent-notification" }),
      { deliverAs: "followUp", triggerTurn: true },
    );
    await shutdown(lifecycle, context);
  });

  it("removes public wait-group parameters and registration", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const agent = tools.get("Agent");
    const properties = agent.parameters.properties;

    expect(properties.wait).toBeUndefined();
    expect(properties.wait_group).toBeUndefined();
    expect(properties.wait_group_done).toBeUndefined();
    expect(tools.has("subagent_wait_group")).toBe(false);
    await shutdown(lifecycle, ctx());
  });
});
