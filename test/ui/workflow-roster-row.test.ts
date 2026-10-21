import { describe, expect, it, vi } from "vitest";
import type { AgentManager } from "../../src/agent-manager.js";
import type { AgentTreeRow, WorkflowTreeRoot } from "../../src/agent-tree.js";
import type { AgentRecord } from "../../src/types.js";
import { AgentWidget, type Theme } from "../../src/ui/agent-widget.js";

const theme: Theme = { fg: (_color, text) => text, bold: text => text };

function makeAgent(overrides: Partial<AgentRecord> & { id: string }): AgentRecord {
  return {
    type: "explorer",
    description: overrides.id,
    status: "running",
    toolUses: 0,
    startedAt: 1,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    sessionId: "s1",
    ...overrides,
  };
}

function harness(
  roots: WorkflowTreeRoot[],
  agents: AgentRecord[] = [],
  canOpenHistory: (record: AgentRecord) => boolean = () => true,
  mode: "all" | "background" | "off" = "all",
) {
  const manager = { listAgents: () => agents } as unknown as AgentManager;
  let openedWorkflow: string | undefined;
  let openedAgent: string | undefined;
  const widget = new AgentWidget(manager, new Map(), () => mode, {
    canOpenHistory,
    onOpen: record => {
      openedAgent = record.id;
    },
    getSessionId: () => "s1",
    getWorkflowRoots: () => roots,
    onOpenWorkflow: id => {
      openedWorkflow = id;
    },
  });
  return {
    widget,
    rows: () => (widget as unknown as { rosterRows(): readonly AgentTreeRow[] }).rosterRows(),
    render: () => (widget as unknown as {
      renderWidget(tui: unknown, theme: Theme): string[];
    }).renderWidget({ terminal: { columns: 200, rows: 24 } }, theme),
    open: (key: `workflow:${string}` | `agent:${string}`) => {
      const target = widget as unknown as { selectedNodeKey: string; openSelected(): void };
      target.selectedNodeKey = key;
      target.openSelected();
    },
    openedWorkflow: () => openedWorkflow,
    openedAgent: () => openedAgent,
  };
}

const running: WorkflowTreeRoot = {
  id: "wf_1",
  name: "smoke",
  description: "Smoke run",
  status: "running",
  startedAt: 1,
  doneCount: 0,
  agentCount: 1,
  tokens: 0,
};

describe("a workflow grouping root in the roster", () => {
  it("shows a separate grouping node while running", () => {
    const rows = harness([running]).rows();

    expect(rows.map(row => row.key)).toEqual(["workflow:wf_1"]);
    expect(rows[0].node.kind).toBe("workflow");
  });

  it("keeps and renders the root after it settles without agent history", () => {
    const settled: WorkflowTreeRoot = {
      ...running,
      status: "completed",
      completedAt: 2,
      doneCount: 1,
      tokens: 500,
    };
    const h = harness([settled], [], () => false);

    expect(h.rows().map(row => row.key)).toEqual(["workflow:wf_1"]);
    expect(h.render().join("\n")).toContain("Smoke run");
    expect(h.render().join("\n")).toContain("completed");
    expect(h.render().join("\n")).toContain("1/1 done");
    expect(h.render().join("\n")).toContain("500 token");
  });

  it("keeps a failed root visible too", () => {
    const failed: WorkflowTreeRoot = { ...running, status: "failed", completedAt: 2 };

    expect(harness([failed]).rows()).toHaveLength(1);
    expect(harness([failed]).render().join("\n")).toContain("failed");
  });

  it("shows nothing when there are no roots", () => {
    expect(harness([]).rows()).toHaveLength(0);
  });

  it("opens the workflow inspector rather than a conversation", () => {
    const h = harness([{ ...running, status: "completed", completedAt: 2 }]);

    h.open("workflow:wf_1");

    expect(h.openedWorkflow()).toBe("wf_1");
    expect(h.openedAgent()).toBeUndefined();
  });

  it("forces an event redraw when workflow progress changes", () => {
    const settled = { ...running, status: "completed" as const, completedAt: 2 };
    const h = harness([settled]);
    let factory: ((tui: unknown, theme: Theme) => { render(): string[] }) | undefined;
    const tui = {
      terminal: { columns: 120, rows: 24 },
      requestRender: vi.fn(),
    };
    h.widget.setUICtx({
      setStatus: vi.fn(),
      setWidget: vi.fn((_key, content) => {
        factory = content as typeof factory;
      }),
      onTerminalInput: vi.fn(() => vi.fn()),
      getEditorText: () => "",
    });
    h.widget.update();
    factory?.(tui, theme).render();
    tui.requestRender.mockClear();

    settled.doneCount = 1;
    settled.tokens = 100;
    h.widget.update();

    expect(tui.requestRender).toHaveBeenCalledWith(true);
    h.widget.dispose();
  });
});

describe("a workflow's real agents", () => {
  const child = makeAgent({
    id: "wf-agent-0",
    description: "ping",
    parentAgentId: "wf_1",
  });

  it("projects the root, agent, and nested descendant in visible preorder", () => {
    const nested = makeAgent({
      id: "nested",
      description: "verify ping",
      parentAgentId: child.id,
    });
    const rows = harness([running], [child, nested], () => false).rows();

    expect(rows.map(row => row.key)).toEqual([
      "workflow:wf_1",
      "agent:wf-agent-0",
      "agent:nested",
    ]);
    expect(rows.map(row => row.depth)).toEqual([0, 1, 2]);
    expect(rows[1].node.kind).toBe("agent");
  });

  it("opens the agent's own view, not the workflow inspector", () => {
    const h = harness([running], [child], () => false);

    h.open("agent:wf-agent-0");

    expect(h.openedWorkflow()).toBeUndefined();
    expect(h.openedAgent()).toBe("wf-agent-0");
  });

  it("keeps explicitly foreground workflow children in background mode", () => {
    const foregroundChild = makeAgent({
      ...child,
      id: "foreground-child",
      description: "foreground workflow child",
      isBackground: false,
    });
    const output = harness([running], [foregroundChild], () => false, "background")
      .render()
      .join("\n");

    expect(output).toContain("Smoke run");
    expect(output).toContain("foreground workflow child");
  });
});

describe("workflow root rendering", () => {
  it("uses a literal workflow label and does not borrow an agent prompt mode", () => {
    const output = harness([running]).render().join("\n");

    expect(output).toContain("workflow");
    expect(output).toContain("Smoke run");
    expect(output).toContain("running");
    expect(output).not.toContain("(twin)");
  });

  it("does not stamp the workflow label onto an ordinary agent", () => {
    const ordinary = makeAgent({ id: "a1", description: "an ordinary agent" });
    const output = harness([], [ordinary]).render().join("\n");

    expect(output).toContain("an ordinary agent");
    expect(output).not.toContain("workflow");
  });
});
