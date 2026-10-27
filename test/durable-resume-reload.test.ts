import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canOpenAgentHistory, resolveAgentViewMode } from "../src/agent-history-list.js";
import { AgentManager } from "../src/agent-manager.js";
import type { AgentRecoveryCheckpoint } from "../src/agent-recovery.js";
import { agentRecoveryCheckpointPath, readAgentRecoveryCheckpoints, writeAgentRecoveryCheckpoint } from "../src/agent-recovery.js";
import { privateSessionDirectory, resolvePrivateSessionLocator } from "../src/agent-session-storage.js";
import { projectAgentTree } from "../src/agent-tree.js";
import subagentsExtension from "../src/index.js";
import type { AgentRecord } from "../src/types.js";
import { loadWorkflowHistorySnapshots, toWorkflowHistoryTreeRoot, writeWorkflowHistorySnapshot } from "../src/workflow/history.js";
import { createWorkflowHost } from "../src/workflow/host.js";
import { createWorkflowTask } from "../src/workflow/task.js";

const projects: string[] = [];
const hermeticDirs: string[] = [];

function makeProject(): string {
  const project = mkdtempSync(join(tmpdir(), "pi-durable-resume-reload-"));
  projects.push(project);
  mkdirSync(join(project, ".pi", "agents"), { recursive: true });
  writeFileSync(join(project, ".pi", "subagents.json"), JSON.stringify({ schedulingEnabled: false }));
  writeFileSync(join(project, ".pi", "agents", "parent-agent.md"), `---
name: parent-agent
description: parent agent for reload integration
extensions: false
skills: false
allowed_subagents: general-purpose
---
Delegate one nested child, then report its answer.
`);
  return project;
}

function makePi() {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const lifecycle = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
    registerCommand: vi.fn((name: string, command: any) => commands.set(name, command)),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
    exec: vi.fn(async () => ({ code: 1, stdout: "", stderr: "" })),
  } as any;
  return { pi, tools, commands, lifecycle };
}

function makeContext(project: string, model: any, modelRuntime: ModelRuntime, sessionId: string, mode: "print" | "tui" = "print") {
  return {
    mode,
    hasUI: false,
    ui: {
      setStatus: vi.fn(),
      setWidget: vi.fn(),
      notify: vi.fn(),
      onTerminalInput: vi.fn(() => vi.fn()),
      getEditorText: vi.fn(() => ""),
      select: vi.fn(),
      custom: vi.fn(),
    },
    cwd: project,
    model,
    modelRegistry: {
      runtime: modelRuntime,
      find: vi.fn((provider: string, modelId: string) =>
        provider === model.provider && modelId === model.id ? model : undefined),
      getAvailable: vi.fn(() => [model]),
      hasConfiguredAuth: vi.fn(() => true),
      getAll: vi.fn(() => [model]),
    },
    sessionManager: {
      getSessionId: vi.fn(() => sessionId),
      getBranch: vi.fn(() => []),
    },
    getSystemPrompt: vi.fn(() => "You are the parent test session."),
  } as any;
}

async function createActivation(project: string, sessionId: string, mode: "print" | "tui" = "print") {
  const previousCwd = process.cwd();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousHome = process.env.HOME;
  const hermetic = mkdtempSync(join(tmpdir(), "pi-durable-resume-home-"));
  hermeticDirs.push(hermetic);
  process.env.PI_CODING_AGENT_DIR = hermetic;
  process.env.HOME = hermetic;
  process.chdir(project);

  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
  const modelRuntime = await ModelRuntime.create({ refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  await modelRuntime.setRuntimeApiKey(faux.provider, "faux-key");
  modelRuntime.hasConfiguredAuth = () => true;
  const model = faux.getModel();
  const { pi, tools, commands, lifecycle } = makePi();
  const context = makeContext(project, model, modelRuntime, sessionId, mode);
  subagentsExtension(pi);
  await lifecycle.get("session_start")?.({}, context);

  return {
    faux,
    modelRuntime,
    tools,
    commands,
    lifecycle,
    context,
    async dispose() {
      try {
        await lifecycle.get("session_shutdown")?.({}, context);
      } finally {
        modelRuntime.unregisterProvider(faux.provider);
        process.chdir(previousCwd);
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
      }
    },
  };
}

function assistantText(text: string) {
  return fauxAssistantMessage([fauxText(text)], { stopReason: "stop" });
}

function nestedCall(args: Record<string, unknown>) {
  return fauxAssistantMessage([fauxToolCall("Agent", args)], { stopReason: "toolUse" });
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.find(content => content.type === "text")?.text ?? "";
}

function checkpointByOwnership(
  checkpoints: AgentRecoveryCheckpoint[],
  kind: "top-level" | "nested",
): Extract<AgentRecoveryCheckpoint, { version: 2 }> {
  const checkpoint = checkpoints.find(value => value.version === 2 && value.ownership.kind === kind);
  if (!checkpoint || checkpoint.version !== 2) throw new Error(`missing ${kind} checkpoint`);
  return checkpoint;
}

function writeDisplayOnlyCheckpoint(project: string, id: string, description: string, sessionId?: string): string {
  const transcriptPath = `.pi-subagents/agent-transcripts/${id}.jsonl`;
  mkdirSync(join(project, ".pi-subagents", "agent-transcripts"), { recursive: true });
  writeFileSync(
    join(project, transcriptPath),
    JSON.stringify({ message: { role: "user", content: description } }) + "\n",
  );
  const written = writeAgentRecoveryCheckpoint(project, {
    version: 1,
    id,
    type: "Explore",
    description,
    status: "completed",
    startedAt: 10,
    completedAt: 20,
    toolUses: 0,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    transcriptPath,
    ...(sessionId !== undefined ? { sessionId } : {}),
  });
  if (!written) throw new Error(`failed to write display-only checkpoint ${id}`);
  return transcriptPath;
}

function writeV2DisplayOnlyCheckpoint(project: string, id: string, description: string, rootSessionId?: string): void {
  const transcriptPath = `.pi-subagents/agent-transcripts/${id}.jsonl`;
  mkdirSync(join(project, ".pi-subagents", "agent-transcripts"), { recursive: true });
  writeFileSync(
    join(project, transcriptPath),
    JSON.stringify({ message: { role: "user", content: description } }) + "\n",
  );
  if (!writeAgentRecoveryCheckpoint(project, {
    version: 2,
    id,
    type: "Explore",
    description,
    status: "completed",
    startedAt: 10,
    completedAt: 20,
    toolUses: 0,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    transcriptPath,
    runtime: {
      depth: 1,
      maxSubagentDepth: 2,
      ...(rootSessionId !== undefined ? { rootSessionId } : {}),
    },
    session: {
      kind: "explicit",
      artifactRootCwd: project,
      resourceCwd: project,
      originalExecutionCwd: project,
    },
    ownership: { kind: "top-level" },
  })) throw new Error(`failed to write v2 checkpoint ${id}`);
}

afterEach(() => {
  for (const project of projects.splice(0)) rmSync(project, { recursive: true, force: true });
  for (const directory of hermeticDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("durable private resume across independent activations", () => {
  it("restored checkpoints join the current-session tree without changing resume authority", async () => {
    const project = makeProject();
    const first = await createActivation(project, "session-a");
    let topId = "";
    try {
      first.faux.setResponses([assistantText("initial private result")]);
      const initialResult = await first.tools.get("Agent").execute(
        "initial-private",
        {
          prompt: "initial private prompt",
          description: "reloadable private",
          subagent_type: "general-purpose",
        },
        undefined,
        undefined,
        first.context,
      );
      expect(textOf(initialResult)).toContain("initial private result");
      topId = checkpointByOwnership(readAgentRecoveryCheckpoints(project), "top-level").id;

      const displayId = "display-only-recovered";
      const displayTranscriptPath = ".pi-subagents/agent-transcripts/display-only-recovered.jsonl";
      writeFileSync(
        join(project, displayTranscriptPath),
        JSON.stringify({ message: { role: "user", content: "display-only history" } }) + "\n",
      );
      const displayCheckpointWritten = writeAgentRecoveryCheckpoint(project, {
        version: 1,
        id: displayId,
        type: "Explore",
        description: "display-only recovered",
        status: "completed",
        startedAt: 10,
        completedAt: 20,
        toolUses: 0,
        lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
        compactionCount: 0,
        transcriptPath: displayTranscriptPath,
      });
      expect(displayCheckpointWritten).toBe(true);
      expect(readAgentRecoveryCheckpoints(project).some(checkpoint => checkpoint.id === displayId)).toBe(true);
    } finally {
      await first.dispose();
    }

    const second = await createActivation(project, "session-a", "tui");
    try {
      const manager = (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagents:manager")] as {
        getRecord(id: string): AgentRecord | undefined;
      };
      const privateRecord = manager.getRecord(topId);
      const displayRecord = manager.getRecord("display-only-recovered");
      expect(privateRecord).toMatchObject({ id: topId, sessionId: "session-a", sessionState: { kind: "private" } });
      expect(displayRecord).toMatchObject({ id: "display-only-recovered", sessionId: undefined });

      const projection = projectAgentTree({
        agents: [privateRecord!, displayRecord!],
        sessionId: "session-a",
        canOpenTerminalAgent: record => canOpenAgentHistory(record, project),
      });
      expect(projection.rows.map(row => row.node.kind === "agent" ? row.node.record.id : row.node.root.id))
        .toEqual([topId]);
      expect(resolveAgentViewMode(privateRecord!, project)).toBe("history");
      expect(resolveAgentViewMode(displayRecord!, project)).toBe("history");

      const registration = second.context.ui.setWidget.mock.calls.find(
        (call: [string, unknown]) => call[0] === "agents" && typeof call[1] === "function",
      );
      const renderFactory = registration?.[1] as ((tui: unknown, theme: unknown) => { render(): string[] }) | undefined;
      expect(renderFactory).toBeDefined();
      const rendered = renderFactory?.(
        { terminal: { columns: 160, rows: 24 }, requestRender: vi.fn() },
        { fg: (_color: string, text: string) => text, bold: (text: string) => text },
      ).render().join("\\n");
      expect(rendered).toContain("reloadable private");
      expect(rendered).not.toContain("display-only recovered");

      second.faux.setResponses([assistantText("resumed private result")]);
      const resumed = await second.tools.get("Agent").execute(
        "resume-private",
        {
          resume: topId,
          prompt: "resume private prompt",
          description: "resume private",
          subagent_type: "general-purpose",
        },
        undefined,
        undefined,
        second.context,
      );
      expect(textOf(resumed)).toContain("resumed private result");

      const displayResume = await second.tools.get("Agent").execute(
        "resume-display-only",
        {
          resume: "display-only-recovered",
          prompt: "resume display-only prompt",
          description: "resume display-only",
          subagent_type: "general-purpose",
        },
        undefined,
        undefined,
        second.context,
      );
      expect(textOf(displayResume)).toContain("resume-ownership-denied");
      expect(manager.getRecord("display-only-recovered")?.status).toBe("completed");
    } finally {
      await second.dispose();
    }
  });

  it("keeps another session's checkpoints and workflow history out of the current tree", () => {
    const project = makeProject();
    writeV2DisplayOnlyCheckpoint(project, "v2-current", "v2 current", "session-new");
    writeV2DisplayOnlyCheckpoint(project, "v2-old", "v2 old", "session-old");
    writeV2DisplayOnlyCheckpoint(project, "v2-unknown", "v2 unknown");
    writeDisplayOnlyCheckpoint(project, "v1-current", "v1 current", "session-new");
    writeDisplayOnlyCheckpoint(project, "v1-old", "v1 old", "session-old");
    writeDisplayOnlyCheckpoint(project, "v1-unknown", "v1 unknown");

    for (const [id, rootSessionId] of [
      ["wf_current1", "session-new"],
      ["wf_old0001", "session-old"],
      ["wf_unknown1", undefined],
    ] as const) {
      const task = createWorkflowTask({
        id,
        script: "return null;",
        artifactRootCwd: project,
        ...(rootSessionId !== undefined ? { rootSessionId } : {}),
        startTime: 10,
      });
      task.status = "completed";
      task.endTime = 20;
      writeWorkflowHistorySnapshot(task, project);
    }

    const branchTranscript = ".pi-subagents/agent-transcripts/branch-current.jsonl";
    mkdirSync(join(project, ".pi-subagents", "agent-transcripts"), { recursive: true });
    writeFileSync(join(project, branchTranscript), JSON.stringify({ message: { role: "user", content: "branch current" } }) + "\n");

    const manager = new AgentManager();
    try {
      manager.restoreCompleted([{
        id: "branch-current",
        type: "Explore",
        description: "branch current",
        status: "completed",
        startedAt: 1,
        completedAt: 2,
        toolUses: 0,
        lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
        compactionCount: 0,
        transcriptPath: branchTranscript,
      }], "session-new");
      manager.restoreRecovered(project, "session-new");

      const roots = loadWorkflowHistorySnapshots(project).map(toWorkflowHistoryTreeRoot);
      const projection = projectAgentTree({
        agents: manager.listAgents(),
        workflowRoots: roots,
        sessionId: "session-new",
        canOpenTerminalAgent: record => canOpenAgentHistory(record, project),
      });
      expect(projection.rows.map(row => row.key)).toEqual([
        "workflow:wf_current1",
        "agent:v1-current",
        "agent:v2-current",
        "agent:branch-current",
      ]);
      expect(manager.getRecord("v2-old")?.sessionId).toBeUndefined();
      expect(manager.getRecord("v2-unknown")?.sessionId).toBeUndefined();
      expect(manager.getRecord("v1-old")?.sessionId).toBe("session-old");
      expect(manager.getRecord("v1-unknown")?.sessionId).toBeUndefined();
      expect(loadWorkflowHistorySnapshots(project)).toHaveLength(3);
    } finally {
      manager.dispose();
    }
  });

  it("opens restored private and display-only records through the /agents current-session menu", async () => {
    const project = makeProject();
    const first = await createActivation(project, "session-a");
    let privateId = "";
    try {
      first.faux.setResponses([assistantText("initial private result")]);
      await first.tools.get("Agent").execute(
        "initial-private-menu",
        {
          prompt: "initial private prompt",
          description: "menu reloadable private",
          subagent_type: "general-purpose",
        },
        undefined,
        undefined,
        first.context,
      );
      privateId = checkpointByOwnership(readAgentRecoveryCheckpoints(project), "top-level").id;
      writeDisplayOnlyCheckpoint(project, "menu-display-only", "menu display-only recovered", "session-a");
    } finally {
      await first.dispose();
    }

    const second = await createActivation(project, "session-a", "tui");
    try {
      let selectCalls = 0;
      second.context.ui.select.mockImplementation(async (_title: string, options: string[]) => {
        if (selectCalls++ === 0) return options.find(option => option.startsWith("Agent conversations this session ("));
        return undefined;
      });
      const treeRenders: string[] = [];
      const opened: Array<{ id: string; mode: string }> = [];
      let customCalls = 0;
      second.context.ui.custom.mockImplementation(async (factory: any) => {
        const call = customCalls++;
        if (call === 1 || call === 3) return undefined;
        if (call !== 0 && call !== 2 && call !== 4) throw new Error(`unexpected /agents custom call ${call}`);

        return new Promise(resolve => {
          const done = (value: any) => {
            if (value?.kind === "agent") opened.push({ id: value.id, mode: value.mode });
            resolve(value);
          };
          const component = factory(
            { requestRender: vi.fn() },
            { fg: (_color: string, text: string) => text, bold: (text: string) => text },
            {},
            done,
          );
          treeRenders.push(component.render(240).join(String.fromCharCode(10)));
          if (call === 0) component.handleInput(String.fromCharCode(13));
          else if (call === 2) {
            component.handleInput(String.fromCharCode(27) + "[B");
            component.handleInput(String.fromCharCode(13));
          } else {
            component.handleInput(String.fromCharCode(27));
          }
        });
      });

      await second.commands.get("agents").handler({}, second.context);

      expect(opened).toEqual([
        { id: privateId, mode: "history" },
        { id: "menu-display-only", mode: "history" },
      ]);
      expect(treeRenders[0]).toContain("menu reloadable private");
      expect(treeRenders[0]).toContain("menu display-only recovered");
      expect(treeRenders[1]).toContain("menu reloadable private");
      expect(treeRenders[1]).toContain("menu display-only recovered");
    } finally {
      await second.dispose();
    }
  });

  it("shows a private checkpoint without display transcript and keeps its action truthful", async () => {
    const project = makeProject();
    const first = await createActivation(project, "session-a");
    let privateCheckpoint: Extract<AgentRecoveryCheckpoint, { version: 2 }> | undefined;
    try {
      first.faux.setResponses([assistantText("initial no-transcript result")]);
      await first.tools.get("Agent").execute(
        "initial-no-transcript",
        {
          prompt: "initial private prompt",
          description: "private without display transcript",
          subagent_type: "general-purpose",
        },
        undefined,
        undefined,
        first.context,
      );
      privateCheckpoint = checkpointByOwnership(readAgentRecoveryCheckpoints(project), "top-level");
    } finally {
      await first.dispose();
    }
    if (privateCheckpoint?.transcriptPath) {
      rmSync(join(project, privateCheckpoint.transcriptPath), { force: true });
    }

    const second = await createActivation(project, "session-a", "tui");
    try {
      const manager = (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagents:manager")] as {
        getRecord(id: string): AgentRecord | undefined;
      };
      const restored = manager.getRecord(privateCheckpoint!.id)!;
      expect(restored.sessionId).toBe("session-a");
      expect(canOpenAgentHistory(restored, project)).toBe(false);
      expect(resolveAgentViewMode(restored, project)).toBe("unavailable");

      const registration = second.context.ui.setWidget.mock.calls.find(
        (call: [string, unknown]) => call[0] === "agents" && typeof call[1] === "function",
      );
      const renderFactory = registration?.[1] as ((tui: unknown, theme: unknown) => { render(): string[] }) | undefined;
      const rendered = renderFactory?.(
        { terminal: { columns: 160, rows: 24 }, requestRender: vi.fn() },
        { fg: (_color: string, text: string) => text, bold: (text: string) => text },
      ).render().join(String.fromCharCode(10)) ?? "";
      expect(rendered).toContain("private without display transcript");

      let selectCalls = 0;
      second.context.ui.select.mockImplementation(async (_title: string, options: string[]) => {
        if (selectCalls++ === 0) return options.find(option => option.startsWith("Agent conversations this session ("));
        return undefined;
      });
      const menuRenders: string[] = [];
      let customCalls = 0;
      second.context.ui.custom.mockImplementation(async (factory: any) => {
        const call = customCalls++;
        if (call !== 0 && call !== 1) throw new Error(`unexpected private-no-transcript custom call ${call}`);
        return new Promise(resolve => {
          const done = (value: any) => resolve(value);
          const component = factory(
            { requestRender: vi.fn() },
            { fg: (_color: string, text: string) => text, bold: (text: string) => text },
            {},
            done,
          );
          menuRenders.push(component.render(240).join(String.fromCharCode(10)));
          component.handleInput(call === 0 ? String.fromCharCode(13) : String.fromCharCode(27));
        });
      });

      await second.commands.get("agents").handler({}, second.context);

      expect(menuRenders[0]).toContain("private without display transcript");
      expect(second.context.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("No display transcript is available"),
        "info",
      );

      second.faux.setResponses([assistantText("resumed without display transcript")]);
      const resumed = await second.tools.get("Agent").execute(
        "resume-no-transcript",
        {
          resume: privateCheckpoint!.id,
          prompt: "resume private prompt",
          description: "resume private",
          subagent_type: "general-purpose",
        },
        undefined,
        undefined,
        second.context,
      );
      expect(textOf(resumed)).toContain("resumed without display transcript");
    } finally {
      await second.dispose();
    }
  });

  it("keeps v1 and v2 checkpoint bytes unchanged across reload restore and shutdown", async () => {
    const project = makeProject();
    const first = await createActivation(project, "session-a");
    let privateId = "";
    try {
      first.faux.setResponses([assistantText("checkpoint baseline")]);
      await first.tools.get("Agent").execute(
        "checkpoint-baseline",
        {
          prompt: "checkpoint baseline prompt",
          description: "checkpoint baseline private",
          subagent_type: "general-purpose",
        },
        undefined,
        undefined,
        first.context,
      );
      privateId = checkpointByOwnership(readAgentRecoveryCheckpoints(project), "top-level").id;
      writeDisplayOnlyCheckpoint(project, "checkpoint-display-only", "checkpoint display-only");
    } finally {
      await first.dispose();
    }

    const checkpointPaths = [
      agentRecoveryCheckpointPath(project, privateId),
      agentRecoveryCheckpointPath(project, "checkpoint-display-only"),
    ];
    const before = checkpointPaths.map(path => readFileSync(path, "utf8"));

    const second = await createActivation(project, "session-a");
    try {
      const manager = (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagents:manager")] as {
        getRecord(id: string): AgentRecord | undefined;
      };
      expect(manager.getRecord(privateId)?.sessionId).toBe("session-a");
      expect(manager.getRecord("checkpoint-display-only")?.sessionId).toBeUndefined();
    } finally {
      await second.dispose();
    }

    expect(checkpointPaths.map(path => readFileSync(path, "utf8"))).toEqual(before);
  });

  it("reopens top-level and nested private sessions through the production resume chain", async () => {
    const project = makeProject();
    const first = await createActivation(project, "session-a");
    try {
      first.faux.setResponses([
        nestedCall({
          prompt: "initial nested prompt",
          description: "initial nested child",
          subagent_type: "general-purpose",
        }),
        assistantText("nested initial result"),
        assistantText("top-level initial result"),
      ]);

      const initialResult = await first.tools.get("Agent").execute(
        "initial-top-level",
        {
          prompt: "initial top-level prompt",
          description: "reloadable top-level",
          subagent_type: "parent-agent",
        },
        undefined,
        undefined,
        first.context,
      );
      expect(textOf(initialResult)).toContain("top-level initial result");

      const initialCheckpoints = readAgentRecoveryCheckpoints(project);
      expect(initialCheckpoints).toHaveLength(2);
      const initialTop = checkpointByOwnership(initialCheckpoints, "top-level");
      const initialNested = checkpointByOwnership(initialCheckpoints, "nested");
      for (const checkpoint of [initialTop, initialNested]) {
        expect(checkpoint.session.kind).toBe("private");
        expect(existsSync(agentRecoveryCheckpointPath(project, checkpoint.id))).toBe(true);
        if (checkpoint.session.kind !== "private") throw new Error("private checkpoint missing");
        const resolved = resolvePrivateSessionLocator(project, checkpoint.session.locator);
        expect(resolved.file).toBe(join(privateSessionDirectory(project), checkpoint.session.locator.split("/").at(-1)!));
        expect(existsSync(resolved.file)).toBe(true);
      }

      const transcriptPaths = initialCheckpoints
        .filter(checkpoint => checkpoint.version === 2 && checkpoint.transcriptPath)
        .map(checkpoint => checkpoint.transcriptPath!);
      await first.dispose();
      for (const transcriptPath of transcriptPaths) rmSync(join(project, transcriptPath), { force: true });
      expect(existsSync(join(project, ".pi-subagents", "agent-transcripts"))).toBe(true);
    } catch (error) {
      await first.dispose();
      throw error;
    }

    const second = await createActivation(project, "session-b");
    const open = vi.spyOn(SessionManager, "open");
    try {
      const manager = (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagents:manager")] as {
        getRecord(id: string): { status: string; session?: unknown; sessionState?: unknown } | undefined;
      };
      const restoredTop = manager.getRecord(checkpointByOwnership(readAgentRecoveryCheckpoints(project), "top-level").id);
      const restoredNested = manager.getRecord(checkpointByOwnership(readAgentRecoveryCheckpoints(project), "nested").id);
      expect(restoredTop?.status).toBe("completed");
      expect(restoredNested?.status).toBe("completed");
      expect(restoredTop?.session).toBeUndefined();
      expect(restoredNested?.session).toBeUndefined();
      expect(restoredTop?.sessionState).toMatchObject({ kind: "private" });
      expect(restoredNested?.sessionState).toMatchObject({ kind: "private" });

      const nestedId = checkpointByOwnership(readAgentRecoveryCheckpoints(project), "nested").id;
      const topId = checkpointByOwnership(readAgentRecoveryCheckpoints(project), "top-level").id;
      second.faux.setResponses([
        nestedCall({
          resume: nestedId,
          prompt: "resume nested prompt",
          description: "resume nested child",
          subagent_type: "general-purpose",
        }),
        assistantText("nested resumed result"),
        assistantText("top-level resumed result"),
      ]);

      const resumedResult = await second.tools.get("Agent").execute(
        "resume-top-level",
        {
          resume: topId,
          prompt: "resume top-level prompt",
          description: "resume top-level",
          subagent_type: "parent-agent",
        },
        undefined,
        undefined,
        second.context,
      );
      expect(textOf(resumedResult)).toContain("top-level resumed result");
      expect(open).toHaveBeenCalledTimes(2);
      expect(open.mock.calls.every(([file]) => String(file).includes(".pi-subagents/agent-sessions/"))).toBe(true);

      expect(manager.getRecord(topId)).toMatchObject({ status: "completed", result: expect.stringContaining("top-level resumed result") });
      expect(manager.getRecord(nestedId)).toMatchObject({ status: "completed", result: expect.stringContaining("nested resumed result") });
    } finally {
      await second.dispose();
    }
  });

  it("filters retained unread records at the project boundary and restores them when returning", async () => {
    const projectA = makeProject();
    const projectB = makeProject();
    const previousCwd = process.cwd();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousHome = process.env.HOME;
    const hermetic = mkdtempSync(join(tmpdir(), "pi-durable-resume-shared-home-"));
    hermeticDirs.push(hermetic);
    process.env.PI_CODING_AGENT_DIR = hermetic;
    process.env.HOME = hermetic;
    process.chdir(projectA);

    const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
    const modelRuntime = await ModelRuntime.create({ refreshOnCreate: false });
    modelRuntime.registerNativeProvider(faux.provider);
    await modelRuntime.setRuntimeApiKey(faux.provider, "faux-key");
    modelRuntime.hasConfiguredAuth = () => true;
    const model = faux.getModel();
    const { pi, tools, commands, lifecycle } = makePi();
    subagentsExtension(pi);
    const contextA = makeContext(projectA, model, modelRuntime, "session-a", "tui");
    const contextB = makeContext(projectB, model, modelRuntime, "session-b", "tui");

    try {
      await lifecycle.get("session_start")?.({}, contextA);
      faux.setResponses([assistantText("unread project A result")]);
      const created = await tools.get("Agent").execute(
        "project-a-unread",
        {
          prompt: "project A prompt",
          description: "unread project A record",
          subagent_type: "general-purpose",
          run_in_background: true,
        },
        undefined,
        undefined,
        contextA,
      );
      const projectAId = textOf(created)
        .split(String.fromCharCode(10))
        .find(line => line.startsWith("Agent ID: "))
        ?.slice("Agent ID: ".length)
        .trim();
      expect(projectAId).toBeTruthy();
      const registry = (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagents:manager")] as {
        getRecord(id: string): AgentRecord | undefined;
      };
      const retained = registry.getRecord(projectAId!);
      expect(retained).toBeDefined();
      await retained?.promise;
      expect(retained?.status).toBe("completed");
      expect(retained?.resultConsumed).toBeFalsy();
      expect(retained?.session).toBeDefined();

      await lifecycle.get("session_before_switch")?.();
      process.chdir(projectB);
      await lifecycle.get("session_start")?.({}, contextB);

      const bOptions: string[][] = [];
      contextB.ui.select.mockImplementation(async (_title: string, options: string[]) => {
        bOptions.push(options);
        return undefined;
      });
      await commands.get("agents").handler({}, contextB);
      expect(bOptions[0]).toBeDefined();
      expect(bOptions[0].some(option => option.startsWith("Agent conversations this session ("))).toBe(false);
      expect(bOptions[0].some(option => option.startsWith("Agent history all sessions ("))).toBe(false);
      expect(contextB.ui.setWidget.mock.calls.some(
        (call: [string, unknown]) => call[0] === "agents" && typeof call[1] === "function",
      )).toBe(false);

      const getResult = tools.get("get_subagent_result");
      const crossProjectNormal = await getResult.execute(
        "cross-project-result",
        { agent_id: projectAId },
        undefined,
        undefined,
        contextB,
      );
      const crossProjectVerbose = await getResult.execute(
        "cross-project-result-verbose",
        { agent_id: projectAId, verbose: true },
        undefined,
        undefined,
        contextB,
      );
      for (const response of [crossProjectNormal, crossProjectVerbose]) {
        const output = textOf(response);
        expect(output).toContain(`Agent not found: "${projectAId}"`);
        expect(output).not.toContain("Status:");
        expect(output).not.toContain("unread project A result");
        expect(output).not.toContain("--- Agent Conversation ---");
      }
      expect(retained?.resultConsumed).toBeFalsy();

      const crossProjectResume = await tools.get("Agent").execute(
        "cross-project-retained-resume",
        {
          resume: projectAId,
          prompt: "must not resume from project B",
          description: "cross-project resume",
          subagent_type: "general-purpose",
        },
        undefined,
        undefined,
        contextB,
      );
      expect(textOf(crossProjectResume)).toContain("resume-ownership-denied");

      await lifecycle.get("session_before_switch")?.();
      process.chdir(projectA);
      const contextBackA = makeContext(projectA, model, modelRuntime, "session-a", "tui");
      await lifecycle.get("session_start")?.({}, contextBackA);
      const returned = registry.getRecord(projectAId!);
      expect(returned).toBe(retained);
      expect(canOpenAgentHistory(returned!, projectA)).toBe(true);
      const aOptions: string[][] = [];
      contextBackA.ui.select.mockImplementation(async (_title: string, options: string[]) => {
        aOptions.push(options);
        return undefined;
      });
      await commands.get("agents").handler({}, contextBackA);
      expect(aOptions[0]).toContain("Agent conversations this session (1)");
      expect(aOptions[0]).toContain("Agent history all sessions (1)");

      const projectANormal = await getResult.execute(
        "project-a-result",
        { agent_id: projectAId },
        undefined,
        undefined,
        contextBackA,
      );
      expect(textOf(projectANormal)).toContain("unread project A result");
      expect(returned?.resultConsumed).toBe(true);

      const projectAVerbose = await getResult.execute(
        "project-a-result-verbose",
        { agent_id: projectAId, verbose: true },
        undefined,
        undefined,
        contextBackA,
      );
      expect(textOf(projectAVerbose)).toContain("unread project A result");
      expect(textOf(projectAVerbose)).toContain("--- Agent Conversation ---");
    } finally {
      await lifecycle.get("session_shutdown")?.({}, contextA);
      modelRuntime.unregisterProvider(faux.provider);
      process.chdir(previousCwd);
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  it("keeps reload restore and current UI scoped to the active project root", async () => {
    const projectA = makeProject();
    const projectB = makeProject();
    const first = await createActivation(projectA, "session-a");
    let projectAId = "";
    try {
      first.faux.setResponses([assistantText("project A private result")]);
      await first.tools.get("Agent").execute(
        "project-a-private",
        {
          prompt: "project A private prompt",
          description: "project A private",
          subagent_type: "general-purpose",
        },
        undefined,
        undefined,
        first.context,
      );
      projectAId = checkpointByOwnership(readAgentRecoveryCheckpoints(projectA), "top-level").id;
      writeDisplayOnlyCheckpoint(projectA, "project-a-display", "project A display-only");
    } finally {
      await first.dispose();
    }
    writeDisplayOnlyCheckpoint(projectB, "project-b-display", "project B display-only", "session-b");

    const second = await createActivation(projectB, "session-b", "tui");
    try {
      const manager = (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagents:manager")] as {
        getRecord(id: string): AgentRecord | undefined;
      };
      expect(manager.getRecord(projectAId)).toBeUndefined();
      expect(manager.getRecord("project-a-display")).toBeUndefined();
      expect(manager.getRecord("project-b-display")).toMatchObject({ sessionId: "session-b" });

      const registration = second.context.ui.setWidget.mock.calls.find(
        (call: [string, unknown]) => call[0] === "agents" && typeof call[1] === "function",
      );
      const renderFactory = registration?.[1] as ((tui: unknown, theme: unknown) => { render(): string[] }) | undefined;
      const rendered = renderFactory?.(
        { terminal: { columns: 160, rows: 24 }, requestRender: vi.fn() },
        { fg: (_color: string, text: string) => text, bold: (text: string) => text },
      ).render().join("\\n") ?? "";
      expect(rendered).toContain("project B display-only");
      expect(rendered).not.toContain("project A");
      const resumeResult = await second.tools.get("Agent").execute(
        "cross-project-resume",
        {
          resume: projectAId,
          prompt: "must not resume project A",
          description: "cross-project resume",
          subagent_type: "general-purpose",
        },
        undefined,
        undefined,
        second.context,
      );
      expect(textOf(resumeResult)).toContain(`Agent not found: "${projectAId}"`);
    } finally {
      await second.dispose();
    }
  });

  it("attaches a reload-shaped workflow child below its restored workflow root", () => {
    const project = makeProject();
    const workflowId = "wf_a6c9a4f0335e";
    const childId = "ui-smoke-child";
    const workflowDirectory = join(project, ".pi-subagents", "workflow-history", "v1");
    mkdirSync(workflowDirectory, { recursive: true });
    writeFileSync(join(workflowDirectory, `${workflowId}.json`), JSON.stringify({
      version: 1,
      workflowId,
      artifactRootCwd: project,
      rootSessionId: "reload-session",
      name: "UI smoke workflow",
      description: "Reload tree smoke workflow",
      status: "completed",
      startedAt: 10,
      completedAt: 20,
      progress: [{ type: "workflow_agent", index: 0, label: childId, state: "done" }],
      agentCount: 1,
      doneCount: 1,
      totalTokens: 0,
      totalToolCalls: 0,
    }) + "\n");

    const transcriptPath = `.pi-subagents/agent-transcripts/${childId}.jsonl`;
    mkdirSync(join(project, ".pi-subagents", "agent-transcripts"), { recursive: true });
    writeFileSync(
      join(project, transcriptPath),
      JSON.stringify({ message: { role: "user", content: "workflow child prompt" } }) + "\n",
    );
    expect(writeAgentRecoveryCheckpoint(project, {
      version: 2,
      id: childId,
      type: "Explore",
      description: "UI smoke child",
      status: "completed",
      startedAt: 10,
      completedAt: 20,
      toolUses: 0,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
      compactionCount: 0,
      transcriptPath,
      runtime: { depth: 1, maxSubagentDepth: 2, rootSessionId: "reload-session" },
      session: {
        kind: "explicit",
        artifactRootCwd: project,
        resourceCwd: project,
        originalExecutionCwd: project,
      },
      ownership: { kind: "workflow", workflowId },
    })).toBe(true);

    const manager = new AgentManager();
    try {
      manager.restoreRecovered(project, "reload-session");
      const roots = loadWorkflowHistorySnapshots(project).map(toWorkflowHistoryTreeRoot);
      const projection = projectAgentTree({
        agents: manager.listAgents(),
        workflowRoots: roots,
        sessionId: "reload-session",
        artifactRootCwd: project,
        canOpenTerminalAgent: record => canOpenAgentHistory(record, project),
      });

      expect(projection.rows.map(row => ({
        key: row.key,
        depth: row.depth,
        parentKey: row.parentKey,
      }))).toEqual([
        { key: `workflow:${workflowId}`, depth: 0, parentKey: undefined },
        { key: `agent:${childId}`, depth: 1, parentKey: `workflow:${workflowId}` },
      ]);
    } finally {
      manager.dispose();
    }
  });

  it("does not rebind a workflow runtime handle across reload-shaped activation", async () => {
    const project = makeProject();
    const context = makeContext(project, undefined, {} as ModelRuntime, "session-a");
    const formerRecord = { id: "manager-record-1", status: "completed", result: "private result" };
    const getRecord = vi.fn((id: string) => id === formerRecord.id ? formerRecord : undefined);
    const manager = {
      getRecord,
      resume: vi.fn(),
      spawn: vi.fn((_pi: unknown, _ctx: unknown, _type: string, _prompt: string, options: { onSpawned?: (id: string) => void }) => {
        options.onSpawned?.(formerRecord.id);
        return formerRecord.id;
      }),
    };
    const firstActivation = createWorkflowHost({
      pi: {} as never,
      ctx: context,
      manager: manager as never,
      workflowId: "workflow-a",
      artifactRootCwd: project,
      outputTranscript: false,
    });
    const spawned = await firstActivation.spawnAgent({
      agentId: "wf-agent-1",
      index: 0,
      prompt: "initial workflow child",
      label: "workflow child",
      agentType: "general-purpose",
      runInBackground: true,
    });
    expect(spawned).toEqual({ ok: true, text: formerRecord.id, detached: true });
    expect(formerRecord).toMatchObject({ id: "manager-record-1", result: "private result" });

    getRecord.mockClear();
    const independentActivation = createWorkflowHost({
      pi: {} as never,
      ctx: context,
      manager: manager as never,
      workflowId: "workflow-a",
      artifactRootCwd: project,
      outputTranscript: false,
    });
    const waitResult = await independentActivation.waitForAgent!("wf-agent-1");
    const resumeResult = await independentActivation.resumeAgent("wf-agent-1", "continue", undefined, false);

    expect(waitResult).toEqual({
      ok: false,
      error: 'Cannot collect "wf-agent-1" — no such agent. It may have finished and been dropped already.',
    });
    expect(resumeResult).toEqual({
      ok: false,
      error: 'Cannot resume "wf-agent-1" — it never started.',
    });
    expect(getRecord).not.toHaveBeenCalled();
    expect(manager.resume).not.toHaveBeenCalled();
  });
});
