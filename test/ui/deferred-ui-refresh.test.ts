import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferredUiRefresh } from "../../src/ui/deferred-ui-refresh.js";

describe("createDeferredUiRefresh", () => {
  afterEach(() => vi.useRealTimers());

  it("fires once after the debounce delay", () => {
    vi.useFakeTimers();
    const requestRender = vi.fn();
    const refresh = createDeferredUiRefresh(requestRender);

    refresh.schedule();
    vi.advanceTimersByTime(49);
    expect(requestRender).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(requestRender).toHaveBeenCalledTimes(1);
  });

  it("coalesces repeated schedules and respects the max wait", () => {
    vi.useFakeTimers();
    const requestRender = vi.fn();
    const refresh = createDeferredUiRefresh(requestRender);

    refresh.schedule();
    vi.advanceTimersByTime(40);
    refresh.schedule();
    vi.advanceTimersByTime(40);
    refresh.schedule();
    vi.advanceTimersByTime(40);
    refresh.schedule();
    vi.advanceTimersByTime(40);
    refresh.schedule();
    vi.advanceTimersByTime(39);
    expect(requestRender).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(requestRender).toHaveBeenCalledTimes(1);
  });

  it("supports cancel and dispose without firing a stale callback", () => {
    vi.useFakeTimers();
    const requestRender = vi.fn();
    const refresh = createDeferredUiRefresh(requestRender);

    refresh.schedule();
    refresh.cancel();
    vi.advanceTimersByTime(250);
    expect(requestRender).not.toHaveBeenCalled();

    refresh.schedule();
    refresh.dispose();
    refresh.schedule();
    vi.advanceTimersByTime(250);
    expect(requestRender).not.toHaveBeenCalled();
  });
});
