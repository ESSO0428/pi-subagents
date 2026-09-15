import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentHistoryLocator, createAgentHistoryPath, readAgentHistoryResult } from "../src/agent-history.js";
import { AgentManager } from "../src/agent-manager.js";
import {
  agentRecoveryCheckpointPath,
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
        id,
        status: "running",
        transcriptPath: `.pi-subagents/agent-transcripts/${id}.jsonl`,
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
