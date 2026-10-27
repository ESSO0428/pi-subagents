import { describe, expect, it } from "vitest";
import {
  type AgentTreeKey,
  navigateAgentTree,
  projectAgentTree,
  type WorkflowTreeRoot,
} from "../src/agent-tree.js";
import type { AgentRecord } from "../src/types.js";

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
    ...overrides,
  };
}

function workflow(overrides: Partial<WorkflowTreeRoot> & { id: string }): WorkflowTreeRoot {
  return {
    artifactRootCwd: "/project/default",
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

function project(
  agents: readonly AgentRecord[],
  workflowRoots: readonly WorkflowTreeRoot[] = [],
  collapsedKeys: ReadonlySet<AgentTreeKey> = new Set(),
  artifactRootCwd?: string,
) {
  return projectAgentTree({
    agents,
    workflowRoots,
    artifactRootCwd,
    collapsedKeys,
    canOpenTerminalAgent: () => true,
  });
}

describe("agent tree projection", () => {
  it("projects separate workflow roots, their real agents, and nested descendants in preorder", () => {
    const projection = project([
      agent({ id: "workflow-child", parentAgentId: "wf-1" }),
      agent({ id: "nested", parentAgentId: "workflow-child" }),
      agent({ id: "ordinary" }),
    ], [workflow({ id: "wf-1", description: "Review changes" })]);

    expect(projection.rows.map(row => row.key)).toEqual([
      "workflow:wf-1",
      "agent:workflow-child",
      "agent:nested",
      "agent:ordinary",
    ]);
    expect(projection.rows.map(row => row.depth)).toEqual([0, 1, 2, 0]);
    expect(projection.rows[1]).toMatchObject({
      parentKey: "workflow:wf-1",
      hasChildren: true,
      expanded: true,
      orphaned: false,
      cycle: false,
    });
    expect(projection.rows[0].node.kind).toBe("workflow");
    expect(projection.rows[1].node.kind).toBe("agent");
  });

  it("defaults to expanded and keeps user-collapsed roots collapsed when children change", () => {
    const root = workflow({ id: "wf-1" });
    const firstChild = agent({ id: "first", parentAgentId: root.id });

    expect(project([firstChild], [root]).rows.map(row => row.key)).toEqual([
      "workflow:wf-1",
      "agent:first",
    ]);

    const collapsed = new Set<AgentTreeKey>(["workflow:wf-1"]);
    const before = project([firstChild], [root], collapsed);
    const after = project([
      firstChild,
      agent({ id: "new-child", parentAgentId: root.id }),
    ], [root], collapsed);

    expect(before.rows.map(row => row.key)).toEqual(["workflow:wf-1"]);
    expect(after.rows.map(row => row.key)).toEqual(["workflow:wf-1"]);
    expect(after.rows[0]).toMatchObject({ hasChildren: true, expanded: false });
    expect([...collapsed]).toEqual(["workflow:wf-1"]);
  });

  it("scopes real agents to the session and filters terminal agents by openability", () => {
    const records = [
      agent({ id: "active", sessionId: "session-1" }),
      agent({ id: "open", status: "completed", completedAt: 2, sessionId: "session-1" }),
      agent({ id: "closed", status: "error", completedAt: 2, sessionId: "session-1" }),
      agent({ id: "other-session", sessionId: "session-2" }),
    ];

    const projection = projectAgentTree({
      agents: records,
      workflowRoots: [workflow({ id: "settled", status: "completed", completedAt: 2, rootSessionId: "session-1" })],
      sessionId: "session-1",
      canOpenTerminalAgent: record => record.id === "open",
    });

    expect(projection.rows.map(row => row.key)).toEqual([
      "agent:active",
      "workflow:settled",
      "agent:open",
    ]);
  });

  it("filters workflow roots to the exact current session when provenance exists", () => {
    const roots = [
      workflow({ id: "current", rootSessionId: "session-current" }),
      workflow({ id: "old", rootSessionId: "session-old" }),
      workflow({ id: "unknown" }),
    ];

    expect(projectAgentTree({
      agents: [],
      workflowRoots: roots,
      sessionId: "session-current",
      canOpenTerminalAgent: () => true,
    }).rows.map(row => row.key)).toEqual(["workflow:current"]);
  });

  it("filters live and restored roots to the current artifact root", () => {
    const projectA = "/project/a";
    const projectB = "/project/b";
    const missingRoot = { ...workflow({ id: "missing" }), artifactRootCwd: undefined } as unknown as WorkflowTreeRoot;
    const roots = [
      workflow({ id: "live-a", artifactRootCwd: projectA }),
      workflow({ id: "restored-a", artifactRootCwd: projectA, restoredHistory: true }),
      workflow({ id: "live-b", artifactRootCwd: projectB }),
      workflow({ id: "restored-b", artifactRootCwd: projectB, restoredHistory: true }),
      missingRoot,
    ];

    expect(project([], roots, new Set(), projectA).rows.map(row => row.key)).toEqual([
      "workflow:live-a",
      "workflow:restored-a",
    ]);
    expect(project([], roots, new Set(), projectB).rows.map(row => row.key)).toEqual([
      "workflow:live-b",
      "workflow:restored-b",
    ]);
  });

  it("keeps owned descendants in background mode while excluding known foreground roots", () => {
    const projection = projectAgentTree({
      agents: [
        agent({ id: "foreground", isBackground: false }),
        agent({ id: "nested", parentAgentId: "foreground", isBackground: false }),
        agent({ id: "workflow-child", parentAgentId: "wf-1", isBackground: false }),
        agent({ id: "background", isBackground: true }),
      ],
      workflowRoots: [workflow({ id: "wf-1" })],
      mode: "background",
      canOpenTerminalAgent: () => true,
    });

    expect(projection.rows.map(row => row.key)).toEqual([
      "workflow:wf-1",
      "agent:workflow-child",
      "agent:nested",
      "agent:background",
    ]);
    expect(projection.rows.find(row => row.key === "agent:nested")).toMatchObject({
      orphaned: true,
      parentKey: undefined,
    });
  });

  it("orders siblings by stable running, queued, terminal ranks", () => {
    const records = [
      agent({ id: "terminal", status: "completed", completedAt: 2, parentAgentId: "wf-1" }),
      agent({ id: "queued-1", status: "queued", parentAgentId: "wf-1" }),
      agent({ id: "running-1", parentAgentId: "wf-1" }),
      agent({ id: "queued-2", status: "queued", parentAgentId: "wf-1" }),
      agent({ id: "running-2", parentAgentId: "wf-1" }),
    ];

    expect(project(records, [workflow({ id: "wf-1" })]).rows.map(row => row.key)).toEqual([
      "workflow:wf-1",
      "agent:running-1",
      "agent:running-2",
      "agent:queued-1",
      "agent:queued-2",
      "agent:terminal",
    ]);
  });

  it("shows missing-parent and cycle records once as safe orphan rows", () => {
    const projection = project([
      agent({ id: "missing", parentAgentId: "gone", depth: 2 }),
      agent({ id: "missing-child", parentAgentId: "missing" }),
      agent({ id: "cycle-a", parentAgentId: "cycle-b" }),
      agent({ id: "cycle-b", parentAgentId: "cycle-a" }),
      agent({ id: "cycle-child", parentAgentId: "cycle-a" }),
      agent({ id: "self-cycle", parentAgentId: "self-cycle" }),
    ]);

    const keys = projection.rows.map(row => row.key);
    expect(keys).toEqual([
      "agent:missing",
      "agent:missing-child",
      "agent:cycle-a",
      "agent:cycle-child",
      "agent:cycle-b",
      "agent:self-cycle",
    ]);
    expect(new Set(keys).size).toBe(keys.length);
    expect(projection.rows.find(row => row.key === "agent:missing")).toMatchObject({
      depth: 2,
      parentKey: undefined,
      orphaned: true,
      cycle: false,
    });
    for (const key of ["agent:cycle-a", "agent:cycle-b", "agent:self-cycle"] as const) {
      expect(projection.rows.find(row => row.key === key)).toMatchObject({
        parentKey: undefined,
        orphaned: true,
        cycle: true,
      });
    }
    expect(projection.rows.find(row => row.key === "agent:cycle-child")).toMatchObject({
      parentKey: "agent:cycle-a",
      cycle: false,
    });
  });

  it("does not mutate records, input arrays, or collapse state", () => {
    const child = Object.freeze(agent({ id: "child", parentAgentId: "wf-1" }));
    const records = Object.freeze([child]);
    const root = Object.freeze(workflow({ id: "wf-1" }));
    const roots = Object.freeze([root]);
    const collapsed = new Set<AgentTreeKey>(["agent:stale"]);

    expect(() => projectAgentTree({
      agents: records,
      workflowRoots: roots,
      collapsedKeys: collapsed,
      canOpenTerminalAgent: () => true,
    })).not.toThrow();
    expect(records).toEqual([child]);
    expect(roots).toEqual([root]);
    expect([...collapsed]).toEqual(["agent:stale"]);
  });
});

describe("agent tree navigation", () => {
  const records = [
    agent({ id: "child", parentAgentId: "wf-1" }),
    agent({ id: "grandchild", parentAgentId: "child" }),
    agent({ id: "sibling" }),
  ];
  const root = workflow({ id: "wf-1" });

  it("moves up and down through visible preorder", () => {
    const projection = project(records, [root]);
    const collapsed = new Set<AgentTreeKey>();

    expect(navigateAgentTree(projection, "workflow:wf-1", collapsed, "down").selectedKey)
      .toBe("agent:child");
    expect(navigateAgentTree(projection, "agent:child", collapsed, "down").selectedKey)
      .toBe("agent:grandchild");
    expect(navigateAgentTree(projection, "agent:child", collapsed, "up").selectedKey)
      .toBe("workflow:wf-1");
    expect(navigateAgentTree(projection, "workflow:wf-1", collapsed, "up").selectedKey)
      .toBe("workflow:wf-1");
  });

  it("expands right, collapses left, and moves left to a visible parent", () => {
    const collapsed = new Set<AgentTreeKey>(["workflow:wf-1"]);
    const collapsedProjection = project(records, [root], collapsed);
    const expanded = navigateAgentTree(
      collapsedProjection,
      "workflow:wf-1",
      collapsed,
      "right",
    );

    expect([...expanded.collapsedKeys]).toEqual([]);
    expect([...collapsed]).toEqual(["workflow:wf-1"]);

    const expandedProjection = project(records, [root], expanded.collapsedKeys);
    const collapsedAgain = navigateAgentTree(
      expandedProjection,
      "workflow:wf-1",
      expanded.collapsedKeys,
      "left",
    );
    expect([...collapsedAgain.collapsedKeys]).toEqual(["workflow:wf-1"]);
    expect(collapsedAgain.selectedKey).toBe("workflow:wf-1");

    const toParent = navigateAgentTree(
      expandedProjection,
      "agent:grandchild",
      expanded.collapsedKeys,
      "left",
    );
    expect(toParent.selectedKey).toBe("agent:child");
  });

  it("never selects descendants hidden by collapse", () => {
    const collapsed = new Set<AgentTreeKey>(["workflow:wf-1"]);
    const projection = project(records, [root], collapsed);

    expect(projection.rows.map(row => row.key)).toEqual([
      "workflow:wf-1",
      "agent:sibling",
    ]);
    expect(navigateAgentTree(projection, "workflow:wf-1", collapsed, "down").selectedKey)
      .toBe("agent:sibling");
  });
});
