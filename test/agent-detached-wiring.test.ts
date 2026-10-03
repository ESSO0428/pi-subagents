/** Agent tool always detaches and preserves wait-group validation. */
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

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Agent detached execution wiring", () => {
  it("returns an ID immediately for a plain call", async () => {
    let resolveRun: ((value: unknown) => void) | undefined;
    vi.mocked(runAgent).mockImplementation(() => new Promise(resolve => {
      resolveRun = resolve;
    }) as any);

    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const context = ctx();
    const execution = tools.get("Agent").execute(
      "plain-call",
      { prompt: "go", description: "plain detached", subagent_type: "general-purpose" },
      undefined,
      undefined,
      context,
    );

    let result: any;
    try {
      result = await Promise.race([
        execution,
        new Promise((_, reject) => setTimeout(() => reject(new Error("Agent call blocked")), 100)),
      ]);
    } finally {
      resolveRun?.({ responseText: "done", session: { dispose: vi.fn() }, aborted: false, steered: false });
      await execution;
      await shutdown(lifecycle, context);
    }

    expect(textOf(result)).toContain("Agent ID:");
    expect(textOf(result)).toContain("started in background");
  });

  it("accepts wait:true without run_in_background", async () => {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
    });

    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const context = ctx();
    const result = await tools.get("Agent").execute(
      "wait-call",
      { prompt: "go", description: "wait detached", subagent_type: "general-purpose", wait: true },
      undefined,
      undefined,
      context,
    );

    expect(textOf(result)).toContain("Agent ID:");
    expect(textOf(result)).not.toContain("requires run_in_background");
    await shutdown(lifecycle, context);
  });

  it.each([
    [{ wait_group: "group" }, "wait_group and wait_group_done require wait: true."],
    [{ wait_group_done: true }, "wait_group and wait_group_done require wait: true."],
    [{ wait: true, schedule: "+1h" }, "Cannot combine wait: true with schedule"],
    [{ wait: true, resume: "agent-id" }, "Cannot combine wait: true with resume"],
  ])("rejects invalid wait combination %#", async (params, expected) => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const context = ctx();
    const result = await tools.get("Agent").execute(
      "invalid-wait",
      { prompt: "go", description: "invalid wait", subagent_type: "general-purpose", ...params },
      undefined,
      undefined,
      context,
    );

    expect(textOf(result)).toContain(expected);
    expect(runAgent).not.toHaveBeenCalled();
    await shutdown(lifecycle, context);
  });
});
