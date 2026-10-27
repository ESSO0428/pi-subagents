import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentHistoryLocator, createAgentHistoryPath, readAgentHistoryResult } from "../src/agent-history.js";
import { AgentManager } from "../src/agent-manager.js";
import type { AgentRecoveryCheckpointV2 } from "../src/agent-recovery.js";
import {
  agentRecoveryCheckpointPath,
  isAgentRecoveryCheckpoint,
  isAgentRecoveryCheckpointV2,
  readAgentRecoveryCheckpoints,
  writeAgentRecoveryCheckpoint,
} from "../src/agent-recovery.js";
import { streamToOutputFile } from "../src/output-file.js";

vi.mock("../src/agent-runner.js", () => ({
  runAgent: vi.fn(() => new Promise(() => {})),
  resumeAgent: vi.fn(),
}));

const mockPi = {} as any;
const tempDirectories: string[] = [];
const managers: AgentManager[] = [];

function makeProject(): string {
  const cwd = mkdtempSync(join(tmpdir(), "pi-agent-recovery-"));
  tempDirectories.push(cwd);
  return cwd;
}

function makeContext(cwd: string) {
  return { cwd } as any;
}

function addTranscript(cwd: string, id: string, output = "partial output"): string {
  const path = createAgentHistoryPath(cwd, id);
  writeFileSync(path, [
    JSON.stringify({ message: { role: "user", content: "prompt" } }),
    JSON.stringify({ message: { role: "assistant", content: output } }),
  ].join("\n") + "\n");
  return path;
}

function startCheckpointedAgent(cwd: string): { manager: AgentManager; id: string; locator: string } {
  const manager = new AgentManager(undefined, 1);
  managers.push(manager);
  const id = manager.spawn(mockPi, makeContext(cwd), "Explore", "prompt", {
    description: "Recover this task",
    isBackground: true,
  });
  const historyFile = addTranscript(cwd, id);
  const locator = agentHistoryLocator(cwd, historyFile);
  manager.setTranscript(id, historyFile, locator, cwd);
  return { manager, id, locator };
}

afterEach(() => {
  for (const manager of managers.splice(0)) manager.dispose();
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("checkpoint v2 validation", () => {
  const baseV2 = (session: AgentRecoveryCheckpointV2["session"]): AgentRecoveryCheckpointV2 => ({
    version: 2,
    id: "agent-v2",
    type: "Explore",
    description: "v2 checkpoint",
    status: "completed",
    startedAt: 1,
    completedAt: 2,
    resultConsumed: false,
    toolCallId: "call-1",
    toolUses: 1,
    lifetimeUsage: { input: 2, output: 3, cacheWrite: 4 },
    compactionCount: 1,
    invocation: {
      effectiveModelName: "gpt-test",
      effectiveThinking: "high",
      runInBackground: true,
    },
    runtime: { depth: 2, maxSubagentDepth: 4, rootSessionId: "root-session" },
    session,
    ownership: { kind: "nested", parentAgentId: "parent-agent", depth: 2 },
    worktree: {
      repoRoot: "/project",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      savedCommitSha: "fedcba9876543210fedcba9876543210fedcba98",
      originalTargetSubdirectory: "packages/api",
    },
  });

  it("keeps v1 as a strict display-only checkpoint and accepts valid v2 state", () => {
    const v1 = {
      version: 1 as const,
      id: "legacy",
      type: "Explore",
      description: "legacy checkpoint",
      status: "stopped" as const,
      startedAt: 1,
      completedAt: 2,
      toolUses: 0,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
      compactionCount: 0,
      transcriptPath: ".pi-subagents/agent-transcripts/legacy.jsonl",
    };
    const v2 = baseV2({
      kind: "private",
      locator: ".pi-subagents/agent-sessions/session-1.jsonl",
      sessionId: "session-1",
      artifactRootCwd: "/project",
      resourceCwd: "/project",
      originalExecutionCwd: "/project/packages/api",
      provider: "openai",
      modelId: "gpt-test",
      thinking: "high",
    });

    expect(isAgentRecoveryCheckpoint(v1)).toBe(true);
    expect(isAgentRecoveryCheckpointV2(v1)).toBe(false);
    expect(isAgentRecoveryCheckpoint(v2)).toBe(true);
    expect(isAgentRecoveryCheckpointV2(v2)).toBe(true);
  });

  it.each([
    { kind: "pending" },
    {
      kind: "memory",
      artifactRootCwd: "/project",
      resourceCwd: "/project",
      originalExecutionCwd: "/project",
    },
    {
      kind: "explicit",
      artifactRootCwd: "/project",
      resourceCwd: "/project",
      originalExecutionCwd: "/project",
    },
  ] as const)("accepts non-executable session state %j without guessed private metadata", (session) => {
    expect(isAgentRecoveryCheckpointV2(baseV2(session))).toBe(true);
  });

  it.each([
    ["future version", { ...baseV2({ kind: "pending" }), version: 3 }],
    ["missing runtime identity", (() => {
      const checkpoint = baseV2({ kind: "pending" });
      const { runtime: _runtime, ...withoutRuntime } = checkpoint;
      return withoutRuntime;
    })()],
    ["private missing exact model", (() => {
      const checkpoint = baseV2({
        kind: "private",
        locator: ".pi-subagents/agent-sessions/session-1.jsonl",
        sessionId: "session-1",
        artifactRootCwd: "/project",
        resourceCwd: "/project",
        originalExecutionCwd: "/project",
        provider: "openai",
        modelId: "gpt-test",
        thinking: "high",
      });
      const session = { ...checkpoint.session };
      delete (session as { modelId?: string }).modelId;
      return { ...checkpoint, session };
    })()],
  ] as const)("rejects %s as non-executable", (_label, value) => {
    expect(isAgentRecoveryCheckpoint(value)).toBe(false);
    expect(isAgentRecoveryCheckpointV2(value)).toBe(false);
  });

  it("round-trips v2 runtime identity and private state atomically", () => {
    const cwd = makeProject();
    const checkpoint = baseV2({
      kind: "private",
      locator: ".pi-subagents/agent-sessions/session-1.jsonl",
      sessionId: "session-1",
      artifactRootCwd: cwd,
      resourceCwd: cwd,
      originalExecutionCwd: cwd,
      provider: "openai",
      modelId: "gpt-test",
      thinking: "high",
    });

    expect(writeAgentRecoveryCheckpoint(cwd, checkpoint)).toBe(true);
    expect(readAgentRecoveryCheckpoints(cwd)).toEqual([checkpoint]);
    expect(readAgentRecoveryCheckpoints(cwd)[0]?.runtime).toEqual({
      depth: 2,
      maxSubagentDepth: 4,
      rootSessionId: "root-session",
    });
    expect(readAgentRecoveryCheckpoints(cwd)[0]?.invocation).toEqual(checkpoint.invocation);
  });

  it("fails closed for malformed and future checkpoints", () => {
    const cwd = makeProject();
    const directory = join(cwd, ".pi-subagents", "agent-checkpoints");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "future.json"), JSON.stringify({ version: 3, id: "future" }));
    writeFileSync(join(directory, "corrupt.json"), "not json\n");

    expect(readAgentRecoveryCheckpoints(cwd)).toEqual([]);
  });
});

describe("durable interrupted recovery", () => {
  it("persists the transcript locator before a queued or running spawn is exposed", () => {
    const cwd = makeProject();
    const manager = new AgentManager(undefined, 1);
    managers.push(manager);
    let callbackId: string | undefined;
    const id = manager.spawn(mockPi, makeContext(cwd), "Explore", "prompt", {
      description: "Early checkpoint",
      isBackground: true,
      onSpawned: (spawnedId) => {
        callbackId = spawnedId;
        const path = addTranscript(cwd, spawnedId);
        manager.setTranscript(spawnedId, path, agentHistoryLocator(cwd, path), cwd);
      },
    });

    expect(callbackId).toBe(id);
    expect(readAgentRecoveryCheckpoints(cwd)).toEqual([
      expect.objectContaining({
        version: 2,
        id,
        status: "running",
        transcriptPath: `.pi-subagents/agent-transcripts/${id}.jsonl`,
        session: { kind: "pending" },
        runtime: { depth: 1, maxSubagentDepth: 2 },
        ownership: { kind: "top-level" },
      }),
    ]);
  });

  it("checkpoints running and queued agents during clean shutdown", () => {
    const cwd = makeProject();
    const manager = new AgentManager(undefined, 1);
    managers.push(manager);
    const running = manager.spawn(mockPi, makeContext(cwd), "Explore", "one", {
      description: "Running task",
      isBackground: true,
    });
    const queued = manager.spawn(mockPi, makeContext(cwd), "Explore", "two", {
      description: "Queued task",
      isBackground: true,
    });
    const runningPath = addTranscript(cwd, running);
    manager.setTranscript(running, runningPath, agentHistoryLocator(cwd, runningPath), cwd);
    const queuedPath = addTranscript(cwd, queued);
    manager.setTranscript(queued, queuedPath, agentHistoryLocator(cwd, queuedPath), cwd);

    expect(manager.abortAll()).toBe(2);
    const checkpoints = readAgentRecoveryCheckpoints(cwd);
    expect(checkpoints).toHaveLength(2);
    expect(checkpoints.every((checkpoint) => checkpoint.status === "stopped")).toBe(true);
    expect(checkpoints.every((checkpoint) => checkpoint.transcriptPath)).toBe(true);
  });

  it("round-trips a nested child's parentAgentId and depth through a reload", () => {
    const cwd = makeProject();
    const manager = new AgentManager(undefined, 1);
    managers.push(manager);

    const parentId = manager.spawn(mockPi, makeContext(cwd), "Explore", "fan out", {
      description: "parent task",
      isBackground: true,
    });
    const parentFile = addTranscript(cwd, parentId, "parent done");
    manager.setTranscript(parentId, parentFile, agentHistoryLocator(cwd, parentFile), cwd);

    const childId = manager.spawn(mockPi, makeContext(cwd), "Explore", "nested task", {
      description: "nested task",
      isBackground: true,
      parentAgentId: parentId,
      depth: 2,
    });
    const childFile = addTranscript(cwd, childId, "child done");
    manager.setTranscript(childId, childFile, agentHistoryLocator(cwd, childFile), cwd);

    const written = readAgentRecoveryCheckpoints(cwd).find((c) => c.id === childId);
    expect(written?.version).toBe(2);
    expect(written?.ownership).toEqual({ kind: "nested", parentAgentId: parentId, depth: 2 });
    expect(written?.runtime.depth).toBe(2);

    // A fresh manager rebuilding from disk must keep the edge, or the roster
    // renders the child as a root and the tree flattens after a reload.
    const restored = new AgentManager(undefined, 1);
    managers.push(restored);
    restored.restoreRecovered(cwd);
    const child = restored.getRecord(childId);
    expect(child?.parentAgentId).toBe(parentId);
    expect(child?.depth).toBe(2);
  });

  it("round-trips a workflow child's ownership and workflow parent through a reload", () => {
    const cwd = makeProject();
    const manager = new AgentManager(undefined, 1);
    managers.push(manager);
    const workflowId = "wf_workflow1";
    const childId = manager.spawn(mockPi, makeContext(cwd), "Explore", "workflow task", {
      description: "workflow child",
      isBackground: true,
      depth: 1,
      ownership: { kind: "workflow", workflowId, depth: 1 },
    });
    const childFile = addTranscript(cwd, childId, "workflow child done");
    manager.setTranscript(childId, childFile, agentHistoryLocator(cwd, childFile), cwd);

    const written = readAgentRecoveryCheckpoints(cwd).find((checkpoint) => checkpoint.id === childId);
    expect(written?.version).toBe(2);
    expect(written?.ownership).toEqual({ kind: "workflow", workflowId, depth: 1 });

    const restored = new AgentManager(undefined, 1);
    managers.push(restored);
    restored.restoreRecovered(cwd);
    const child = restored.getRecord(childId);
    expect(child?.ownership).toEqual({ kind: "workflow", workflowId, depth: 1 });
    expect(child?.parentAgentId).toBe(workflowId);
    expect(child?.depth).toBe(1);
  });

  it("checkpoints a stopped record when a session switches", () => {
    const cwd = makeProject();
    const { manager, id, locator } = startCheckpointedAgent(cwd);

    // session_before_switch uses the same abortAll path as shutdown.
    manager.abortAll();
    const checkpoint = readAgentRecoveryCheckpoints(cwd).find((item) => item.id === id);
    expect(checkpoint).toEqual(expect.objectContaining({ id, status: "stopped", transcriptPath: locator }));
  });

  it("reloads an interrupted record and exposes its partial transcript", () => {
    const cwd = makeProject();
    const first = startCheckpointedAgent(cwd);
    // Leave the active checkpoint in place: this models a process that died
    // before the final shutdown callback. A real SIGKILL cannot flush more.
    first.manager.dispose();
    managers.splice(managers.indexOf(first.manager), 1);

    const reopened = new AgentManager();
    managers.push(reopened);
    reopened.restoreRecovered(cwd);
    const recovered = reopened.getRecord(first.id);
    expect(recovered?.status).toBe("stopped");
    expect(recovered?.transcriptPath).toBe(first.locator);
    expect(recovered?.sessionState).toEqual({ kind: "pending" });
    expect(readAgentHistoryResult(cwd, first.locator)).toBe("partial output");
  });

  it("flushes partial assistant output before writing the stopped checkpoint", () => {
    const cwd = makeProject();
    const manager = new AgentManager(undefined, 1);
    managers.push(manager);
    const id = manager.spawn(mockPi, makeContext(cwd), "Explore", "prompt", {
      description: "Flush partial output",
      isBackground: true,
      onSpawned: (spawnedId) => {
        const path = createAgentHistoryPath(cwd, spawnedId);
        writeFileSync(path, `${JSON.stringify({ message: { role: "user", content: "prompt" } })}\n`);
        manager.setTranscript(spawnedId, path, agentHistoryLocator(cwd, path), cwd);
      },
    });
    const record = manager.getRecord(id)!;
    const path = record.historyFile!;
    const session = {
      messages: [{ role: "user", content: "prompt" }],
      subscribe: () => () => {},
    } as any;
    record.outputCleanup = streamToOutputFile(session, path, id, "cwd", path);
    session.messages.push({ role: "assistant", content: "partial answer" });

    expect(manager.abort(id)).toBe(true);
    expect(readAgentHistoryResult(cwd, record.transcriptPath!)).toBe("partial answer");
  });

  it("deduplicates repeated checkpoints for one agent", () => {
    const cwd = makeProject();
    const { manager, id, locator } = startCheckpointedAgent(cwd);
    manager.checkpointRecord(id);
    manager.checkpointRecord(id);

    expect(readAgentRecoveryCheckpoints(cwd)).toHaveLength(1);
    expect(agentRecoveryCheckpointPath(cwd, id)).toContain(`${id}.json`);
    expect(readAgentRecoveryCheckpoints(cwd)[0]?.transcriptPath).toBe(locator);
  });

  it("ignores orphan checkpoints, orphan transcripts, and corrupt files", () => {
    const cwd = makeProject();
    mkdirSync(join(cwd, ".pi-subagents", "agent-checkpoints"), { recursive: true });
    writeFileSync(join(cwd, ".pi-subagents", "agent-checkpoints", "broken.json"), "not json\n");
    writeFileSync(join(cwd, ".pi-subagents", "agent-checkpoints", "orphan.json"), JSON.stringify({
      version: 1,
      id: "orphan",
      type: "Explore",
      description: "No transcript",
      status: "stopped",
      startedAt: 1,
      completedAt: 2,
      toolUses: 0,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
      compactionCount: 0,
      transcriptPath: ".pi-subagents/agent-transcripts/missing.jsonl",
    }));
    const corruptTranscript = join(cwd, ".pi-subagents", "agent-transcripts", "corrupt.jsonl");
    mkdirSync(join(cwd, ".pi-subagents", "agent-transcripts"), { recursive: true });
    writeFileSync(corruptTranscript, "not json\n");
    writeAgentRecoveryCheckpoint(cwd, {
      version: 1,
      id: "corrupt-transcript",
      type: "Explore",
      description: "Corrupt transcript",
      status: "stopped",
      startedAt: 1,
      completedAt: 2,
      toolUses: 0,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
      compactionCount: 0,
      transcriptPath: ".pi-subagents/agent-transcripts/corrupt.jsonl",
    });

    const manager = new AgentManager();
    managers.push(manager);
    manager.restoreRecovered(cwd);
    expect(manager.listAgents()).toEqual([]);
  });

  it("documents the SIGKILL limitation by recovering the last active snapshot", () => {
    const cwd = makeProject();
    const { manager, id } = startCheckpointedAgent(cwd);
    manager.dispose();
    managers.splice(managers.indexOf(manager), 1);

    const checkpoint = readAgentRecoveryCheckpoints(cwd).find((item) => item.id === id);
    expect(checkpoint?.status).toBe("running");
    // SIGKILL cannot run abortAll/flushOutput; reload converts this stale
    // active snapshot to stopped while preserving the last flushed transcript.
    const reopened = new AgentManager();
    managers.push(reopened);
    reopened.restoreRecovered(cwd);
    expect(reopened.getRecord(id)?.status).toBe("stopped");
  });
});
