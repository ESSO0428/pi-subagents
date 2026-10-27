import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildAgentStatusMenuEntries } from "../src/agent-history-list.js";
import { projectAgentTree } from "../src/agent-tree.js";
import type { AgentRecord } from "../src/types.js";

function record(over: Partial<AgentRecord> & { id: string }): AgentRecord {
  return {
    type: "Explore",
    description: over.id,
    status: "completed",
    startedAt: 0,
    completedAt: 1000,
    toolUses: 1,
    lifetimeUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    compactionCount: 0,
    // canOpenAgentHistory needs an openable history source; a live session stub
    // keeps these fixtures out of the filesystem.
    session: {} as AgentRecord["session"],
    ...over,
  } as AgentRecord;
}

describe("agent history menu scope", () => {
  it("lists this session's conversation tree before project-wide history", () => {
    const entries = buildAgentStatusMenuEntries(
      [
        record({ id: "here", sessionId: "session-a" }),
        record({ id: "there", sessionId: "session-b" }),
        record({ id: "unstamped" }),
      ],
      undefined,
      "session-a",
    );

    const thisSession = entries.find((e) => e.startsWith("Agent conversations this session"));
    const all = entries.find((e) => e.startsWith("Agent history all sessions"));

    expect(thisSession).toBe("Agent conversations this session (1)");
    // Unattributable records stay reachable through the project-wide entry.
    expect(all).toBe("Agent history all sessions (3)");
    expect(entries.indexOf(thisSession!)).toBeLessThan(entries.indexOf(all!));
  });

  it("omits the current-session tree when nothing belongs to this session", () => {
    const entries = buildAgentStatusMenuEntries([record({ id: "other", sessionId: "session-z" })], undefined, "session-a");
    expect(entries.some((e) => e.startsWith("Agent conversations this session"))).toBe(false);
    expect(entries.some((e) => e.startsWith("Agent history all sessions"))).toBe(true);
  });

  it("falls back to the project-wide entry with no session id", () => {
    const entries = buildAgentStatusMenuEntries([record({ id: "x", sessionId: "a" })], undefined, undefined);
    expect(entries.some((e) => e.startsWith("Agent conversations this session"))).toBe(false);
    expect(entries.some((e) => e.startsWith("Agent history all sessions"))).toBe(true);
  });
});
describe("current-session visibility behavior", () => {
  it("hides a raw unstamped record while admitting a restored stamped record", () => {
    const records = [
      record({ id: "raw-unstamped" }),
      record({ id: "restored", sessionId: "session-b" }),
    ];
    const projection = projectAgentTree({
      agents: records,
      sessionId: "session-b",
      canOpenTerminalAgent: () => true,
    });

    expect(projection.rows.map(row => row.node.kind === "agent" ? row.node.record.id : row.node.root.id))
      .toEqual(["restored"]);
    expect(buildAgentStatusMenuEntries(records, undefined, "session-b"))
      .toEqual([
        "Agent conversations this session (1)",
        "Agent history all sessions (2)",
      ]);
  });
});

describe("session stamp provenance", () => {
  it("checkpoint restore stamps only when the reload supplies the current session", () => {
    // Project checkpoints mix every session. The reload lifecycle may stamp the
    // in-memory projection, while direct restore callers remain all-session.
    const src = readFileSync(new URL("../src/agent-manager.ts", import.meta.url), "utf-8");
    const recovered = src.slice(src.indexOf("restoreRecovered(cwd: string, sessionId?: string)"));
    const recoveredBody = recovered.slice(0, recovered.indexOf("\n  }"));
    expect(recoveredBody).toContain("sessionId !== undefined");
    expect(recoveredBody).toContain("...checkpoint");

    const completed = src.slice(src.indexOf("restoreCompleted(records"));
    expect(completed).toContain("sessionId");
  });
});

  it("counts recovered legacy records the menu cannot see in memory", () => {
    const inMemory = [
      record({ id: "a", sessionId: "s1" }),
      record({ id: "b", sessionId: "s2" }),
    ];
    const legacy = [
      record({ id: "c", sessionId: "s-old" }),
      record({ id: "d", sessionId: "s-old" }),
      // Same agent already restored from a checkpoint — must not be counted twice.
      record({ id: "b", sessionId: "s-old" }),
    ];

    const entries = buildAgentStatusMenuEntries(inMemory, undefined, "s1", legacy);
    const label = entries.find((e) => e.startsWith("Agent history all sessions"))!;

    // The list opens with 2 in-memory + 2 genuinely-new legacy records.
    expect(label).toBe("Agent history all sessions (4)");
  });
