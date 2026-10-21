/**
 * wait-queued.test.ts — get_subagent_result supports immediate checks and
 * cancellable blocking joins.
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
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

describe("get_subagent_result wait semantics", () => {
  it.each([undefined, false])("returns immediately without consuming a running result (wait=%s)", async (wait) => {
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
    const params = wait === undefined ? { agent_id: id } : { agent_id: id, wait };
    const result = await tools
      .get("get_subagent_result")
      .execute("tc-nonblocking", params, undefined, undefined, ctx());

    expect(textOf(result)).toContain("Status: running");
    expect(textOf(result)).not.toContain("THE-RESULT-PAYLOAD");

    resolveRun?.();
    await flush();
    await delay(250);
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);

    const completedResult = await tools
      .get("get_subagent_result")
      .execute("tc-completed", { agent_id: id }, undefined, undefined, ctx());
    expect(textOf(completedResult)).toContain("THE-RESULT-PAYLOAD");

    await lifecycle.get("session_shutdown")?.();
  });

  it("wait:true blocks until terminal and consumes the result", async () => {
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
    let settled = false;
    const resultPromise = tools
      .get("get_subagent_result")
      .execute("tc-blocking", { agent_id: id, wait: true }, undefined, undefined, ctx())
      .then((result: any) => {
        settled = true;
        return result;
      });

    await flush();
    expect(settled).toBe(false);

    resolveRun?.();
    const result = await resultPromise;
    expect(textOf(result)).toContain("Status: completed");
    expect(textOf(result)).toContain("THE-RESULT-PAYLOAD");

    await delay(250);
    expect(pi.sendMessage).not.toHaveBeenCalled();
    await lifecycle.get("session_shutdown")?.();
  });

  it("cancellation stops only the wait and preserves the child and notification", async () => {
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
    const controller = new AbortController();
    const resultPromise = tools
      .get("get_subagent_result")
      .execute("tc-cancel", { agent_id: id, wait: true }, controller.signal, undefined, ctx());

    await flush();
    controller.abort();
    await expect(resultPromise).rejects.toMatchObject({ name: "AbortError" });

    const status = await tools
      .get("get_subagent_result")
      .execute("tc-status", { agent_id: id, wait: false }, undefined, undefined, ctx());
    expect(textOf(status)).toContain("Status: running");

    resolveRun?.();
    await flush();
    await delay(250);
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);

    await lifecycle.get("session_shutdown")?.();
  });

  it("plain Agent calls bypass the concurrency queue", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);

    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}) as any);

    const results = [];
    for (let i = 0; i < 10; i++) results.push(await spawnBackground(tools));

    expect(results.every(({ queued }) => !queued)).toBe(true);
    await lifecycle.get("session_shutdown")?.();
  });
});
