/**
 * wait-queued.test.ts — get_subagent_result(wait:true) is compatibility-only.
 *
 * Completion is delivered by background notifications / wait groups. The result
 * tool must never block the parent agent while a child is running or queued.
 */
import { describe, expect, it, vi } from "vitest";

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
    registerTool: vi.fn((t: any) => tools.set(t.name, t)),
    registerCommand: vi.fn(),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: {
      emit: vi.fn(),
      on: vi.fn(() => vi.fn()),
    },
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

const textOf = (r: any): string => r.content[0].text;
const flush = async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
};

async function spawnBackground(tools: Map<string, any>): Promise<{ id: string; queued: boolean }> {
  const r = await tools.get("Agent").execute(
    "tc-spawn",
    { prompt: "go", description: "nonblocking-result test agent", subagent_type: "general-purpose", run_in_background: true },
    undefined,
    undefined,
    ctx(),
  );
  const id = /Agent ID: (\S+)/.exec(textOf(r))![1];
  return { id, queued: textOf(r).includes("queued in background") };
}

describe("get_subagent_result wait:true compatibility", () => {
  it("returns immediately for a running agent and preserves the completion notification", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);

    let resolveRun: (() => void) | undefined;
    vi.mocked(runAgent).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRun = () => resolve({
            responseText: "THE-RESULT-PAYLOAD",
            session: { dispose: vi.fn() } as any,
            aborted: false,
            steered: false,
          });
        }) as any,
    );

    const { id } = await spawnBackground(tools);
    const result = await tools
      .get("get_subagent_result")
      .execute("tc-nonblocking", { agent_id: id, wait: true }, undefined, undefined, ctx());

    expect(textOf(result)).toContain("Status: running");
    expect(textOf(result)).toContain("wait:true is deprecated and no longer blocks");

    resolveRun?.();
    await flush();
    await new Promise((r) => setTimeout(r, 350));
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);

    const completedResult = await tools
      .get("get_subagent_result")
      .execute("tc-completed", { agent_id: id }, undefined, undefined, ctx());
    expect(textOf(completedResult)).toContain("THE-RESULT-PAYLOAD");

    await lifecycle.get("session_shutdown")?.();
  });

  it("returns immediately for a queued agent", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);

    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}) as any);

    let queuedId: string | undefined;
    for (let i = 0; i < 10 && !queuedId; i++) {
      const { id, queued } = await spawnBackground(tools);
      if (queued) queuedId = id;
    }
    expect(queuedId, "expected to hit the concurrency limit within 10 spawns").toBeDefined();

    const result = await tools
      .get("get_subagent_result")
      .execute("tc-queued-nonblocking", { agent_id: queuedId, wait: true }, undefined, undefined, ctx());

    expect(textOf(result)).toContain("Status: queued");
    expect(textOf(result)).toContain("wait:true is deprecated and no longer blocks");

    await lifecycle.get("session_shutdown")?.();
  });
});
