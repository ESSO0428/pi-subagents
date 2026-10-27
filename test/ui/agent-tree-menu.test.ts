import type { TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { AgentViewMode } from "../../src/agent-history-list.js";
import type { AgentTreeKey, WorkflowTreeRoot } from "../../src/agent-tree.js";
import type { AgentRecord } from "../../src/types.js";
import {
  AgentTreeMenu,
  type AgentTreeMenuSelection,
  type AgentTreeMenuSource,
  createAgentTreeMenuState,
} from "../../src/ui/agent-tree-menu.js";
import type { Theme } from "../../src/ui/agent-widget.js";

function agent(overrides: Partial<AgentRecord> & { id: string }): AgentRecord {
  return {
    type: "Explore",
    description: overrides.id,
    status: "running",
    toolUses: 0,
    startedAt: 1,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    sessionId: "session-1",
    session: {} as AgentRecord["session"],
    ...overrides,
  };
}

function workflow(overrides: Partial<WorkflowTreeRoot> & { id: string }): WorkflowTreeRoot {
  return {
    artifactRootCwd: "/project/default",
    rootSessionId: "session-1",
    name: overrides.id,
    description: overrides.id,
    status: "running",
    startedAt: 1,
    doneCount: 0,
    agentCount: 0,
    tokens: 0,
    ...overrides,
  };
}

const theme: Theme = {
  fg: (_color, text) => text,
  bold: text => text,
};

function makeMenu(
  source: AgentTreeMenuSource,
  state = createAgentTreeMenuState(),
  visibleRows = 10,
) {
  const requestRender = vi.fn();
  const selections: Array<AgentTreeMenuSelection | undefined> = [];
  const menu = new AgentTreeMenu(
    { requestRender } as unknown as TUI,
    theme,
    () => source,
    state,
    selection => selections.push(selection),
    visibleRows,
  );
  return { menu, requestRender, selections, state };
}

const resolveViewMode = (record: AgentRecord): AgentViewMode | undefined => {
  if ((record.status === "running" || record.status === "queued") && record.session) return "live";
  if (record.status !== "running" && record.status !== "queued" && record.session) return "history";
  return undefined;
};

describe("AgentTreeMenu", () => {
  it("renders the shared workflow, real-agent, and nested hierarchy", () => {
    const source: AgentTreeMenuSource = {
      agents: [
        agent({ id: "child", parentAgentId: "wf-1" }),
        agent({ id: "nested", parentAgentId: "child" }),
        agent({ id: "other-session", sessionId: "session-2" }),
        agent({ id: "closed", status: "completed", session: undefined }),
      ],
      workflowRoots: [workflow({
        id: "wf-1",
        description: "Review changes",
        status: "completed",
        startedAt: 1000,
        completedAt: 3500,
        doneCount: 1,
        agentCount: 2,
        tokens: 12345,
      })],
      sessionId: "session-1",
      resolveViewMode,
    };
    const { menu } = makeMenu(source);

    const rendered = menu.render(160).join("\n");

    expect(rendered).toContain("workflow  Review changes");
    expect(rendered).toContain("Review changes · completed · 1/2 done · 12.3k token · 2.5s");
    expect(rendered).toContain("└─ → ▾");
    expect(rendered).toContain("Explore  child");
    expect(rendered).toContain("Explore  nested");
    expect(rendered).not.toContain("other-session");
    expect(rendered).not.toContain("closed");
  });

  it("filters same-shape live and restored roots to the current artifact root", () => {
    const source: AgentTreeMenuSource = {
      agents: [],
      workflowRoots: [
        workflow({ id: "live-a", artifactRootCwd: "/project/a" }),
        workflow({ id: "restored-a", artifactRootCwd: "/project/a", restoredHistory: true }),
        workflow({ id: "live-b", artifactRootCwd: "/project/b" }),
        workflow({ id: "restored-b", artifactRootCwd: "/project/b", restoredHistory: true }),
      ],
      artifactRootCwd: "/project/a",
      resolveViewMode,
    };
    const { menu } = makeMenu(source);

    const rendered = menu.render(160).join("\n");

    expect(rendered).toContain("live-a");
    expect(rendered).toContain("restored-a");
    expect(rendered).not.toContain("live-b");
    expect(rendered).not.toContain("restored-b");

    source.artifactRootCwd = "/project/b";
    const switched = menu.render(160).join("\n");
    expect(switched).toContain("live-b");
    expect(switched).toContain("restored-b");
    expect(switched).not.toContain("live-a");
    expect(switched).not.toContain("restored-a");
  });

  it("renders real-agent metadata and live activity on one row", () => {
    const source: AgentTreeMenuSource = {
      agents: [agent({
        id: "metadata",
        description: "Inspect metadata",
        status: "completed",
        startedAt: 1000,
        completedAt: 4500,
        toolUses: 2,
        lifetimeUsage: { input: 1000, output: 250, cacheWrite: 50 },
        invocation: {
          modelName: "haiku",
          effectiveModelName: "claude-haiku",
          thinking: "high",
          effectiveThinking: "xhigh",
        },
        liveActivity: {
          activeTools: new Map([["tool-1", "read"]]),
          responseText: "Inspecting metadata",
          turnCount: 2,
          maxTurns: 5,
        },
      })],
      workflowRoots: [],
      sessionId: "session-1",
      resolveViewMode,
    };
    const { menu } = makeMenu(source);

    const line = menu.render(200).find(candidate => candidate.includes("Inspect metadata")) ?? "";

    expect(line).toContain("model: claude-haiku");
    expect(line).toContain("requested model: haiku");
    expect(line).toContain("thinking: xhigh");
    expect(line).toContain("requested thinking: high");
    expect(line).toContain("2 tool uses");
    expect(line).toContain("1.3k token");
    expect(line).toContain("3.5s");
    expect(line).toContain("activity: reading…");
    expect(menu.render(200).filter(candidate => candidate.includes("Inspect metadata"))).toHaveLength(1);
  });

  it("keeps row identity and description ahead of optional metadata when narrow", () => {
    const source: AgentTreeMenuSource = {
      agents: [agent({
        id: "narrow",
        description: "Keep description visible",
        invocation: { effectiveModelName: "claude-sonnet", thinking: "high" },
        lifetimeUsage: { input: 1000, output: 250, cacheWrite: 50 },
      })],
      workflowRoots: [],
      sessionId: "session-1",
      resolveViewMode,
    };
    const { menu } = makeMenu(source);

    const line = menu.render(48).find(candidate => candidate.includes("Keep description")) ?? "";

    expect(line).toContain("Explore  Keep description visible");
    expect(line).not.toContain("model:");
  });

  it("uses shared left/right folding and dispatches roots and real Agent Views", () => {
    const source: AgentTreeMenuSource = {
      agents: [agent({ id: "child", parentAgentId: "wf-1" })],
      workflowRoots: [workflow({ id: "wf-1" })],
      sessionId: "session-1",
      resolveViewMode,
    };
    const first = makeMenu(source);
    first.menu.render(120);

    first.menu.handleInput("\x1b[D");
    expect(first.state.collapsedKeys).toEqual(new Set<AgentTreeKey>(["workflow:wf-1"]));
    expect(first.menu.render(120).join("\n")).not.toContain("Explore  child");

    first.menu.handleInput("\x1b[C");
    first.menu.handleInput("\x1b[B");
    first.menu.handleInput("\r");
    expect(first.selections).toEqual([{ kind: "agent", id: "child", mode: "live" }]);

    const rootState = createAgentTreeMenuState();
    const root = makeMenu(source, rootState);
    root.menu.render(120);
    root.menu.handleInput("\r");
    expect(root.selections).toEqual([{ kind: "workflow", id: "wf-1" }]);
  });

  it("ignores Enter for an agent without a usable conversation and closes on Esc", () => {
    const source: AgentTreeMenuSource = {
      agents: [agent({ id: "queued", status: "queued", session: undefined })],
      workflowRoots: [],
      sessionId: "session-1",
      resolveViewMode,
    };
    const { menu, selections } = makeMenu(source);
    menu.render(120);

    menu.handleInput("\r");
    expect(selections).toEqual([]);
    menu.handleInput("\x1b");
    expect(selections).toEqual([undefined]);
  });

  it("restores stable selection and viewport when the modal is reopened", () => {
    const source: AgentTreeMenuSource = {
      agents: Array.from({ length: 8 }, (_, index) => agent({ id: `agent-${index}` })),
      workflowRoots: [],
      sessionId: "session-1",
      resolveViewMode,
    };
    const state = createAgentTreeMenuState();
    const first = makeMenu(source, state, 3);
    first.menu.render(120);
    for (let index = 0; index < 5; index++) first.menu.handleInput("\x1b[B");
    const selectedKey = state.selectedKey;
    const viewportStart = state.viewportStart;

    const reopened = makeMenu(source, state, 3);
    const rendered = reopened.menu.render(120).find(line => line.includes("→"));

    expect(selectedKey).toBe("agent:agent-5");
    expect(viewportStart).toBe(3);
    expect(state.selectedKey).toBe(selectedKey);
    expect(state.viewportStart).toBe(viewportStart);
    expect(rendered).toContain("agent-5");
  });
});
