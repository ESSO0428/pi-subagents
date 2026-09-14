import { describe, expect, it, vi } from "vitest";
import {
  calculateFleetAgentWindow,
  ensureFleetSelectionVisible,
  FLEET_MAX_RENDER_ROWS,
  FleetList,
} from "../../src/ui/fleet-list.js";
import { canOpenActiveAgent } from "../../src/agent-history-list.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

function makeAgents(count: number): any[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `agent-${i}`,
    type: "Explore",
    description: `agent ${i}`,
    status: "running",
    session: { messages: [], subscribe: () => () => {} },
    toolUses: 0,
    startedAt: i + 1,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
  }));
}

function createFleetHarness(records: any[]) {
  const manager: any = {
    records,
    listAgents() { return this.records; },
    abort: vi.fn(() => false),
    steer: vi.fn(() => false),
  };
  const tui = { terminal: { rows: 24 }, requestRender: vi.fn() } as any;
  let terminalInput: ((data: string) => { consume?: boolean } | undefined) | undefined;
  let factory: any;
  let widget: any;
  const ui: any = {
    setWidget: vi.fn((_key: string, content: any) => { factory = content; }),
    onTerminalInput: (handler: typeof terminalInput) => {
      terminalInput = handler;
      return () => { terminalInput = undefined; };
    },
    getEditorText: () => "",
    notify: vi.fn(),
    custom: vi.fn(async () => undefined),
  };
  const fleet = new FleetList(manager, new Map());
  fleet.setUICtx(ui);
  fleet.update();
  const render = (width = 120) => {
    widget = factory ? factory(tui, theme) : undefined;
    return widget?.render(width) ?? [];
  };
  const input = (data: string) => terminalInput?.(data);
  const mouse = (wheelDelta: number) => widget?.handleMouse({ type: "wheel", wheelDelta });
  render(); // The real TUI invokes the widget factory before keyboard input arrives.
  return { manager, fleet, tui, ui, render, input, mouse, getWidget: () => widget };
}

describe("canOpenActiveAgent", () => {
  it("does not treat terminal records as active FleetView rows", () => {
    expect(canOpenActiveAgent({ status: "completed", session: {} } as any)).toBe(false);
    expect(canOpenActiveAgent({ status: "error", session: {} } as any)).toBe(false);
    expect(canOpenActiveAgent({ status: "running", session: {} } as any)).toBe(true);
    expect(canOpenActiveAgent({ status: "queued", session: undefined } as any)).toBe(false);
  });
});

describe("FleetView focus-preserving window", () => {
  it("does not move the window while the selected agent is visible", () => {
    expect(calculateFleetAgentWindow(12, 0)).toMatchObject({
      start: 0,
      end: 3,
      hiddenAbove: 0,
      hiddenBelow: 9,
    });
    expect(ensureFleetSelectionVisible(12, 0, 0)).toBe(0);
    expect(ensureFleetSelectionVisible(12, 1, 0)).toBe(0);
    expect(ensureFleetSelectionVisible(12, 2, 0)).toBe(0);
  });

  it("moves only enough to show a selected agent below the window", () => {
    const nextStart = ensureFleetSelectionVisible(12, 3, 0);
    expect(nextStart).toBe(2);
    const window = calculateFleetAgentWindow(12, nextStart);
    expect(3).toBeGreaterThanOrEqual(window.start);
    expect(3).toBeLessThan(window.end);
  });

  it("moves only enough to show a selected agent above the window", () => {
    const nextStart = ensureFleetSelectionVisible(12, 3, 4);
    expect(nextStart).toBe(3);
    const window = calculateFleetAgentWindow(12, nextStart);
    expect(3).toBeGreaterThanOrEqual(window.start);
    expect(3).toBeLessThan(window.end);
  });

  it("preserves the marker row budget", () => {
    for (const count of [0, 1, 2, 4, 5, 12]) {
      for (let start = 0; start < Math.max(1, count); start++) {
        const window = calculateFleetAgentWindow(count, start);
        const rows = 2
          + (window.hiddenAbove > 0 ? 1 : 0)
          + (window.end - window.start)
          + (window.hiddenBelow > 0 ? 1 : 0);
        expect(rows).toBeLessThanOrEqual(FLEET_MAX_RENDER_ROWS);
      }
    }
  });

  it("clamps empty, negative, and oversized inputs", () => {
    expect(calculateFleetAgentWindow(0, 99)).toEqual({
      start: 0,
      end: 0,
      hiddenAbove: 0,
      hiddenBelow: 0,
    });
    expect(ensureFleetSelectionVisible(12, -1, -4)).toBe(0);
    expect(ensureFleetSelectionVisible(12, 999, 999)).toBe(9);
  });
});

describe("FleetList bounded window", () => {
  it("keeps every FleetView viewport within six total rows", () => {
    for (const agentCount of [0, 1, 2, 4, 5, 12]) {
      for (let selected = 0; selected <= agentCount; selected++) {
        const viewportStart = agentCount > 0
          ? ensureFleetSelectionVisible(agentCount, Math.max(0, selected - 1), 0)
          : 0;
        const window = calculateFleetAgentWindow(agentCount, viewportStart);
        const rows = 2 + (window.hiddenAbove > 0 ? 1 : 0)
          + (window.end - window.start)
          + (window.hiddenBelow > 0 ? 1 : 0);
        expect(rows).toBeLessThanOrEqual(FLEET_MAX_RENDER_ROWS);
        if (agentCount > 0 && selected > 0) {
          expect(selected - 1).toBeGreaterThanOrEqual(window.start);
          expect(selected - 1).toBeLessThan(window.end);
        }
      }
    }
  });

  it("reserves indicator rows while keeping the selected middle agent visible", () => {
    const viewportStart = ensureFleetSelectionVisible(12, 5, 0);
    expect(viewportStart).toBe(4);
    const window = calculateFleetAgentWindow(12, viewportStart);
    expect(window.hiddenAbove).toBeGreaterThan(0);
    expect(window.hiddenBelow).toBeGreaterThan(0);
    expect(5).toBeGreaterThanOrEqual(window.start);
    expect(5).toBeLessThan(window.end);
  });

  it("keeps the rendered window stable while moving inside it", () => {
    const { render, input } = createFleetHarness(makeAgents(12));
    input("\u001b[B"); // activate, select main
    const before = render().join("\n");

    input("\u001b[B"); // select agent 0, still in the first window
    const afterFirst = render().join("\n");
    input("\u001b[B"); // select agent 1, still in the first window
    const afterSecond = render().join("\n");

    expect(afterFirst).toContain("agent 0");
    expect(afterSecond).toContain("agent 1");
    expect(afterSecond).toContain("agent 0");
    expect(afterSecond).toContain("↓ 9 more");
    expect(afterSecond).not.toContain("↑");
    expect(before).toContain("↓ 9 more");
  });

  it("moves the window only when the selected row leaves it", () => {
    const { render, input } = createFleetHarness(makeAgents(12));
    input("\u001b[B");
    input("\u001b[B");
    input("\u001b[B");
    const beforeBoundary = render().join("\n");
    input("\u001b[B");
    const afterBoundary = render().join("\n");

    expect(beforeBoundary).toContain("agent 1");
    expect(afterBoundary).toContain("agent 3");
    expect(afterBoundary).toContain("↑");
    expect(afterBoundary).not.toEqual(beforeBoundary);
  });

  it("treats vim and arrow keys as equivalent directional input", () => {
    const arrows = createFleetHarness(makeAgents(12));
    const vim = createFleetHarness(makeAgents(12));
    arrows.input("\u001b[B");
    vim.input("\u001b[B");

    for (let i = 0; i < 4; i++) {
      arrows.input("\u001b[B");
      vim.input("j");
      expect(vim.render()).toEqual(arrows.render());
    }
    for (let i = 0; i < 2; i++) {
      arrows.input("\u001b[A");
      vim.input("k");
      expect(vim.render()).toEqual(arrows.render());
    }
  });

  it("activates inactive FleetView equivalently for j, down, and wheel-down", () => {
    const arrows = createFleetHarness(makeAgents(2));
    const vim = createFleetHarness(makeAgents(2));
    const wheel = createFleetHarness(makeAgents(2));

    expect(arrows.input("\u001b[B")).toEqual({ consume: true });
    expect(vim.input("j")).toEqual({ consume: true });
    expect(wheel.mouse(1)).toEqual({ handled: true, render: true });
    expect(vim.render()).toEqual(arrows.render());
    expect(wheel.render()).toEqual(arrows.render());
    expect(arrows.render()[0]).toContain("↑↓ select");
  });

  it("activates inactive FleetView with left at an empty editor", () => {
    const { render, input } = createFleetHarness(makeAgents(1));

    expect(input("\u001b[D")).toEqual({ consume: true });
    expect(render()[0]).toContain("↑↓ select");
    expect(render()[1]).toContain("● main");
  });

  it("keeps left activation consistent and does not become down when active", () => {
    const left = createFleetHarness(makeAgents(1));
    const down = createFleetHarness(makeAgents(1));

    expect(left.render()[0]).toContain("↓ to manage");
    expect(left.input("\u001b[D")).toEqual({ consume: true });
    expect(down.input("\u001b[B")).toEqual({ consume: true });
    expect(left.render()).toEqual(down.render());
    expect(left.render()[1]).toContain("● main");

    const active = left.render();
    left.input("\u001b[D");
    expect(left.render()).toEqual(active);
    expect(left.render()[1]).toContain("● main");
  });

  it("keeps the existing left activation contract", () => {
    const { render, input } = createFleetHarness(makeAgents(2));

    expect(input("\u001b[D")).toEqual({ consume: true });
    expect(render()[0]).toContain("↑↓ select");
    expect(render()[1]).toContain("● main");

    input("\u001b[D");
    expect(render()[1]).toContain("● main");
  });

  it("exposes normalized wheel input and maps its direction like arrows", () => {
    const arrows = createFleetHarness(makeAgents(12));
    const wheel = createFleetHarness(makeAgents(12));
    expect(typeof wheel.getWidget().handleMouse).toBe("function");
    arrows.input("\u001b[B");
    wheel.input("\u001b[B");

    arrows.input("\u001b[B");
    expect(wheel.mouse(1)).toEqual({ handled: true, render: true });
    expect(wheel.render()).toEqual(arrows.render());
    arrows.input("\u001b[B");
    expect(wheel.mouse(2)).toEqual({ handled: true, render: true });
    expect(wheel.render()).toEqual(arrows.render());

    arrows.input("\u001b[A");
    expect(wheel.mouse(-1)).toEqual({ handled: true, render: true });
    expect(wheel.render()).toEqual(arrows.render());
    expect(wheel.getWidget().handleMouse({ type: "wheel", wheelDelta: 0 })).toBeUndefined();
    expect(wheel.getWidget().handleMouse({ type: "wheel" })).toBeUndefined();
    expect(wheel.getWidget().handleMouse({ type: "mousemove", wheelDelta: 1 })).toBeUndefined();
  });

  it("activates on downward wheel only when inactive at an empty editor", () => {
    const { render, mouse } = createFleetHarness(makeAgents(2));

    expect(render()[0]).toContain("↓ to manage");
    expect(mouse(-1)).toBeUndefined();
    expect(render()[0]).toContain("↓ to manage");

    expect(mouse(1)).toEqual({ handled: true, render: true });
    expect(render()[0]).toContain("↑↓ select");
    expect(render()[1]).toContain("● main");
  });

  it("keeps vim, arrows, and wheel navigation at roster boundaries", () => {
    const { render, input, mouse } = createFleetHarness(makeAgents(2));
    input("\u001b[B"); // activate on main
    expect(mouse(-1)).toEqual({ handled: true, render: true }); // up from main exits, rather than moving past the top
    expect(render()[0]).toContain("← for agents");

    input("\u001b[B");
    input("j");
    input("j"); // bottom agent
    const atBottom = render().join("\n");
    input("\u001b[B");
    expect(render().join("\n")).toEqual(atBottom);
    expect(mouse(1)).toEqual({ handled: true, render: true });
    expect(render().join("\n")).toEqual(atBottom);

    input("k");
    input("k");
    expect(render()[1]).toContain("● main");
    input("\u001b[A"); // up from main deactivates at the top boundary
    expect(render()[0]).toContain("↓ to manage");
  });

  it("keeps keyboard and wheel directions equivalent at active boundaries", () => {
    const arrows = createFleetHarness(makeAgents(2));
    const vim = createFleetHarness(makeAgents(2));
    const wheel = createFleetHarness(makeAgents(2));
    const compare = (arrow: () => unknown, vi: () => unknown, mouse: () => unknown) => {
      expect(vi()).toEqual(arrow());
      expect(mouse()).toEqual({ handled: true, render: true });
      expect(vim.render()).toEqual(arrows.render());
      expect(wheel.render()).toEqual(arrows.render());
    };

    compare(() => arrows.input("\u001b[B"), () => vim.input("j"), () => wheel.mouse(1));
    compare(() => arrows.input("\u001b[B"), () => vim.input("j"), () => wheel.mouse(1));
    compare(() => arrows.input("\u001b[B"), () => vim.input("j"), () => wheel.mouse(1));

    // Down at the bottom clamps identically, while up eventually deactivates
    // all three controls at the top boundary.
    compare(() => arrows.input("\u001b[B"), () => vim.input("j"), () => wheel.mouse(1));
    compare(() => arrows.input("\u001b[A"), () => vim.input("k"), () => wheel.mouse(-1));
    compare(() => arrows.input("\u001b[A"), () => vim.input("k"), () => wheel.mouse(-1));
    compare(() => arrows.input("\u001b[A"), () => vim.input("k"), () => wheel.mouse(-1));
    expect(arrows.render()[0]).toContain("↓ to manage");
  });

  it("slides the visible window while navigating the full roster", () => {
    const { render, input } = createFleetHarness(makeAgents(12));
    input("\u001b[B");
    for (let i = 0; i < 6; i++) input("\u001b[B");
    const middle = render();
    expect(middle.length).toBeLessThanOrEqual(FLEET_MAX_RENDER_ROWS);
    expect(middle.some(line => /↑ \d+ more/.test(line))).toBe(true);
    expect(middle.some(line => /↓ \d+ more/.test(line))).toBe(true);
    expect(middle.some(line => line.includes("●"))).toBe(true);

    input("\u001b[A");
    const afterUp = render();
    expect(afterUp.length).toBeLessThanOrEqual(FLEET_MAX_RENDER_ROWS);
    expect(afterUp.some(line => line.includes("●"))).toBe(true);
  });

  it("keeps the first and last windows bounded", () => {
    const { render, input } = createFleetHarness(makeAgents(12));
    expect(render().length).toBeLessThanOrEqual(FLEET_MAX_RENDER_ROWS);
    input("\u001b[B");
    for (let i = 0; i < 12; i++) input("\u001b[B");
    const last = render();
    expect(last.length).toBeLessThanOrEqual(FLEET_MAX_RENDER_ROWS);
    expect(last.some(line => /↓ \d+ more/.test(line))).toBe(false);
  });

  it("skips unchanged timer updates but redraws once when the active roster changes", () => {
    const { manager, fleet, tui } = createFleetHarness(makeAgents(5));
    tui.requestRender.mockClear();
    fleet.update();
    expect(tui.requestRender).not.toHaveBeenCalled();

    manager.records.pop();
    fleet.update();
    expect(tui.requestRender).toHaveBeenCalledWith(true);
    fleet.dispose();
  });

  it("clears the widget when the active roster becomes empty", () => {
    const { manager, fleet, ui } = createFleetHarness(makeAgents(1));
    manager.records.splice(0);
    fleet.update();
    expect(ui.setWidget).toHaveBeenLastCalledWith("fleet", undefined);
  });

  it("refreshes the current TUI without handling keyboard input", () => {
    const { fleet, tui } = createFleetHarness(makeAgents(1));
    tui.requestRender.mockClear();

    expect((fleet as any).requestUiRefresh(true)).toBe(true);
    expect(tui.requestRender).toHaveBeenCalledWith(true);
    fleet.dispose();
    expect((fleet as any).requestUiRefresh(true)).toBe(false);
  });
});
