import { describe, expect, it, vi } from "vitest";

// Captures the config handed to pi's createAgentSession so we can assert what a
// real child session receives. Everything above that seam is the real code under
// test — the rest of the suite mocks runAgent entirely, so nothing else checks
// that nested tools actually reach the session boundary.
const captured: { config: Record<string, unknown> | undefined } = { config: undefined };

vi.mock("@earendil-works/pi-coding-agent", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@earendil-works/pi-coding-agent");
  return {
    ...actual,
    createAgentSession: (config: Record<string, unknown>) => {
      captured.config = config;
      return {
        sessionId: "s1",
        messages: [],
        model: { name: "test-model", id: "test-model" },
        thinkingLevel: "off",
        subscribe: () => () => {},
        dispose: () => {},
        setSessionName: () => {},
        steer: async () => {},
        abort: () => {},
      };
    },
  };
});

const { AgentManager } = await import("../src/agent-manager.js");
const { registerAgents, getAgentConfig } = await import("../src/agent-types.js");
const { loadCustomAgents } = await import("../src/custom-agents.js");

const PROJECT_CWD = "/nfs/ev02_sdb/home/Andy6/research/breeding_support_system-wip-ffp-offspringlevel-generalization";

const piStub = { exec: async () => ({ code: 1, stdout: "", stderr: "" }) };
const ctxStub = {
  cwd: PROJECT_CWD,
  getSystemPrompt: () => "test",
  hasUI: false,
  model: undefined,
  modelRegistry: { runtime: undefined },
};

describe("nested tools reach a real child session", () => {
  it("passes all three nested tools through customTools without excluding them", async () => {
    // Load the registry exactly the way the extension does at startup, from the
    // real project cwd, so this exercises the live path rather than a fixture.
    registerAgents(loadCustomAgents(PROJECT_CWD));
    const liveConfig = getAgentConfig("fanout-demo") as unknown as { allowedSubagents?: unknown; description?: string } | undefined;
    expect(liveConfig?.allowedSubagents).toBe("all");

    const manager = new AgentManager(undefined, 2);
    captured.config = undefined;

    manager.spawn(piStub as never, ctxStub as never, "fanout-demo", "do the thing", {
      description: "fan-out",
      isBackground: true,
    } as never);

    // loader.reload() does a real filesystem scan of the agent dir, so this
    // waits for it rather than assuming an immediate hand-off.
    await new Promise((resolve) => setTimeout(resolve, 20_000));

    const names = ((captured.config?.customTools ?? []) as { name: string }[]).map((tool) => tool.name);

    expect(names).toContain("Agent");
    expect(names).toContain("wait_for_nested_agent");
    expect(names).toContain("steer_subagent");

    // pi filters custom tools by excludedToolNames; the nested trio must not be
    // in it, or they would be dropped when the registry is built.
    const excluded = (captured.config?.excludeTools ?? []) as string[];
    for (const tool of ["Agent", "wait_for_nested_agent", "steer_subagent"]) {
      expect(excluded).not.toContain(tool);
    }

    manager.dispose();
  }, 120_000);
});