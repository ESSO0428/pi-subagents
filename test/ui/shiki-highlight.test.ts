import { describe, expect, it, vi } from "vitest";
import { ShikiHighlightCache } from "../../src/ui/ccstyle/diff/shiki-highlight.js";

describe("viewer Shiki highlight cache", () => {
  it("coalesces pending work and invalidates subscribers after success", async () => {
    const loader = vi.fn(async () => async (code: string) => `\u001b[31m${code}\u001b[39m`);
    const cache = new ShikiHighlightCache(loader);
    const invalidate = vi.fn();

    expect(cache.get("const x = 1;", "typescript", "dark", ["const x = 1;"], invalidate)).toBeUndefined();
    expect(cache.get("const x = 1;", "typescript", "dark", ["const x = 1;"], invalidate)).toBeUndefined();
    await vi.waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));

    expect(loader).toHaveBeenCalledTimes(1);
    expect(cache.get("const x = 1;", "typescript", "dark", ["fallback"])).toEqual([
      "\u001b[31mconst x = 1;\u001b[39m",
    ]);
  });

  it("falls back when the loader fails and does not cache a failed result", async () => {
    const loader = vi.fn(async () => {
      throw new Error("optional Shiki unavailable");
    });
    const cache = new ShikiHighlightCache(loader);
    const fallback = ["plain"];

    expect(cache.get("plain", "text", "dark", fallback)).toBeUndefined();
    await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => {
      expect(cache.get("plain", "text", "dark", fallback)).toBeUndefined();
      expect(loader).toHaveBeenCalledTimes(2);
    });
  });
});
