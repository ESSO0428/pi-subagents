import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildAgentStatusMenuEntries } from "../src/agent-history-list.js";
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
  it("lists this session's history before the project-wide one", () => {
    const entries = buildAgentStatusMenuEntries(
      [
        record({ id: "here", sessionId: "session-a" }),
        record({ id: "there", sessionId: "session-b" }),
        record({ id: "unstamped" }),
      ],
      undefined,
      "session-a",
    );

    const thisSession = entries.find((e) => e.startsWith("Agent history this session"));
    const all = entries.find((e) => e.startsWith("Agent history all sessions"));

    expect(thisSession).toBe("Agent history this session (1)");
    // Unattributable records stay reachable through the project-wide entry.
    expect(all).toBe("Agent history all sessions (3)");
    expect(entries.indexOf(thisSession!)).toBeLessThan(entries.indexOf(all!));
  });

  it("omits the this-session entry when nothing belongs to this session", () => {
    const entries = buildAgentStatusMenuEntries([record({ id: "other", sessionId: "session-z" })], undefined, "session-a");
    expect(entries.some((e) => e.startsWith("Agent history this session"))).toBe(false);
    expect(entries.some((e) => e.startsWith("Agent history all sessions"))).toBe(true);
  });

  it("falls back to the project-wide entry with no session id", () => {
    const entries = buildAgentStatusMenuEntries([record({ id: "x", sessionId: "a" })], undefined, undefined);
    expect(entries.some((e) => e.startsWith("Agent history this session"))).toBe(false);
    expect(entries.some((e) => e.startsWith("Agent history all sessions"))).toBe(true);
  });
});
describe("session stamp provenance", () => {
  it("a checkpoint-restored record keeps its own session, a branch-restored one adopts the current", () => {
    // Guards the mistake that made both counts equal: stamping every restored
    // record with the current session turned "this session" into "everything".
    // Only branch inheritance (restoreCompleted) may re-stamp.
    const src = readFileSync(new URL("../src/agent-manager.ts", import.meta.url), "utf-8");
    const recovered = src.slice(src.indexOf("restoreRecovered(cwd: string)"));
    const recoveredBody = recovered.slice(0, recovered.indexOf("\n  }"));
    expect(recoveredBody).not.toMatch(/createRestoredRecord\(\{[\s\S]*?\bsessionId,/);
    expect(recoveredBody).toContain("...checkpoint");

    const completed = src.slice(src.indexOf("restoreCompleted(records"));
    expect(completed).toContain("sessionId");
  });
});
