import { describe, expect, it } from "vitest";
import { completeAgentsArguments, isRefocusArgument } from "../src/agents-command.js";

/**
 * `/agents` argument completion follows the same contract pi-goal uses for
 * `/goal`: everything when nothing is typed yet, prefix-filtered after that, and
 * `null` once the sub-command is unambiguous or nothing matches.
 */
describe("/agents argument completion", () => {
  it("offers every sub-command when nothing is typed", () => {
    expect(completeAgentsArguments("")).toEqual([
      { value: "re-focus", label: "re-focus", description: "Rebuild the agents list widget registration" },
    ]);
    expect(completeAgentsArguments("   ")).toHaveLength(1);
  });

  it("filters by prefix on either value or label", () => {
    expect(completeAgentsArguments("re-fo")?.map((i) => i.value)).toEqual(["re-focus"]);
    expect(completeAgentsArguments("refocus")).toBeNull();
    expect(completeAgentsArguments("zzz")).toBeNull();
  });

  it("stops offering once a space makes the sub-command unambiguous", () => {
    expect(completeAgentsArguments("re-focus ")).toBeNull();
  });

  it("recognises the re-focus spellings and tolerates junk", () => {
    expect(isRefocusArgument("re-focus")).toBe(true);
    expect(isRefocusArgument("  Re-Focus ")).toBe(true);
    expect(isRefocusArgument("refocus")).toBe(true);
    expect(isRefocusArgument("re-register")).toBe(true);
    expect(isRefocusArgument("")).toBe(false);
    expect(isRefocusArgument(undefined)).toBe(false);
    // The harness invokes handlers with a non-string; `/agents` must not throw.
    expect(isRefocusArgument({})).toBe(false);
  });
});
