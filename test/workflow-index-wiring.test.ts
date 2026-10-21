/** Integration coverage for the SubagentWorkflow extension wiring. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowEntry } from "../src/workflow/progress.js";
import { toWorkflowTreeRoot } from "../src/workflow/task.js";

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

function makeContext(ui: Record<string, unknown>) {
  return {
    mode: "tui",
    hasUI: true,
    ui,
    cwd: process.cwd(),
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
