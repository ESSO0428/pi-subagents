/** Integration coverage for the SubagentWorkflow extension wiring. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { writeWorkflowHistorySnapshot } from "../src/workflow/history.js";
import type { WorkflowEntry } from "../src/workflow/progress.js";
import { createWorkflowTask, toWorkflowTreeRoot } from "../src/workflow/task.js";

const mocks = vi.hoisted(() => ({
  runWorkflow: vi.fn(),
  showWorkflowsMenu: vi.fn(),
}));

vi.mock("../src/workflow/runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../src/workflow/runtime.js")>("../src/workflow/runtime.js");
  return { ...actual, runWorkflow: mocks.runWorkflow };
});

vi.mock("../src/ui/workflow-menu.js", async () => {
  const actual = await vi.importActual<typeof import("../src/ui/workflow-menu.js")>("../src/ui/workflow-menu.js");
  return { ...actual, showWorkflowsMenu: mocks.showWorkflowsMenu };
});

import subagentsExtension from "../src/index.js";

function makePi() {
  const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
  const lifecycle = new Map<string, (...args: unknown[]) => unknown>();
  const commands = new Map<string, { handler: (...args: unknown[]) => Promise<void> }>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => tools.set(tool.name, tool)),
    registerCommand: vi.fn((name: string, command: { handler: (...args: unknown[]) => Promise<void> }) => commands.set(name, command)),
    on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => lifecycle.set(event, handler)),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    getAllTools: vi.fn(() => []),
    getActiveTools: vi.fn(() => ["SubagentWorkflow"]),
    setActiveTools: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  return { pi, tools, lifecycle, commands };
}

function makeContext(ui: Record<string, unknown>, cwd = process.cwd()) {
  return {
    mode: "tui",
    hasUI: true,
    ui,
    cwd,
    sessionManager: { getSessionId: () => "session-1", getBranch: () => [] },
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
  } as any;
}

function makeUi() {
  return {
    setStatus: vi.fn(),
    setWidget: vi.fn(),
    notify: vi.fn(),
    onTerminalInput: vi.fn(() => vi.fn()),
    getEditorText: vi.fn(() => ""),
    custom: vi.fn(async () => undefined),
    select: vi.fn(async () => undefined),
  };
}

const SCRIPT = 'export const meta = { name: "probe", description: "probe workflow" }; return "done";';
const flush = async () => {
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
};

describe("SubagentWorkflow index wiring", () => {
  beforeEach(() => {
    mocks.runWorkflow.mockReset();
    mocks.showWorkflowsMenu.mockReset();
  });

  it("returns a task id immediately and lists the run before agents start", async () => {
    mocks.runWorkflow.mockReturnValue(new Promise(() => {}));
    const { pi, tools, commands } = makePi();
    subagentsExtension(pi);
    const ui = makeUi();
    const ctx = makeContext(ui);

    const result = await tools.get("SubagentWorkflow")?.execute("call-1", { script: SCRIPT }, undefined, undefined, ctx);
    const details = (result as { details?: { taskId?: string } }).details;
    expect(details?.taskId).toMatch(/^wf_/);
    expect((result as { content: [{ text: string }] }).content[0].text).toContain(details?.taskId);

    await commands.get("agents")?.handler("", ctx);
    expect(ui.select).toHaveBeenCalledWith("Agents", expect.arrayContaining([
      "Agent conversations this session (0)",
      "Workflows (1)",
    ]));
  });

  it("restores terminal workflow history into the menu after a reload-shaped activation", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-workflow-index-history-"));
    try {
      for (const [index, status] of (["completed", "failed", "killed"] as const).entries()) {
        const task = createWorkflowTask({
          id: `wf_reload${index}`,
          script: "secret",
          artifactRootCwd: cwd,
          startTime: 10,
          meta: { name: `history-${status}`, description: `restored ${status}` },
        });
        task.status = status;
        task.endTime = 20 + index;
        writeWorkflowHistorySnapshot(task, cwd);
      }

      const { pi, tools, commands, lifecycle } = makePi();
      subagentsExtension(pi);
      const ui = makeUi();
      const ctx = makeContext(ui);
      ctx.cwd = cwd;
      await lifecycle.get("session_start")?.({}, ctx);
      ui.select.mockResolvedValueOnce("Workflows (3)");
      await commands.get("agents")?.handler("", ctx);

      expect(ui.select).toHaveBeenCalledWith("Agents", expect.arrayContaining([
        "Workflows (3)",
      ]));
      const deps = mocks.showWorkflowsMenu.mock.calls.at(-1)?.[1] as {
        history: ReadonlyMap<string, { status: string }>;
      };
      expect([...deps.history.values()].map(snapshot => snapshot.status).sort()).toEqual(["completed", "failed", "killed"]);
      expect(tools.get("SubagentWorkflow")).toBeDefined();
      await lifecycle.get("session_shutdown")?.({}, ctx);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("does not leak delayed A completion into B, then restores A history on return", async () => {
    const projectA = mkdtempSync(join(tmpdir(), "pi-workflow-switch-a-"));
    const projectB = mkdtempSync(join(tmpdir(), "pi-workflow-switch-b-"));
    let resolveA!: (result: unknown) => void;
    const delayedA = new Promise(resolve => { resolveA = resolve; });
    mocks.runWorkflow.mockReturnValueOnce(delayedA);
    const { pi, tools, commands, lifecycle } = makePi();
    subagentsExtension(pi);
    const uiA = makeUi();
    const uiB = makeUi();
    const contextA = makeContext(uiA, projectA);
    const contextB = makeContext(uiB, projectB);

    try {
      await lifecycle.get("session_start")?.({}, contextA);
      const started = await tools.get("SubagentWorkflow")?.execute(
        "switch-a",
        { script: 'export const meta = { name: "A workflow", description: "A secret details" }; return "A";' },
        undefined,
        undefined,
        contextA,
      );
      expect((started as { details?: { taskId?: string } }).details?.taskId).toMatch(/^wf_/);

      await lifecycle.get("session_before_switch")?.();
      await lifecycle.get("session_start")?.({}, contextB);
      resolveA({
        status: "killed",
        meta: { name: "A workflow", description: "A secret details" },
        progress: [],
        agentCount: 0,
        replayedCount: 0,
      });
      await flush();
      await lifecycle.get("turn_end")?.({ message: { role: "assistant", stopReason: "stop" } }, contextB);
      await flush();

      uiB.select.mockResolvedValue(undefined);
      await commands.get("agents")?.handler("", contextB);
      expect(JSON.stringify(uiB.setWidget.mock.calls)).not.toContain("A secret details");
      expect(JSON.stringify(uiB.select.mock.calls)).not.toContain("A secret details");
      expect(JSON.stringify(uiB.select.mock.calls)).not.toContain("A workflow");
      expect(JSON.stringify(pi.sendMessage.mock.calls)).not.toContain("A secret details");

      await lifecycle.get("session_before_switch")?.();
      const uiA2 = makeUi();
      const contextA2 = makeContext(uiA2, projectA);
      await lifecycle.get("session_start")?.({}, contextA2);
      uiA2.select.mockResolvedValue(undefined);
      await commands.get("agents")?.handler("", contextA2);
      expect(uiA2.select).toHaveBeenCalledWith("Agents", expect.arrayContaining(["Workflows (1)"]));
    } finally {
      await lifecycle.get("session_shutdown")?.({}, contextA);
      rmSync(projectA, { recursive: true, force: true });
      rmSync(projectB, { recursive: true, force: true });
    }
  });

  it("forwards progress batches to the live task", async () => {
    mocks.runWorkflow.mockReturnValue(new Promise(() => {}));
    const { pi, tools, commands } = makePi();
    subagentsExtension(pi);
    const ui = makeUi();
    const ctx = makeContext(ui);

    const result = await tools.get("SubagentWorkflow")?.execute("call-2", { script: SCRIPT }, undefined, undefined, ctx);
    const taskId = (result as { details: { taskId: string } }).details.taskId;
    ui.select.mockResolvedValueOnce("Workflows (1)");
    await commands.get("agents")?.handler("", ctx);
    const deps = mocks.showWorkflowsMenu.mock.calls[0]?.[1] as { tasks: ReadonlyMap<string, { workflowProgress: WorkflowEntry[] }> };
    const task = deps.tasks.get(taskId);
    const entry: WorkflowEntry = { type: "workflow_log", message: "started" };
    mocks.runWorkflow.mock.calls[0][0].onProgress([entry]);
    expect(task?.workflowProgress).toEqual([entry]);
  });

  it("settles a rejected run as failed instead of leaving it running", async () => {
    mocks.runWorkflow.mockRejectedValue(new Error("workflow exploded"));
    const { pi, tools, commands } = makePi();
    subagentsExtension(pi);
    const ui = makeUi();
    const ctx = makeContext(ui);

    const result = await tools.get("SubagentWorkflow")?.execute("call-3", { script: SCRIPT }, undefined, undefined, ctx);
    const taskId = (result as { details: { taskId: string } }).details.taskId;
    await flush();
    ui.select.mockResolvedValueOnce("Workflows (1)");
    await commands.get("agents")?.handler("", ctx);
    const deps = mocks.showWorkflowsMenu.mock.calls[0]?.[1] as { tasks: ReadonlyMap<string, { status: string; error?: string }> };
    expect(deps.tasks.get(taskId)).toMatchObject({ status: "failed", error: "workflow exploded" });
  });
});

/**
 * The roster row for a run is built from the live task, and it survives the run
 * only when `completedAt` makes it through that mapping. Losing it is invisible
 * until the run finishes and the row silently disappears.
 */
describe("workflow run roster mapping", () => {
  const base = {
    artifactRootCwd: process.cwd(),
    id: "wf_1",
    status: "running" as const,
    workflowName: "smoke",
    startTime: 1,
    doneCount: 0,
    agentCount: 1,
    totalTokens: 0,
  };

  it("carries the run's end time once it finishes", () => {
    const run = toWorkflowTreeRoot({ ...base, status: "completed", endTime: 99 } as never);

    expect(run.completedAt).toBe(99);
  });

  it("leaves a running run without an end time", () => {
    expect(toWorkflowTreeRoot(base as never).completedAt).toBeUndefined();
  });

  it("carries progress and identity the row renders", () => {
    const run = toWorkflowTreeRoot({
      ...base,
      status: "failed",
      endTime: 5,
      doneCount: 2,
      agentCount: 3,
      totalTokens: 42,
      meta: { name: "smoke", description: "Smoke run" },
    } as never);

    expect(run).toMatchObject({
      artifactRootCwd: process.cwd(),
      id: "wf_1",
      description: "Smoke run",
      status: "failed",
      completedAt: 5,
      doneCount: 2,
      agentCount: 3,
      tokens: 42,
    });
  });
});
