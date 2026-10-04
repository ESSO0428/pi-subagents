import { AsyncLocalStorage } from "node:async_hooks";

/** Marks resource loading/session construction performed for a child session. */
const childSessionContext = new AsyncLocalStorage<boolean>();

export function inChildSessionContext(): boolean {
  return childSessionContext.getStore() === true;
}

export function runInChildSessionContext<T>(fn: () => Promise<T>): Promise<T> {
  return childSessionContext.run(true, fn);
}
