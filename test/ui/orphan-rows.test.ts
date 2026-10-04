import { Editor } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { AgentManager } from "../../src/agent-manager.js";
import type { AgentRecord } from "../../src/types.js";
import { AgentWidget, type Theme } from "../../src/ui/agent-widget.js";

const theme: Theme = { fg: (_c, t) => t, bold: (t) => t };

function makeRecord(over: Partial<AgentRecord> & { id: string }): AgentRecord {
  return {
    description: over.id,
    type: "build",
    status: "completed",
    startedAt: 0,
    completedAt: 1000,
    toolUses: 1,
    lifetimeUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    ...over,
  } as AgentRecord;
}

function harness(records: AgentRecord[]) {
  const manager = { listAgents: () => records } as unknown as AgentManager;
  const tui = { terminal: { columns: 100, rows: 24 }, requestRender: vi.fn(), focusedComponent: Object.create(Editor.prototype) as Editor };
  let factory: ((t: any, th: Theme) => { render(): string[] }) | undefined;
  const ui = {
    setStatus: vi.fn(),
    setWidget: vi.fn((_k: string, c: any) => { factory = c; }),
    onTerminalInput: vi.fn(() => vi.fn()),
    getEditorText: vi.fn(() => ""),
  };
  const widget = new AgentWidget(manager, new Map(), () => "all", {
    canOpenHistory: () => true,
    onOpen: () => {},
  });
  widget.setUICtx(ui);
  widget.update();
  factory?.(tui, theme);
  return () => factory?.(tui, theme).render() ?? [];
}

describe("orphan nested rows", () => {
  it("keeps an orphaned child at its original depth instead of flattening it", () => {
    // The parent record is gone from the manager; only the child remains.
    const orphan = makeRecord({
      id: "orphan-1",
      description: "left behind",
      parentAgentId: "parent-gone",
      parentDescription: "the parent",
      depth: 2,
    });
    const root = makeRecord({ id: "root-1", description: "unrelated" });

    const lines = harness([root, orphan])();

    const orphanLine = lines.find((l) => l.includes("left behind"))!;
    // depth 2 → two ancestor continuation bars before the branch glyph
    expect(orphanLine).toMatch(/^│ {2}[├└]─/);
    // root-1 stays flush at depth 0
    expect(lines.find((l) => l.includes("unrelated"))!).toMatch(/^[├└]─/);
    // and the row says why it sits there alone
    expect(orphanLine).toContain("parent the parent is gone");
  });

  it("leaves a row with a live parent untouched", () => {
    const parent = makeRecord({ id: "p", description: "parent", status: "running", completedAt: undefined });
    const child = makeRecord({ id: "c", description: "child row", parentAgentId: "p", parentDescription: "parent", depth: 2 });
    const lines = harness([parent, child])();
    const childLine = lines.find((l) => l.includes("child row"))!;
    expect(childLine).not.toContain("is gone");
  });
});
