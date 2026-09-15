import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../../src/agent-manager.js";
import type { AgentRecord } from "../../src/types.js";
import {
  type AgentActivity,
  AgentWidget,
  getWidgetLineBudget,
  MAX_WIDGET_LINES,
  type Theme,
} from "../../src/ui/agent-widget.js";

const theme: Theme = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

const managers: AgentManager[] = [];

afterEach(() => {
  for (const manager of managers.splice(0)) manager.dispose();
});

function makeRecord(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "agent-1",
    type: "Explore",
    description: "Inspect the repository",
    status: "completed",
    toolUses: 0,
    startedAt: 1_000,
    completedAt: 2_000,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    ...overrides,
  };
}

function renderWidget(
  records: AgentRecord[],
  rows = 24,
  activity = new Map<string, AgentActivity>(),
  mode: "all" | "background" | "off" = "all",
) {
  const manager = { listAgents: () => records } as unknown as AgentManager;
  const widget = new AgentWidget(manager, activity, () => mode);
  const tui = { terminal: { columns: 200, rows } };
  const render = () => (widget as any).renderWidget(tui, theme) as string[];
  return { render, widget };
}

function createWidgetHarness(records: AgentRecord[]) {
  const manager = { listAgents: () => records } as unknown as AgentManager;
  let factory: ((tui: any, theme: Theme) => { render(): string[]; invalidate(): void }) | undefined;
  const tui = {
    terminal: { columns: 120, rows: 24 },
    requestRender: vi.fn(),
  };
  const ui = {
    setStatus: vi.fn(),
    setWidget: vi.fn((_key: string, content: any) => { factory = content; }),
  };
  const widget = new AgentWidget(manager, new Map(), () => "all");
  widget.setUICtx(ui);
  widget.update();
  factory?.(tui, theme).render();
  tui.requestRender.mockClear();
  return { records, tui, ui, widget, render: () => factory?.(tui, theme).render() ?? [] };
}

describe("AgentWidget live records", () => {
  it("keeps restored history in the live widget and manager history", () => {
    const manager = new AgentManager();
    managers.push(manager);
    manager.restoreCompleted([makeRecord({ id: "history", description: "restored history" })]);

    const widget = new AgentWidget(manager, new Map(), () => "all");
    const tui = { terminal: { columns: 120, rows: 24 } };

    expect((widget as any).renderWidget(tui, theme).join("\n")).toContain("restored history");
    expect(manager.listAgents().map(record => record.id)).toEqual(["history"]);
    expect(manager.getRecord("history")).toBeDefined();
  });

  it("keeps a live completed record visible after markFinished", () => {
    const record = makeRecord({ id: "live", description: "live completion" });
    const { render, widget } = renderWidget([record]);

    widget.markFinished(record.id);

    expect(render().join("\n")).toContain("live completion");
  });

  it("normalizes multiline rows and bounds output by the responsive ceiling", () => {
    const running = makeRecord({
      id: "running",
      status: "running",
      completedAt: undefined,
      description: "running\nsecond line",
    });
    const finished = makeRecord({
      id: "finished",
      description: "finished\nsecond line",
    });
    const extraFinished = Array.from({ length: 10 }, (_, i) => makeRecord({
      id: `finished-${i}`,
      description: `extra ${i}`,
    }));
    const activity = new Map<string, AgentActivity>([
      [running.id, {
        activeTools: new Map(),
        toolUses: 0,
        responseText: "activity\nsecond line",
        turnCount: 1,
        lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
      }],
    ]);
    const rows = 9;
    const { render } = renderWidget([running, finished, ...extraFinished], rows, activity);
    const lines = render();

    expect(lines.every(line => !/[\r\n]/.test(line))).toBe(true);
    expect(lines.length).toBeLessThanOrEqual(getWidgetLineBudget(rows));
    expect(lines.length).toBeLessThanOrEqual(MAX_WIDGET_LINES);
    expect(lines.join("\n")).toContain("running second line");
    expect(lines.some(line => line.includes("more"))).toBe(true);
  });

  it("counts queued records in the overflow indicator on short terminals", () => {
    const running = makeRecord({ id: "running", status: "running", completedAt: undefined });
    const queued = makeRecord({ id: "queued", status: "queued", completedAt: undefined });
    const { render } = renderWidget([running, queued], 6);

    const output = render().join("\\n");
    expect(output).toContain("+2 more");
    expect(output).toContain("1 queued");
  });

  it("reserves editor space on short terminals while retaining the widget ceiling", () => {
    expect(getWidgetLineBudget(9)).toBe(5);
    expect(getWidgetLineBudget(100)).toBe(MAX_WIDGET_LINES);
  });

  it("does not request a render when a live snapshot is unchanged", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    try {
      const running = makeRecord({ id: "running", status: "running", completedAt: undefined });
      const { widget, tui } = createWidgetHarness([running]);

      widget.update();
      expect(tui.requestRender).not.toHaveBeenCalled();

      running.description = "changed description";
      widget.update();
      expect(tui.requestRender).toHaveBeenCalledTimes(1);
      widget.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("exposes a safe render-only refresh target", () => {
    const running = makeRecord({ id: "running", status: "running", completedAt: undefined });
    const { widget, tui } = createWidgetHarness([running]);
    tui.requestRender.mockClear();

    expect((widget as any).requestUiRefresh(true)).toBe(true);
    expect(tui.requestRender).toHaveBeenCalledWith(true);
    widget.dispose();
    expect((widget as any).requestUiRefresh(true)).toBe(false);
  });
});
