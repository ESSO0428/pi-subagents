import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import { registerAgents } from "../src/agent-types.js";
import { createNestedSubagentTools } from "../src/nested-tools.js";
import type { AgentRecord } from "../src/types.js";

vi.mock("../src/agent-runner.js", () => ({ runAgent: vi.fn(), resumeAgent: vi.fn() }));
vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(),
  cleanupWorktree: vi.fn(() => ({ hasChanges: false })),
  pruneWorktrees: vi.fn(),
}));

import { runAgent } from "../src/agent-runner.js";

const cleanupDirs: string[] = [];
const cleanupManagers: AgentManager[] = [];

afterEach(() => {
  for (const m of cleanupManagers.splice(0)) m.dispose();
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.mocked(runAgent).mockReset();
});

describe("nested child durable transcript", () => {
  /**
   * `AgentManager.cleanup()` keeps a completed record only when it has a
   * `transcriptPath`; without one it calls `removeRecord()` and the child
   * disappears, taking the parent's subtree with it. `canOpenHistory` reads the
   * same field once the live session has been released.
   */
  it("gives a nested child a transcriptPath so cleanup keeps it under its parent", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "nested-history-"));
    cleanupDirs.push(cwd);

    mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "agents", "child.md"),
      "---\nname: child\ndescription: a nested child agent\nallowed_subagents: all\n---\nbody\n",
      "utf-8",
    );

    registerAgents(new Map([["parent", {
      name: "parent",
      description: "parent agent",
      allowedSubagents: "all",
      extensions: true,
      excludeTools: [],
      rootSessionId: "session-1",
    } as never]]));

    vi.mocked(runAgent).mockImplementation(async (session: unknown) => {
      void session;
      return { responseText: "child done", session: { dispose: vi.fn() }, aborted: false, steered: false, failure: undefined } as never;
    });

    const manager = new AgentManager(undefined, 2);
    cleanupManagers.push(manager);

    const parentId = manager.spawn({} as never, { cwd, sessionManager: { getSessionId: () => "session-1" } } as never, "parent", "fan out", {
      description: "parent", isBackground: true,
    } as never);
    await new Promise((r) => setTimeout(r, 20));

    const parentRecord = manager.getRecord(parentId) as AgentRecord & { rootSessionId?: string };
    parentRecord.rootSessionId = "session-1";

    const tools = createNestedSubagentTools({
      manager: manager as never,
      pi: {} as never,
      parentAgentId: parentId,
      depth: 1,
      maxSubagentDepth: 2,
      allowedSubagents: "all",
      configCwd: cwd,
    });

    const agentTool = tools.find((t) => t.name === "Agent")!;
    const result = await agentTool.execute(
      "call-1",
      { prompt: "do a nested thing", description: "child", subagent_type: "child" },
      undefined, undefined, { cwd } as never,
    );
    await new Promise((r) => setTimeout(r, 40));

    const children = manager.listAgents().filter((r) => r.parentAgentId === parentId);
    expect(children.length).toBeGreaterThan(0);
    for (const child of children) {
      expect(child.transcriptPath).toBeTruthy();
      expect(child.historyFile).toBeTruthy();
    }
    void result;
  });

  /**
   * The durable transcript has to receive the whole conversation, not just the
   * opening prompt — otherwise a finished child's viewer rebuilds empty once the
   * live session is released.
   */
  it("streams the child's whole conversation into its durable transcript", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "nested-stream-"));
    cleanupDirs.push(cwd);

    mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "agents", "child.md"),
      "---\nname: child\ndescription: a nested child agent\nallowed_subagents: all\n---\nbody\n",
      "utf-8",
    );

    registerAgents(new Map([["parent", {
      name: "parent",
      description: "parent agent",
      allowedSubagents: "all",
      extensions: true,
      excludeTools: [],
      rootSessionId: "session-1",
    } as never]]));

    // A session whose messages grow after creation, so streaming has work to do.
    // Mimic the real runAgent contract: hand back a session whose message list
    // grows after onSessionCreated has already wired the transcript stream.
    vi.mocked(runAgent).mockImplementation(async (_ctx: unknown, _type: unknown, _prompt: unknown, options: any) => {
      const messages: unknown[] = [{ role: "user", content: "do a nested thing" }];
      let notify: ((event: { type: string }) => void) | undefined;
      const session = {
        messages,
        subscribe: (fn: (event: { type: string }) => void) => { notify = fn; return () => {}; },
        dispose: vi.fn(),
        steer: async () => {},
        prompt: async () => {},
        abort: () => {},
      };
      options?.onSessionCreated?.(session);
      messages.push({ role: "assistant", content: [{ type: "text", text: "child answer" }] });
      notify?.({ type: "turn_end" });
      return { responseText: "child answer", session, aborted: false, steered: false, failure: undefined } as never;
    });

    const manager = new AgentManager(undefined, 2);
    cleanupManagers.push(manager);

    const parentId = manager.spawn({} as never, { cwd, sessionManager: { getSessionId: () => "session-1" } } as never, "parent", "fan out", {
      description: "parent", isBackground: true,
    } as never);
    await new Promise((r) => setTimeout(r, 20));
    const parentRecord = manager.getRecord(parentId) as AgentRecord & { rootSessionId?: string };
    parentRecord.rootSessionId = "session-1";

    const tools = createNestedSubagentTools({
      manager: manager as never, pi: {} as never, parentAgentId: parentId, depth: 1,
      maxSubagentDepth: 2, allowedSubagents: "all", configCwd: cwd,
    });
    const agentTool = tools.find((t) => t.name === "Agent")!;
    await agentTool.execute(
      "call-2",
      // run_in_background exercises the detached path, whose onSessionCreated can
      // fire before attachTranscript() runs if the id is not captured synchronously.
      { prompt: "do a nested thing", description: "child", subagent_type: "child", run_in_background: true },
      undefined, undefined, { cwd } as never,
    );
    await new Promise((r) => setTimeout(r, 60));

    const child = manager.listAgents().find((r) => r.parentAgentId === parentId)!;
    expect(child.historyFile).toBeTruthy();
    const lines = readFileSync(child.historyFile!, "utf-8").trim().split("\n").filter(Boolean);
    // prompt + at least one assistant/tool entry, not just the prompt
    expect(lines.length).toBeGreaterThan(1);
  });
});
