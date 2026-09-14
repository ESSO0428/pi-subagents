/** Coalesced, deferred render requests for structural UI changes. */

const DEFAULT_DELAY_MS = 50;
const DEFAULT_MAX_WAIT_MS = 200;

export interface DeferredUiRefresh {
  /** Schedule one render request after the debounce/max-wait window. */
  schedule(): void;
  /** Cancel the current pending render request, if any. */
  cancel(): void;
  /** Cancel and permanently disable this scheduler. */
  dispose(): void;
}

export function createDeferredUiRefresh(
  requestRender: () => void,
  options: {
    delayMs?: number;
    maxWaitMs?: number;
    now?: () => number;
  } = {},
): DeferredUiRefresh {
  const delayMs = Math.max(0, options.delayMs ?? DEFAULT_DELAY_MS);
  const maxWaitMs = Math.max(0, options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS);
  const now = options.now ?? Date.now;

  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let firstScheduledAt: number | undefined;
  let disposed = false;

  const clearPendingTimer = () => {
    if (debounceTimer !== undefined) {
      clearTimeout(debounceTimer);
      debounceTimer = undefined;
    }
  };

  const flush = () => {
    // Clear all state before invoking user code. A render callback may schedule
    // another refresh, which should begin a fresh debounce window.
    clearPendingTimer();
    firstScheduledAt = undefined;
    if (disposed) return;
    requestRender();
  };

  const schedule = () => {
    if (disposed) return;

    const current = now();
    if (firstScheduledAt === undefined) firstScheduledAt = current;

    clearPendingTimer();
    const maxDeadline = firstScheduledAt + maxWaitMs;
    const remainingMaxWait = Math.max(0, maxDeadline - current);
    const wait = Math.min(delayMs, remainingMaxWait);
    debounceTimer = setTimeout(flush, wait);
  };

  const cancel = () => {
    clearPendingTimer();
    firstScheduledAt = undefined;
  };

  const dispose = () => {
    if (disposed) return;
    cancel();
    disposed = true;
  };

  return { schedule, cancel, dispose };
}
