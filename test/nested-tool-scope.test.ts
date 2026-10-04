import { describe, expect, it, vi } from "vitest";
import { installExtensionToolScope } from "../src/agent-runner.js";

/**
 * The scoped nested `Agent` and `steer_subagent` deliberately share their names
 * with EXCLUDED_TOOL_NAMES, so `inScope()` deletes them along with every other
 * orchestration tool. Without a re-admission they are dropped from the active
 * set by the first renarrow and `beforeToolCall` then rejects them, which is
 * what makes an opt-in nested agent see no nested tools at all.
 */
describe("installExtensionToolScope re-admits injected tools", () => {
  function fakeSession(allTools: string[], active: string[]) {
    const setActive = vi.fn((names: string[]) => { active.length = 0; active.push(...names); });
    const beforeToolCall = vi.fn();
    return {
      session: {
        getAllTools: () => allTools.map((name) => ({ name })),
        getActiveToolNames: () => [...active],
        setActiveToolsByName: setActive,
        subscribe: vi.fn(),
        agent: { beforeToolCall },
      } as never,
      beforeToolCall,
      setActive,
    };
  }

  const loader = { getExtensions: () => ({ extensions: [] }) } as never;

  it("keeps an injected nested Agent and steer_subagent active", () => {
    const all = ["read", "bash", "Agent", "get_subagent_result", "steer_subagent", "subagent_wait_group", "wait_for_nested_agent"];
    const active = [...all];
    const harness = fakeSession(all, active);

    installExtensionToolScope(harness.session, {
      loader,
      toolNames: ["read", "bash", "Agent", "get_subagent_result", "steer_subagent", "subagent_wait_group", "wait_for_nested_agent"],
      disallowedSet: undefined,
      extNames: new Set(),
      narrowing: new Map(),
      readmitToolNames: new Set(["Agent", "steer_subagent", "wait_for_nested_agent"]),
    });

    expect(active).toContain("Agent");
    expect(active).toContain("steer_subagent");
    expect(active).toContain("wait_for_nested_agent");
    // The global orchestration tools stay denied.
    expect(active).not.toContain("get_subagent_result");
    expect(active).not.toContain("subagent_wait_group");
  });

  it("still honours disallowed_tools over an opt-in nested tool of the same name", () => {
    const all = ["read", "Agent", "steer_subagent"];
    const active = [...all];
    const harness = fakeSession(all, active);

    installExtensionToolScope(harness.session, {
      loader,
      toolNames: ["read", "Agent", "steer_subagent"],
      disallowedSet: new Set(["Agent"]),
      extNames: new Set(),
      narrowing: new Map(),
      // The caller pre-filters readmitToolNames against disallowed_tools.
      readmitToolNames: new Set(["steer_subagent"]),
    });

    expect(active).not.toContain("Agent");
    expect(active).toContain("steer_subagent");
  });
});