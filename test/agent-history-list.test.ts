import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildAgentStatusMenuEntries,
  canOpenActiveAgent,
  canOpenAgentHistory,
  countSessionAgentConversations,
  formatAgentHistoryOption,
  isTerminalAgentStatus,
  resolveAgentViewMode,
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

  it("resolves only usable live or history Agent Views", () => {
    expect(resolveAgentViewMode(record({ status: "running", session: {} }), undefined)).toBe("live");
    expect(resolveAgentViewMode(record({ status: "completed", session: {} }), undefined)).toBe("history");
    expect(resolveAgentViewMode(record({ status: "queued", session: undefined }), undefined)).toBeUndefined();
    expect(resolveAgentViewMode(record({ status: "stopped", session: undefined }), undefined)).toBeUndefined();
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

  it("builds one current-session tree entry plus all-session history", () => {
    const entries = buildAgentStatusMenuEntries([
      record({ id: "running", status: "running", session: {}, sessionId: "session-1" } as any),
      record({ id: "queued", status: "queued", session: undefined, sessionId: "session-1" } as any),
      record({ id: "completed", status: "completed", session: {}, sessionId: "session-1" } as any),
      record({ id: "other", status: "error", session: {}, sessionId: "session-2" } as any),
      record({ id: "closed", status: "stopped", session: undefined, sessionId: "session-1" } as any),
    ], undefined, "session-1");

    expect(entries).toEqual([
      "Agent conversations this session (3)",
      "Agent history all sessions (2)",
    ]);
    expect(countSessionAgentConversations([
      record({ status: "queued", sessionId: "session-1" } as any),
    ], undefined, "session-1")).toBe(1);
    expect(buildAgentStatusMenuEntries([], undefined, "session-1", [], true)).toEqual([
      "Agent conversations this session (0)",
    ]);
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
