import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import { getAgentConfig, registerAgents, setFallbackSubagent } from "../src/agent-types.js";
import { loadCustomAgents } from "../src/custom-agents.js";
import { createNestedSubagentTools } from "../src/nested-tools.js";
import type { AgentRecord } from "../src/types.js";

vi.mock("../src/agent-runner.js", () => ({
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
}));
vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(),
  cleanupWorktree: vi.fn(() => ({ hasChanges: false })),
  pruneWorktrees: vi.fn(),
}));

import { runAgent } from "../src/agent-runner.js";

const pi = {} as never;
const ctx = { cwd: "/tmp" } as never;
const cleanupManagers: AgentManager[] = [];

function record(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "root",
    type: "Explore",
    description: "root task",
    status: "running",
    toolUses: 0,
    startedAt: 1,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    ...overrides,
  };
}

function writeAgent(cwd: string, name: string, frontmatter: string): void {
  const dir = join(cwd, ".pi", "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), `---\ndescription: ${name}\n${frontmatter}---\n${name}\n`);
}

describe("nested delegation policy", () => {
  let cwd: string;
  afterEach(() => {
    if (cwd) rmSync(cwd, { recursive: true, force: true });
    for (const manager of cleanupManagers.splice(0)) manager.dispose();
  });

  it("documents config precedence in the nested Agent schema", () => {
    const manager = {
      spawn: vi.fn(),
      spawnAndWait: vi.fn(),
      getRecord: () => undefined,
      resume: vi.fn(),
      reportNestedIssue: vi.fn(),
    };
    const [agent] = createNestedSubagentTools({
      manager,
      pi,
      parentAgentId: "parent",
      depth: 1,
      maxSubagentDepth: 2,
      allowedSubagents: "all",
      configCwd: "/tmp",
    });
    const properties = agent.parameters.properties;
    expect(agent.description).toContain("only fill fields left unspecified by the selected agent's frontmatter or agentOverrides");
    for (const name of ["model", "thinking", "max_turns", "inherit_context", "isolated", "isolation"]) {
      expect(properties[name].description).toContain("frontmatter or agentOverrides");
    }
    expect(properties.model.description).not.toContain("override");
    expect(properties.thinking.description).not.toContain("override");
    expect(properties.run_in_background.description).toContain("explicit tool-call value overrides");
  });

  it("parses allowlists without granting omitted or false values", () => {
    cwd = mkdtempSync(join(tmpdir(), "nested-policy-"));
    writeAgent(cwd, "omitted", "");
    writeAgent(cwd, "disabled", "allowed_subagents: false\n");
    writeAgent(cwd, "all", "allowed_subagents: all\n");
    writeAgent(cwd, "limited", "allowed_subagents: scout, reviewer\n");
    registerAgents(loadCustomAgents(cwd));

    expect(getAgentConfig("omitted")?.allowedSubagents).toBeUndefined();
    expect(getAgentConfig("disabled")?.allowedSubagents).toBeUndefined();
    expect(getAgentConfig("all")?.allowedSubagents).toBe("all");
    expect(getAgentConfig("limited")?.allowedSubagents).toEqual(["scout", "reviewer"]);
  });

  it("rejects unknown and out-of-list nested types without fallback", async () => {
    cwd = mkdtempSync(join(tmpdir(), "nested-tools-"));
    writeAgent(cwd, "scout", "");
    writeAgent(cwd, "reviewer", "");
    registerAgents(loadCustomAgents(cwd));
    const spawn = vi.fn();
    const manager = {
      spawn,
      spawnAndWait: vi.fn(),
      getRecord: () => undefined,
      resume: vi.fn(),
      reportNestedIssue: vi.fn(),
    };
    const [agent] = createNestedSubagentTools({
      manager,
      pi,
      parentAgentId: "parent",
      depth: 1,
      maxSubagentDepth: 2,
      allowedSubagents: ["scout"],
      configCwd: cwd,
    });

    const execute = (subagent_type: string) => agent.execute("call", {
      subagent_type, description: "test child", prompt: "work",
    }, undefined, undefined, { cwd, model: undefined, modelRegistry: { find: () => undefined } } as never);
    expect((await execute("reviewer")).isError).toBe(true);
    expect((await execute("missing")).isError).toBe(true);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("never applies a configured top-level fallback to nested resolution", async () => {
    cwd = mkdtempSync(join(tmpdir(), "nested-fallback-"));
    writeAgent(cwd, "scout", "");
    registerAgents(loadCustomAgents(cwd));
    setFallbackSubagent("scout");
    try {
      const manager = { spawn: vi.fn(), spawnAndWait: vi.fn(), getRecord: () => undefined, resume: vi.fn(), reportNestedIssue: vi.fn() };
      const [agent] = createNestedSubagentTools({ manager, pi, parentAgentId: "parent", depth: 1, maxSubagentDepth: 2, allowedSubagents: ["scout"], configCwd: cwd });
      const result = await agent.execute("call", { subagent_type: "missing", description: "bad", prompt: "work" }, undefined, undefined, { cwd, model: undefined, modelRegistry: { find: () => undefined } } as never);
      expect(result.isError).toBe(true);
      expect(manager.spawnAndWait).not.toHaveBeenCalled();
    } finally {
      setFallbackSubagent(undefined);
    }
  });

  it("fails closed at the depth cap and records ownership violations", async () => {
    const reportNestedIssue = vi.fn();
    const manager = {
      spawn: vi.fn(),
      spawnAndWait: vi.fn(),
      getRecord: (id: string) => id === "foreign" ? record({ id, parentAgentId: "other" }) : undefined,
      resume: vi.fn(),
      reportNestedIssue,
    };
    expect(createNestedSubagentTools({
      manager,
      pi,
      parentAgentId: "parent",
      depth: 2,
      maxSubagentDepth: 2,
      allowedSubagents: "all",
      configCwd: "/tmp",
    })).toHaveLength(0);

    const [agent, result, steer] = createNestedSubagentTools({
      manager,
      pi,
      parentAgentId: "parent",
      depth: 1,
      maxSubagentDepth: 2,
      allowedSubagents: "all",
      configCwd: "/tmp",
    });
    expect((await result.execute("call", { agent_id: "foreign" }, undefined, undefined, undefined)).isError).toBe(true);
    expect((await steer.execute("call", { agent_id: "foreign", message: "stop" }, undefined, undefined, undefined)).isError).toBe(true);
    expect((await agent.execute("call", { resume: "foreign", subagent_type: "Explore", description: "resume", prompt: "continue" }, undefined, undefined, { cwd: "/tmp", model: undefined, modelRegistry: { find: () => undefined } } as never)).isError).toBe(true);
    expect(reportNestedIssue).toHaveBeenCalledTimes(3);
  });

  it("leaves a nested child running when its parent settles, and does not charge a pool slot", async () => {
    let resolveParent!: (value: unknown) => void;
    vi.mocked(runAgent).mockImplementationOnce(() => new Promise(resolve => { resolveParent = resolve; }));
    vi.mocked(runAgent).mockImplementationOnce(() => new Promise(() => {}));
    const manager = new AgentManager(undefined, 1);
    cleanupManagers.push(manager);
    const parentId = manager.spawn(pi, ctx, "Explore", "parent", { description: "parent", isBackground: true });
    const childId = manager.spawn(pi, ctx, "Explore", "child", {
      description: "child", isBackground: true, parentAgentId: parentId, depth: 2, maxSubagentDepth: 2,
    });
    expect(manager.getRecord(childId)?.status).toBe("running");
    resolveParent({ responseText: "done", session: { dispose: vi.fn() }, aborted: false, steered: false });
    await Promise.resolve();
    await Promise.resolve();
    // Upstream does not cascade a parent's completion onto its children: a nested
    // spawn is one of the parent's own tool calls, and whether it waits or detaches
    // is the parent agent's choice. The child therefore keeps running.
    expect(manager.getRecord(childId)?.status).toBe("running");
  });

  it("uses the shared mode resolver for fresh and resumed nested agents", async () => {
    cwd = mkdtempSync(join(tmpdir(), "nested-modes-"));
    writeAgent(cwd, "blocking", "");
    writeAgent(cwd, "detached", "run_in_background: true\n");
    registerAgents(loadCustomAgents(cwd));

    const completed = (id: string): AgentRecord => record({
      id,
      type: id,
      parentAgentId: "parent",
      status: "completed",
      result: `${id} result`,
    });
    const spawn = vi.fn(() => "detached-id");
    const spawnAndWait = vi.fn(async (..._args: unknown[]) => ({ id: "blocking-id", record: completed("blocking") }));
    const getRecord = vi.fn((id: string) => id === "resume-id" ? completed("detached") : undefined);
    const resume = vi.fn(async () => completed("resume-id"));
    const manager = { spawn, spawnAndWait, getRecord, resume, reportNestedIssue: vi.fn() };
    const [agent] = createNestedSubagentTools({
      manager,
      pi,
      parentAgentId: "parent",
      depth: 1,
      maxSubagentDepth: 2,
      allowedSubagents: "all",
      configCwd: cwd,
    });
    const toolCtx = { cwd, model: undefined, modelRegistry: { find: () => undefined } } as never;

    await agent.execute("plain", { subagent_type: "blocking", description: "blocking", prompt: "work" }, undefined, undefined, toolCtx);
    expect(spawnAndWait).toHaveBeenCalledTimes(1);
    expect(spawn).not.toHaveBeenCalled();

    await agent.execute("frontmatter", { subagent_type: "detached", description: "detached", prompt: "work" }, undefined, undefined, toolCtx);
    expect(spawn).toHaveBeenCalledTimes(1);

    await agent.execute("override-false", { subagent_type: "detached", description: "blocking", prompt: "work", run_in_background: false }, undefined, undefined, toolCtx);
    expect(spawnAndWait).toHaveBeenCalledTimes(2);

    await agent.execute("override-true", { subagent_type: "blocking", description: "detached", prompt: "work", run_in_background: true }, undefined, undefined, toolCtx);
    expect(spawn).toHaveBeenCalledTimes(2);

    await agent.execute("resume", { resume: "resume-id", subagent_type: "detached", description: "resume", prompt: "continue" }, undefined, undefined, toolCtx);
    expect(resume).toHaveBeenCalledWith(
      "resume-id",
      "continue",
      expect.objectContaining({ create: expect.any(Function) }),
      expect.objectContaining({ kind: "nested", parentAgentId: "parent", artifactRootCwd: cwd }),
      expect.objectContaining({ isBackground: false }),
    );
    await agent.execute("resume-blocking", { resume: "resume-id", subagent_type: "detached", description: "resume", prompt: "continue", run_in_background: false }, undefined, undefined, toolCtx);
    expect(resume).toHaveBeenLastCalledWith(
      "resume-id",
      "continue",
      expect.objectContaining({ create: expect.any(Function) }),
      expect.objectContaining({ kind: "nested", parentAgentId: "parent", artifactRootCwd: cwd }),
      expect.objectContaining({ isBackground: false }),
    );
  });

  it("checks and waits only for owned nested results, consuming terminal retrieval", async () => {
    let resolveChild!: (value: string) => void;
    const childPromise = new Promise<string>(resolve => { resolveChild = resolve; });
    const child = record({ id: "child", parentAgentId: "parent", promise: childPromise });
    const foreign = record({ id: "foreign", parentAgentId: "other", status: "completed", result: "secret" });
    const manager = {
      spawn: vi.fn(),
      spawnAndWait: vi.fn(),
      getRecord: (id: string) => id === "child" ? child : id === "foreign" ? foreign : undefined,
      resume: vi.fn(),
      reportNestedIssue: vi.fn(),
    };
    const [, result] = createNestedSubagentTools({
      manager,
      pi,
      parentAgentId: "parent",
      depth: 1,
      maxSubagentDepth: 2,
      allowedSubagents: "all",
      configCwd: "/tmp",
    });

    const immediate = await result.execute("check", { agent_id: "child" }, undefined, undefined, undefined);
    expect(immediate.content[0]).toMatchObject({ type: "text", text: "Agent child is running." });
    expect(child.resultConsumed).not.toBe(true);

    const controller = new AbortController();
    const waiting = result.execute("wait", { agent_id: "child", wait: true }, controller.signal, undefined, undefined);
    controller.abort();
    await expect(waiting).rejects.toThrow(/aborted/i);
    expect(child.status).toBe("running");
    expect(child.resultConsumed).not.toBe(true);

    child.status = "completed";
    child.result = "child result";
    resolveChild("child result");
    const fetched = await result.execute("fetch", { agent_id: "child", wait: true }, undefined, undefined, undefined);
    expect(fetched.content[0]).toMatchObject({ type: "text", text: "child result" });
    expect(child.resultConsumed).toBe(true);

    const denied = await result.execute("foreign", { agent_id: "foreign" }, undefined, undefined, undefined);
    expect(denied.isError).toBe(true);
  });

  /**
   * `subagents.agentOverrides` is applied against the global registry at load
   * time. Without re-applying it to the config-derived map a nested child would
   * run the stock definition for a type whose top-level counterpart is
   * overridden — e.g. the model pinned for `Explore`.
   */
  it("applies subagents.agentOverrides to the nested registry", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "nested-overrides-"));
    try {
      mkdirSync(join(cwd, ".pi"), { recursive: true });
      writeFileSync(
        join(cwd, ".pi", "settings.json"),
        JSON.stringify({
          subagents: {
            agentOverrides: {
              Explore: { model: "test-provider/overridden-model" },
            },
          },
        }),
        "utf-8",
      );

      const spawned: { type: string; options: Record<string, unknown> }[] = [];
      const manager = {
        getRecord: () => undefined,
        reportNestedIssue: () => {},
        spawn: (_pi: unknown, _ctx: unknown, type: string, _prompt: string, options: Record<string, unknown>) => {
          spawned.push({ type, options });
          return "child-1";
        },
      } as never;

      const tools = createNestedSubagentTools({
        manager,
        pi: {} as never,
        parentAgentId: "parent",
        depth: 1,
        maxSubagentDepth: 2,
        allowedSubagents: "all",
        configCwd: cwd,
      });

      const agentTool = tools.find((t) => t.name === "Agent")!;
      await agentTool.execute(
        "call-override",
        { prompt: "look around", description: "child", subagent_type: "Explore", run_in_background: true },
        undefined, undefined, {
          cwd,
          model: undefined,
          modelRegistry: {
            getAvailable: () => [{ provider: "test-provider", id: "overridden-model" }],
            getAll: () => [{ provider: "test-provider", id: "overridden-model" }],
            find: (_p: string, id: string) => ({ provider: "test-provider", id }),
          },
        } as never,
      );

      expect(spawned.length).toBe(1);
      // The stock definition pins anthropic/claude-haiku-4-5; the override must win.
      // resolveModel turns an exact registry hit into the entry itself.
      const resolved = spawned[0].options.model as { provider?: string; id?: string } | string;
      expect(typeof resolved === "string" ? resolved : `${resolved.provider}/${resolved.id}`)
        .toBe("test-provider/overridden-model");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
