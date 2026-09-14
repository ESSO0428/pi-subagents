import { afterEach, describe, expect, it } from "vitest";
import { AgentManager } from "../src/agent-manager.js";

const managers: AgentManager[] = [];

afterEach(() => {
  for (const manager of managers.splice(0)) manager.dispose();
});

function makeManager(): AgentManager {
  const manager = new AgentManager();
  managers.push(manager);
  return manager;
}

function record(overrides: Record<string, unknown> = {}) {
  return {
    id: "agent-1",
    type: "Explore",
    description: "Inspect the repository",
    status: "completed",
    result: "done",
    toolUses: 2,
    startedAt: 1_000,
    completedAt: 2_000,
    ...overrides,
  };
}

describe("AgentManager.restoreCompleted", () => {
  it("restores all five terminal statuses without sessions", () => {
    const manager = makeManager();
    manager.restoreCompleted(["completed", "steered", "stopped", "aborted", "error"].map((status, i) =>
      record({ id: `agent-${i}`, status }),
    ));

    expect(manager.listAgents()).toHaveLength(5);
    for (const restored of manager.listAgents()) {
      expect(["completed", "steered", "stopped", "aborted", "error"]).toContain(restored.status);
      expect(restored.session).toBeUndefined();
      expect(restored.abortController).toBeUndefined();
      expect(restored.promise).toBeUndefined();
      expect(restored.lifetimeUsage).toEqual({ input: 0, output: 0, cacheWrite: 0 });
      expect(restored.compactionCount).toBe(0);
    }
  });

  it("ignores running, queued, and invalid records", () => {
    const manager = makeManager();
    manager.restoreCompleted([
      record({ id: "running", status: "running" }),
      record({ id: "queued", status: "queued" }),
      { id: "invalid" },
    ]);

    expect(manager.listAgents()).toEqual([]);
  });

  it("keeps the last valid duplicate input", () => {
    const manager = makeManager();
    manager.restoreCompleted([
      record({ result: "first", startedAt: 1_000, completedAt: 1_100 }),
      record({ result: "last", startedAt: 2_000, completedAt: 2_100 }),
    ]);

    expect(manager.getRecord("agent-1")?.result).toBe("last");
    expect(manager.getRecord("agent-1")?.startedAt).toBe(2_000);
  });

  it("does not replace a live record and rejects unsafe persisted data", () => {
    const manager = makeManager();
    // Exercise the public map through a restored terminal, then make it live
    // without starting an LLM session.
    manager.restoreCompleted([record({ id: "live", result: "original" })]);
    const liveRecord = manager.getRecord("live")!;
    liveRecord.status = "running";

    manager.restoreCompleted([
      record({ id: "live", result: "replacement" }),
      record({ id: "bad-time", startedAt: Number.NaN }),
      record({ id: "bad-path", transcriptPath: "../../outside.jsonl" }),
    ]);

    expect(manager.getRecord("live")?.result).toBe("original");
    expect(manager.getRecord("bad-time")).toBeUndefined();
    expect(manager.getRecord("bad-path")).toBeUndefined();
  });
});
