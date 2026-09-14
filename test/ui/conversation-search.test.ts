import { describe, expect, it } from "vitest";
import {
  findConversationMatches,
  highlightConversationLine,
  nearestConversationMatchAfter,
  nearestConversationMatchBefore,
  stripAnsi,
} from "../../src/ui/conversation-search.js";

describe("conversation search helpers", () => {
  it("uses smartcase substring matching", () => {
    const lines = [{ plain: "const Answer = 42;" }, { plain: "answer again" }];
    expect(findConversationMatches(lines, "answer")).toEqual([
      { lineIdx: 0, col: 6, len: 6 },
      { lineIdx: 1, col: 0, len: 6 },
    ]);
    expect(findConversationMatches(lines, "Answer")).toEqual([
      { lineIdx: 0, col: 6, len: 6 },
    ]);
  });

  it("highlights matches without consuming ANSI escape sequences", () => {
    const styled = "\x1b[31mAnswer\x1b[39m";
    const result = highlightConversationLine(
      styled,
      [{ lineIdx: 0, col: 0, len: 6, current: true }],
      "<m>",
      "<c>",
      "</>",
    );
    expect(result).toContain("<c>");
    expect(result).toContain("Answer");
    expect(result).toContain("\x1b[31m");
  });

  it("strips CSI and OSC ANSI sequences", () => {
    expect(stripAnsi("\x1b[31mred\x1b[39m")).toBe("red");
    expect(stripAnsi("before\x1b]0;title\x07after")).toBe("beforeafter");
    expect(stripAnsi("before\x1b]0;title\x1b\\after")).toBe("beforeafter");
  });

  it("wraps nearest-match navigation", () => {
    const matches = [
      { lineIdx: 2, col: 0, len: 3 },
      { lineIdx: 5, col: 1, len: 3 },
      { lineIdx: 9, col: 2, len: 3 },
    ];
    expect(nearestConversationMatchAfter(matches, 5)).toBe(1);
    expect(nearestConversationMatchAfter(matches, 10)).toBe(0);
    expect(nearestConversationMatchBefore(matches, 5)).toBe(1);
    expect(nearestConversationMatchBefore(matches, 1)).toBe(2);
    expect(nearestConversationMatchAfter([], 0)).toBe(-1);
    expect(nearestConversationMatchBefore([], 0)).toBe(-1);
  });
});
