/** Search and highlighting helpers for rendered conversation lines. */

/** A substring match in a rendered line's plain-text representation. */
export type ConversationMatch = {
  lineIdx: number;
  col: number;
  len: number;
};

type ConversationLine = { plain: string };

type HighlightMatch = ConversationMatch & { current?: boolean };

function isSmartcaseInsensitive(query: string): boolean {
  return query === query.toLowerCase();
}

/**
 * Remove ANSI CSI/OSC control sequences from a string.
 *
 * This deliberately follows the escape-sequence grammar used by the terminal
 * renderer, rather than stripping only colour codes: hyperlinks and other
 * styled output must not affect plain-text search columns either.
 */
export function stripAnsi(text: string): string {
  let result = "";
  let i = 0;

  while (i < text.length) {
    if (text[i] !== "\x1b") {
      result += text[i];
      i++;
      continue;
    }

    const match = text.slice(i).match(ANSI_ESCAPE_RE);
    if (match) {
      i += match[0].length;
      continue;
    }

    // An incomplete escape sequence has no visible representation. This also
    // prevents a malformed trailing escape from leaking into search text.
    if (i + 1 < text.length) {
      i += 2;
    } else {
      i++;
    }
  }

  return result;
}

/**
 * Find all non-overlapping substring matches using smartcase semantics.
 * Lowercase queries match case-insensitively; queries containing uppercase
 * characters match case-sensitively.
 */
export function findConversationMatches(
  lines: ConversationLine[],
  query: string,
): ConversationMatch[] {
  if (!query) return [];

  const matches: ConversationMatch[] = [];
  const caseInsensitive = isSmartcaseInsensitive(query);
  const needle = caseInsensitive ? query.toLowerCase() : query;

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const plain = lines[lineIdx]?.plain ?? "";
    const haystack = caseInsensitive ? plain.toLowerCase() : plain;
    let position = 0;

    while (position < haystack.length) {
      const col = haystack.indexOf(needle, position);
      if (col === -1) break;
      matches.push({ lineIdx, col, len: query.length });
      position = col + Math.max(1, query.length);
    }
  }

  return matches;
}

/**
 * Inject match backgrounds into an ANSI-styled line without counting escape
 * sequences as plain-text columns. Existing foreground/style sequences are
 * copied verbatim, so syntax highlighting remains intact.
 */
export function highlightConversationLine(
  text: string,
  matches: HighlightMatch[],
  openMatch: string,
  openCurrent: string,
  close: string,
): string {
  if (matches.length === 0) return text;

  const sorted = [...matches].sort((a, b) => a.col - b.col);
  let result = "";
  let plainCol = 0;
  let i = 0;
  let active: HighlightMatch | null = null;
  let nextIdx = 0;

  while (i < text.length) {
    if (text[i] === "\x1b") {
      const ansiEscape = text.slice(i).match(ANSI_ESCAPE_RE);
      if (ansiEscape) {
        result += ansiEscape[0];
        i += ansiEscape[0].length;
        continue;
      }
    }

    if (!active && nextIdx < sorted.length && plainCol >= sorted[nextIdx].col) {
      active = sorted[nextIdx];
      result += active.current ? openCurrent : openMatch;
    }

    result += text[i];
    plainCol++;
    i++;

    if (active && plainCol >= active.col + active.len) {
      result += close;
      active = null;
      nextIdx++;
    }
  }

  if (active) result += close;
  return result;
}

/** Find the first match at or after a line, wrapping to the first match. */
export function nearestConversationMatchAfter(
  matches: ConversationMatch[],
  lineIdx: number,
): number {
  if (matches.length === 0) return -1;
  for (let i = 0; i < matches.length; i++) {
    if (matches[i].lineIdx >= lineIdx) return i;
  }
  return 0;
}

/** Find the last match at or before a line, wrapping to the last match. */
export function nearestConversationMatchBefore(
  matches: ConversationMatch[],
  lineIdx: number,
): number {
  if (matches.length === 0) return -1;
  for (let i = matches.length - 1; i >= 0; i--) {
    if (matches[i].lineIdx <= lineIdx) return i;
  }
  return matches.length - 1;
}

/** ANSI CSI/OSC sequences emitted by the TUI renderer. */
const ANSI_ESCAPE_RE = /^(?:\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]))/;
