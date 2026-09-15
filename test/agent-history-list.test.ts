import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildAgentStatusMenuEntries,
  canOpenActiveAgent,
  canOpenAgentHistory,
  formatAgentHistoryOption,
  isTerminalAgentStatus,
  splitAgentRecords,
} from "../src/agent-history-list.js";

type TestRecord = {
  status: string;
  session?: object;
  transcriptPath?: string;
  type?: string;
  description?: string;
  startedAt?: number;
  completedAt?: number;
};

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function record(overrides: TestRecord): any {
  return {
    id: "agent-1",
    type: "Explore",
    description: "Inspect the repository",
    status: "completed",
    toolUses: 0,
    startedAt: 1_000,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    ...overrides,
  };
}

describe("agent history list helpers", () => {
  it("recognizes exactly the five terminal statuses", () => {
    for (const status of ["completed", "steered", "stopped", "aborted", "error"]) {
      expect(isTerminalAgentStatus(status)).toBe(true);
    }
    for (const status of ["running", "queued", "unknown", ""]) {
      expect(isTerminalAgentStatus(status)).toBe(false);
    }
  });

  it("separates active and terminal records without mutating input", () => {
    const done = record({ status: "completed", session: {} });
    const running = record({ status: "running", session: {} });
    const stopped = record({ status: "stopped", session: {} });
    const queued = record({ status: "queued", session: {} });
    const input = [done, running, stopped, queued];
    const before = [...input];

    const result = splitAgentRecords(input, undefined);

    expect(result.active).toEqual([running, queued]);
    expect(result.history).toEqual([done, stopped]);
    expect(input).toEqual(before);
    expect(input).toEqual([done, running, stopped, queued]);
  });

  it("requires a session or existing transcript for history", () => {
    expect(canOpenAgentHistory(record({ session: undefined }), undefined)).toBe(false);
    expect(canOpenAgentHistory(record({ session: {} }), undefined)).toBe(true);
    expect(canOpenAgentHistory(record({ status: "running", session: {} }), undefined)).toBe(false);
    expect(canOpenActiveAgent(record({ status: "running", session: {} }))).toBe(true);
    expect(canOpenActiveAgent(record({ status: "queued", session: undefined }))).toBe(false);
    expect(canOpenActiveAgent(record({ status: "completed", session: {} }))).toBe(false);
  });

  it("opens history only for an existing project-local transcript", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-subagents-history-list-"));
    tempDirectories.push(cwd);
    const transcriptPath = ".pi-subagents/agent-transcripts/agent.jsonl";
    mkdirSync(join(cwd, ".pi-subagents", "agent-transcripts"), { recursive: true });
    const historical = record({ session: undefined, transcriptPath });

    expect(canOpenAgentHistory(historical, cwd)).toBe(false);
    writeFileSync(join(cwd, transcriptPath), "{}\n");
    expect(canOpenAgentHistory(historical, cwd)).toBe(true);
    expect(canOpenAgentHistory(historical, undefined)).toBe(false);
  });

  it("builds separate menu entries with openable records only", () => {
    const entries = buildAgentStatusMenuEntries([
      record({ status: "running", session: {} }),
      record({ status: "queued", session: undefined }),
      record({ status: "completed", session: {} }),
      record({ status: "error", session: {} }),
      record({ status: "stopped", session: undefined }),
    ], undefined);

    expect(entries).toEqual(["Running agents (1)", "Agent history (2)"]);
    expect(buildAgentStatusMenuEntries([record({ status: "queued", session: undefined })], undefined)).toEqual([]);
  });

  it("formats a bounded history option using the display name and duration", () => {
    const option = formatAgentHistoryOption(record({
      status: "completed",
      type: "Explore",
      description: "A very long description ".repeat(20),
      startedAt: 1_000,
      completedAt: 3_000,
    }), 9_000);

    expect(option).toContain("[completed]");
    expect(option).toContain("Explore");
    expect(option).toContain("2.0s");
    expect(option.length).toBeLessThanOrEqual(140);
  });
});
