import { Editor } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../../src/agent-manager.js";
import type { AgentRecord } from "../../src/types.js";
import {
  type AgentActivity,
  AgentWidget,
  type AgentWidgetOpenMode,
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
    onTerminalInput: vi.fn(() => vi.fn()),
    getEditorText: vi.fn(() => ""),
  };
  const widget = new AgentWidget(manager, new Map(), () => "all");
  widget.setUICtx(ui);
  widget.update();
  factory?.(tui, theme).render();
  tui.requestRender.mockClear();
  return { records, tui, ui, widget, render: () => factory?.(tui, theme).render() ?? [] };
}

function createNavigableWidgetHarness(
  records: AgentRecord[],
  overrides: {
    onOpen?: (record: AgentRecord, mode: AgentWidgetOpenMode) => void;
    canOpenHistory?: (record: AgentRecord) => boolean;
    rows?: number;
  } = {},
) {
  const manager = { listAgents: () => records } as unknown as AgentManager;
  let inputHandler: ((data: string) => { consume?: boolean; data?: string } | undefined) | undefined;
  let text = "";
  const tui = {
    terminal: { columns: 120, rows: overrides.rows ?? 24 },
    requestRender: vi.fn(),
    focusedComponent: Object.create(Editor.prototype) as Editor,
  };
  let factory: ((tui: any, theme: Theme) => { render(): string[]; invalidate(): void }) | undefined;
  const ui = {
    setStatus: vi.fn(),
    setWidget: vi.fn((_key: string, content: any) => { factory = content; }),
    onTerminalInput: vi.fn((handler: (data: string) => { consume?: boolean; data?: string } | undefined) => {
      inputHandler = handler;
      return vi.fn();
    }),
    getEditorText: vi.fn(() => text),
  };
  const widget = new AgentWidget(manager, new Map(), () => "all", {
    canOpenHistory: overrides.canOpenHistory ?? ((record) => record.status !== "running" && record.status !== "queued"),
    onOpen: overrides.onOpen ?? (() => {}),
  });
  widget.setUICtx(ui);
  widget.update();
  const component = factory?.(tui, theme);
  return {
    tui,
    ui,
    widget,
    input: (data: string) => inputHandler?.(data),
    render: () => component?.render() ?? [],
    get text() { return text; },
    set text(value: string) { text = value; },
  };
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

  it("activates only on down at an empty focused editor", () => {
    const running = makeRecord({ id: "running", status: "running", completedAt: undefined });
    const harness = createNavigableWidgetHarness([running]);

    expect(harness.input("\u001b[A")).toBeUndefined();
    expect(harness.input("\u001b[B")).toEqual({ consume: true });
    expect(harness.render().join("\n")).toContain("Inspect the repository");
    harness.widget.dispose();
  });

  it("does not capture editor history navigation when inactive or non-empty", () => {
    const running = makeRecord({ id: "running", status: "running", completedAt: undefined });
    const harness = createNavigableWidgetHarness([running]);
    harness.text = "draft";

    expect(harness.input("\u001b[B")).toBeUndefined();
    expect(harness.input("\u001b[A")).toBeUndefined();
    harness.widget.dispose();
  });

  it("navigates with arrows and opens a selected running agent in live mode", () => {
    const running = makeRecord({ id: "running", status: "running", completedAt: undefined });
    const history = makeRecord({ id: "history", description: "saved history" });
    const opened: Array<{ id: string; mode: AgentWidgetOpenMode }> = [];
    const harness = createNavigableWidgetHarness([running, history], {
      onOpen: (record, mode) => opened.push({ id: record.id, mode }),
      canOpenHistory: (record) => record.id === "history",
    });

    harness.input("\u001b[B");
    harness.input("\u001b[B");
    expect(harness.input("\u001b[A")).toEqual({ consume: true });
    expect(harness.input("\r")).toEqual({ consume: true });
    expect(opened).toEqual([{ id: "running", mode: "live" }]);
    harness.widget.dispose();
  });

  it("opens terminal records in history mode and queued records in live mode", () => {
    const running = makeRecord({ id: "running", status: "running", completedAt: undefined });
    const history = makeRecord({ id: "history" });
    const queued = makeRecord({ id: "queued", status: "queued", completedAt: undefined, session: undefined });
    const opened: Array<{ id: string; mode: AgentWidgetOpenMode }> = [];
    const harness = createNavigableWidgetHarness([running, history, queued], {
      onOpen: (record, mode) => opened.push({ id: record.id, mode }),
      canOpenHistory: (record) => record.id === "history",
    });

    harness.input("\u001b[B");
    harness.input("\u001b[B");
    harness.input("\u001b[B");
    harness.input("\r");
    expect(opened).toEqual([{ id: "history", mode: "history" }]);
    harness.input("\u001b[B");
    harness.input("\u001b[B");
    harness.input("\r");
    expect(opened).toEqual([
      { id: "history", mode: "history" },
      { id: "queued", mode: "live" },
    ]);
    harness.widget.dispose();
  });

  it("exits navigation with escape or up from the first row, and ignores j/k/left", () => {
    const running = makeRecord({ id: "running", status: "running", completedAt: undefined });
    const harness = createNavigableWidgetHarness([running]);

    expect(harness.input("j")).toBeUndefined();
    expect(harness.input("k")).toBeUndefined();
    expect(harness.input("\u001b[D")).toBeUndefined();
    harness.input("\u001b[B");
    expect(harness.input("\u001b")).toEqual({ consume: true });
    harness.input("\u001b[B");
    expect(harness.input("\u001b[A")).toEqual({ consume: true });
    expect(harness.input("\u001b[B")).toEqual({ consume: true });
    harness.widget.dispose();
  });

  it("keeps hidden rows selectable inside the bounded viewport", () => {
    const running = makeRecord({ id: "running", status: "running", completedAt: undefined });
    const queued = Array.from({ length: 8 }, (_, index) => makeRecord({
      id: `queued-${index}`,
      description: `queued target ${index}`,
      status: "queued",
      completedAt: undefined,
    }));
    const harness = createNavigableWidgetHarness([running, ...queued], { rows: 8 });

    harness.input("\u001b[B");
    for (let index = 0; index < queued.length - 1; index++) harness.input("\u001b[B");
    expect(harness.render().join("\n")).toContain("queued target 7");
    expect(harness.render().length).toBeLessThanOrEqual(getWidgetLineBudget(8));
    harness.widget.dispose();
  });
});
