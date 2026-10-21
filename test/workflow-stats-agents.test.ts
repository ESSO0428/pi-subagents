import { describe, expect, it } from "vitest";
import type { WorkflowEntry } from "../src/workflow/progress.js";
import { stats } from "../src/workflow/progress.js";

/**
 * One agent emits several entries as it runs: queued, running, tool use, done.
 * `stats` counts agents, not entries, so the header line reads `1/1 agents`
 * rather than inflating one child into several.
 */
function agentEntry(index: number, overrides: Partial<WorkflowEntry> = {}): WorkflowEntry {
  return { type: "workflow_agent", index, label: `a${index}`, state: "start", ...overrides } as WorkflowEntry;
}

describe("stats counts agents, not lifecycle entries", () => {
  it("reports one agent for one agent's full entry trail", () => {
    const progress = [
      agentEntry(0, { queuedAt: 1 }),
      agentEntry(0, { state: "running", startedAt: 2 }),
      agentEntry(0, { state: "running", startedAt: 2 }),
      agentEntry(0, { state: "done" }),
    ];

    expect(stats(progress, 1).total).toBe(1);
    expect(stats(progress, 1).done).toBe(1);
  });

  it("does not keep a finished run looking live", () => {
    const progress = [agentEntry(0, { queuedAt: 1 }), agentEntry(0, { state: "done" })];

    expect(stats(progress, 1).running).toBe(false);
  });

  it("still counts each distinct agent once", () => {
    const progress = [
      agentEntry(0, { state: "done" }),
      agentEntry(0, { state: "done" }),
      agentEntry(1, { queuedAt: 1 }),
      agentEntry(1, { state: "done" }),
    ];

    expect(stats(progress, 2).total).toBe(2);
    expect(stats(progress, 2).done).toBe(2);
  });

  it("ignores log and phase entries", () => {
    const progress: WorkflowEntry[] = [
      { type: "workflow_log", message: "hello" } as WorkflowEntry,
      { type: "workflow_phase", index: 0, title: "Smoke" } as unknown as WorkflowEntry,
      agentEntry(0, { state: "done" }),
    ];

    expect(stats(progress, 1).total).toBe(1);
  });
});