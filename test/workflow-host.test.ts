import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import { readAgentRecoveryCheckpoints } from "../src/agent-recovery.js";
import { resumeAgent, runAgent } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import { createOutputFilePath, streamToOutputFile, writeInitialEntry } from "../src/output-file.js";
import { createWorkflowHost } from "../src/workflow/host.js";
import type { WorkflowSpawnRequest } from "../src/workflow/runtime.js";

vi.mock("../src/agent-runner.js", () => ({
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
}));

vi.mock("../src/output-file.js", async () => {
  const actual = await vi.importActual<typeof import("../src/output-file.js")>("../src/output-file.js");
  return {
    ...actual,
    createOutputFilePath: vi.fn((cwd: string, agentId: string) => join(cwd, `${agentId}.output`)),
    streamToOutputFile: vi.fn(actual.streamToOutputFile),
    writeInitialEntry: vi.fn(actual.writeInitialEntry),
  };
});

const managers: AgentManager[] = [];
const directories: string[] = [];

function makeSession(): AgentSession {
  return {
    messages: [{ role: "user", content: "work" }],
    subscribe: vi.fn(() => () => {}),
    dispose: vi.fn(),
  } as unknown as AgentSession;
}

function registerWorkflowAgent(outputTranscript?: boolean): void {
  registerAgents(new Map([[
    "workflow-agent",
    {
      name: "workflow-agent",
      description: "workflow test agent",
      extensions: false,
      skills: false,
      systemPrompt: "",
      promptMode: "replace",
      ...(outputTranscript !== undefined ? { outputTranscript } : {}),
    },
  ]]));
}

function makeContext(cwd: string) {
  return {
    cwd,
    model: undefined,
    modelRegistry: {},
    sessionManager: { getSessionId: () => "parent-session" },
    ui: { notify: vi.fn() },
  } as never;
}

function makeRequest(runInBackground: boolean): WorkflowSpawnRequest {
  return {
    agentId: "wf-agent-0",
    index: 0,
    prompt: "work",
    label: "workflow child",
    agentType: "workflow-agent",
    runInBackground,
  };
}

describe("workflow host transcript wiring", () => {
  afterEach(() => {
    for (const manager of managers.splice(0)) manager.dispose();
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
    vi.mocked(runAgent).mockReset();
    vi.mocked(resumeAgent).mockReset();
    vi.mocked(createOutputFilePath).mockClear();
    vi.mocked(streamToOutputFile).mockClear();
    vi.mocked(writeInitialEntry).mockClear();
  });

  it.each([
    ["blocking", false],
    ["background", true],
  ] as const)("attaches before the initial checkpoint for %s spawns and wires the stream after session creation", async (_label, runInBackground) => {
    registerWorkflowAgent();
    const cwd = mkdtempSync(join(tmpdir(), "workflow-host-transcript-"));
    directories.push(cwd);
    const manager = new AgentManager();
    managers.push(manager);

    let release!: () => void;
    const sessionReady = new Promise<void>(resolve => { release = resolve; });
    const session = makeSession();
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
      await sessionReady;
      options.onSessionCreated?.(session);
      return { responseText: "done", session, aborted: false, steered: false };
    });

    const host = createWorkflowHost({
      pi: {} as never,
      ctx: makeContext(cwd),
      manager,
      rootSessionId: "parent-session",
      outputTranscript: true,
    });
    const spawnPromise = host.spawnAgent(makeRequest(runInBackground));

    await Promise.resolve();
    const record = manager.listAgents()[0];
    expect(record).toBeDefined();
    expect(record?.transcriptPath).toBeTruthy();
    expect(readAgentRecoveryCheckpoints(cwd)).toEqual([
      expect.objectContaining({ id: record?.id, transcriptPath: record?.transcriptPath }),
    ]);
    expect(streamToOutputFile).not.toHaveBeenCalled();

    release();
    const result = await spawnPromise;
    if (runInBackground) {
      expect(result).toEqual({ ok: true, text: record?.id, detached: true });
      await manager.getRecord(record!.id)?.promise;
    } else {
      expect(result).toMatchObject({ ok: true, text: "done" });
    }

    expect(streamToOutputFile).toHaveBeenCalledOnce();
    expect(streamToOutputFile).toHaveBeenCalledWith(
      session,
      record?.outputFile,
      record?.id,
      cwd,
      record?.historyFile,
      1,
    );
    expect(record?.outputCleanup).toBeUndefined();
  });

  it.each([
    ["blocking", false],
    ["detached", true],
  ] as const)("forwards an explicit mode when resuming a workflow child (%s)", async (_label, runInBackground) => {
    registerWorkflowAgent();
    const cwd = mkdtempSync(join(tmpdir(), "workflow-host-resume-"));
    directories.push(cwd);
    const manager = new AgentManager();
    managers.push(manager);
    const signal = new AbortController().signal;
    const session = makeSession();
    vi.mocked(runAgent).mockResolvedValue({ responseText: "done", session, aborted: false, steered: false });
    vi.mocked(resumeAgent).mockResolvedValue({ text: "resumed" });

    const host = createWorkflowHost({
      pi: {} as never,
      ctx: makeContext(cwd),
      manager,
      signal,
      workflowId: "workflow-1",
      outputTranscript: false,
    });
    const spawned = await host.spawnAgent(makeRequest(false));
    expect(spawned.ok).toBe(true);
    const recordId = manager.listAgents()[0]!.id;
    const resume = vi.spyOn(manager, "resume");

    const result = await host.resumeAgent!("wf-agent-0", "continue", undefined, runInBackground);
    await Promise.resolve();

    expect(result).toMatchObject({ ok: true });
    expect(resume).toHaveBeenCalledWith(
      recordId,
      "continue",
      expect.objectContaining({ create: expect.any(Function) }),
      expect.objectContaining({
        kind: "workflow",
        artifactRootCwd: cwd,
        workflowId: "workflow-1",
        runtimeAgentId: "wf-agent-0",
      }),
      { isBackground: runInBackground, signal },
    );
  });

  it.each([
    ["blocking", false],
    ["detached", true],
  ] as const)("attaches the real %s child to the workflow without a synthetic manager record", async (_label, runInBackground) => {
    registerWorkflowAgent();
    const cwd = mkdtempSync(join(tmpdir(), "workflow-host-ownership-"));
    directories.push(cwd);
    const manager = new AgentManager();
    managers.push(manager);
    const session = makeSession();
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
      options.onSessionCreated?.(session);
      return { responseText: "done", session, aborted: false, steered: false };
    });

    const workflowId = "workflow-1";
    const host = createWorkflowHost({
      pi: {} as never,
      ctx: makeContext(cwd),
      manager,
      workflowId,
    });
    const result = await host.spawnAgent(makeRequest(runInBackground));
    const records = manager.listAgents();

    expect(result.ok).toBe(true);
    expect(records).toHaveLength(1);
    expect(records[0]?.id).not.toBe(workflowId);
    expect(records[0]?.parentAgentId).toBe(workflowId);
    expect(manager.getRecord(workflowId)).toBeUndefined();
  });

  it.each([
    ["project default", true, undefined, true],
    ["project disabled", false, undefined, false],
    ["agent override enabled", false, true, true],
    ["agent override disabled", true, false, false],
  ] as const)("honors %s transcript policy", async (_label, projectDefault, agentOverride, expected) => {
    registerWorkflowAgent(agentOverride);
    const cwd = mkdtempSync(join(tmpdir(), "workflow-host-policy-"));
    directories.push(cwd);
    const manager = new AgentManager();
    managers.push(manager);
    const session = makeSession();
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
      options.onSessionCreated?.(session);
      return { responseText: "done", session, aborted: false, steered: false };
    });

    const host = createWorkflowHost({
      pi: {} as never,
      ctx: makeContext(cwd),
      manager,
      rootSessionId: "parent-session",
      outputTranscript: projectDefault,
    });
    const result = await host.spawnAgent(makeRequest(false));
    const record = manager.listAgents()[0];

    expect(result.ok).toBe(true);
    expect(record?.historyFile).toBeTruthy();
    expect(record?.transcriptPath).toMatch(/^\.pi-subagents\/agent-transcripts\/[^/]+\.jsonl$/);
    expect(readFileSync(record!.historyFile!, "utf8")).toContain('"content":"work"');
    expect(createOutputFilePath).toHaveBeenCalledTimes(expected ? 1 : 0);
    expect(writeInitialEntry).toHaveBeenCalledTimes(expected ? 2 : 1);
    expect(streamToOutputFile).toHaveBeenCalledOnce();
    if (expected) {
      expect(record?.outputFile).toBeTruthy();
    } else {
      expect(record?.outputFile).toBeUndefined();
      expect(readdirSync(cwd).filter(name => name.endsWith(".output"))).toEqual([]);
    }
  });
});
