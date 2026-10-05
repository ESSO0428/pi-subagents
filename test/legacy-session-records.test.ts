import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readLegacySessionRecords } from "../src/legacy-session-records.js";
import { encodeCwd } from "../src/output-file.js";

/** pi scopes sessions by project: <agentDir>/sessions/--<encoded-cwd>--/<file>. */
function writeSession(agentDir: string, cwd: string, sessionId: string, lines: unknown[]): void {
  const sessionDir = join(agentDir, "sessions", `--${encodeCwd(cwd)}--`);
  mkdirSync(sessionDir, { recursive: true });
  const file = `2026-08-24T15-15-53-760Z_${sessionId}.jsonl`;
  writeFileSync(join(sessionDir, file), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf-8");
}

function recordEntry(over: Record<string, unknown> = {}) {
  return {
    type: "custom",
    customType: "subagents:record",
    data: {
      id: "agent-1",
      type: "oracle",
      description: "Review deep narrow FFP",
      status: "completed",
      startedAt: 100,
      completedAt: 900,
      toolUses: 4,
      lifetimeUsage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
      ...over,
    },
  };
}

describe("legacy subagents:record reader", () => {
  it("recovers records from older sessions and stamps the owning session", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "legacy-records-"));
    const cwd = "/fake";
    try {
      writeSession(agentDir, cwd, "aaaa1111-2222-3333-4444-555566667777", [
        { type: "message", message: { role: "user", content: "hi" } },
        recordEntry(),
        { type: "message", message: { role: "assistant", content: "done" } },
      ]);

      const records = await readLegacySessionRecords(cwd, agentDir);

      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        id: "agent-1",
        type: "oracle",
        description: "Review deep narrow FFP",
        status: "completed",
        toolUses: 4,
        sessionId: "aaaa1111-2222-3333-4444-555566667777",
      });
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("survives a malformed line and keeps one record per agent id", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "legacy-records-"));
    const cwd = "/fake";
    try {
      writeSession(agentDir, cwd, "bbbb1111-2222-3333-4444-555566667777", [
        recordEntry({ id: "dup", type: "explorer", description: "Find FFP scripts", status: "steered" }),
        { malformed: "not json at all" },
        recordEntry({ id: "dup", type: "explorer", description: "Find FFP scripts", status: "steered" }),
      ]);

      const records = await readLegacySessionRecords(cwd, agentDir);

      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ id: "dup", status: "steered" });
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("ignores sessions belonging to another project", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "legacy-records-"));
    try {
      writeSession(agentDir, "/this-project", "cccc1111-2222-3333-4444-555566667777", [recordEntry({ id: "mine" })]);
      writeSession(agentDir, "/other-project", "dddd1111-2222-3333-4444-555566667777", [recordEntry({ id: "theirs" })]);

      const records = await readLegacySessionRecords("/this-project", agentDir);

      // Without project scoping every project's agents would leak into every other.
      expect(records.map((record) => record.id)).toEqual(["mine"]);
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("returns nothing when the sessions directory is absent", async () => {
    expect(await readLegacySessionRecords("/fake", "/definitely/not/here")).toEqual([]);
  });
});

describe("legacy records must clear the same bar as everything else", () => {
  it("excludes a legacy record that has no durable transcript", async () => {
    // Listing an entry that can only answer "No agent history." is a dead link.
    // The this-session list and the roster already enforce this; the legacy
    // reader must not be the surface that quietly skips the check.
    const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf-8");
    const merge = src.slice(src.indexOf("mergeLegacyRecords(\n        scoped,"), src.indexOf("));", src.indexOf("mergeLegacyRecords(\n        scoped,")));
    expect(merge).toContain("canOpenAgentHistory(record, ctx.cwd)");
  });
});
