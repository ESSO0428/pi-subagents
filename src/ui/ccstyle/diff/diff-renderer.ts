import {
	Text,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
} from "@earendil-works/pi-tui";
import { getLanguageFromPath, highlightCode } from "@earendil-works/pi-coding-agent";
import {
	ANSI_SGR_PATTERN,
	STYLE_RESET_PARAMS,
	filterSgrSequences,
	toSgrParams,
	readSgrColorSequence,
	isFiniteSgrParam,
	expandSgrReset,
} from "./ansi-utils.js";
import {
	buildCollapsedDiffHintText,
	clampRenderedLineToWidth,
	clampRenderedLinesToWidth,
} from "./line-width-safety.js";
import {
	buildDiffSummaryText,
	normalizeDiffRenderWidth,
	resolveDiffPresentationMode,
	type DiffPresentationMode,
} from "./diff-presentation.js";
import { pluralize, sanitizeAnsiForThemedOutput, sanitizeToolResultText, showMoreHintText } from "./render-utils.js";
import { splitWriteContentLines } from "./write-display-utils.js";
import {
	DEFAULT_TOOL_DISPLAY_CONFIG,
	type DiffIndicatorMode,
	type ToolDisplayConfig,
	type PersistedDiff,
} from "./types.js";

const MAX_HL_CHARS = 200_000;

interface DiffTheme {
	fg(color: string, text: string): string;
	bg?(color: string, text: string): string;
	bold?(text: string): string;
	getFgAnsi?(color: string): string;
	getBgAnsi?(color: string): string;
}

type DiffLineKind = "add" | "remove" | "context";
type DiffEntryKind = "line" | "meta" | "hunk" | "file";

interface DiffLineEntry {
	kind: "line";
	lineKind: DiffLineKind;
	oldLineNumber: number | null;
	newLineNumber: number | null;
	fallbackLineNumber: string;
	content: string;
	hashlineAnchorContent?: string;
	raw: string;
	hunkIndex: number;
}

interface DiffMetaEntry {
	kind: Exclude<DiffEntryKind, "line">;
	raw: string;
	hunkIndex: number;
}

type ParsedDiffEntry = DiffLineEntry | DiffMetaEntry;

interface ParsedDiff {
	entries: ParsedDiffEntry[];
	stats: DiffStats;
}

interface DiffStats {
	added: number;
	removed: number;
	context: number;
	hunks: number;
	files: number;
	lines: number;
}

interface RenderedRow {
	text: string;
	hunkIndex: number | null;
}

interface SplitDiffRow {
	left?: DiffLineEntry;
	right?: DiffLineEntry;
	meta?: DiffMetaEntry;
	hunkIndex: number | null;
}

interface DiffSpan {
	start: number;
	end: number;
}

interface RgbColor {
	r: number;
	g: number;
	b: number;
}

interface DiffPalette {
	addRowBgAnsi: string;
	removeRowBgAnsi: string;
	addEmphasisBgAnsi: string;
	removeEmphasisBgAnsi: string;
}

export interface DiffRenderOptions {
	expanded: boolean;
	filePath?: string;
	previousContent?: string;
	fileExistedBeforeWrite?: boolean;
	headerLabel?: string;
	/** Durable display payload captured during the write execution. */
	persistedDiff?: PersistedDiff;
	/** Live hover state for the collapsed hint row (muted → text on hover). */
	isHovered?: () => boolean;
	invalidate?: () => void;
}

type CodeLineHighlighter = (line: string, entry: DiffLineEntry) => string;

const CANONICAL_LINE_PATTERN = /^([+\- ])(\s*\d+)\|(.*)$/;
const HASHLINE_ANCHOR_LINE_PATTERN = /^([+\- ])(\s*\d+)#([A-Za-z0-9]+| {2}):(.*)$/;
const LEGACY_LINE_PATTERN = /^([+\- ])(\s*\d+)\s(.*)$/;
const HUNK_HEADER_PATTERN = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@(.*)$/;
const SPLIT_SEPARATOR = " │ ";
const MIN_LINE_NUMBER_WIDTH = 2;
const MIN_SPLIT_COLUMN_WIDTH = 24;
const MAX_INLINE_DIFF_LINE_LENGTH = 700;
const ADD_ROW_BACKGROUND_MIX_RATIO = 0.12;
const REMOVE_ROW_BACKGROUND_MIX_RATIO = 0.12;
const ADD_INLINE_EMPHASIS_MIX_RATIO = 0.26;
const REMOVE_INLINE_EMPHASIS_MIX_RATIO = 0.26;
const ADDITION_TINT_TARGET: RgbColor = { r: 84, g: 190, b: 118 };
const DELETION_TINT_TARGET: RgbColor = { r: 232, g: 95, b: 122 };
const ANSI_BG_RESET = "\x1b[49m";
const DIFF_WIDTH_OPS = {
	measure: visibleWidth,
	truncate: (text: string, maxWidth: number): string => truncateToWidth(text, maxWidth, ""),
};

function clampDiffLineToWidth(text: string, width: number): string {
	return stabilizeBackgroundResets(clampRenderedLineToWidth(text, width, DIFF_WIDTH_OPS));
}

function clampDiffLinesToWidth(lines: string[], width: number): string[] {
	return clampRenderedLinesToWidth(lines, width, DIFF_WIDTH_OPS).map((line) =>
		stabilizeBackgroundResets(line),
	);
}

function normalizeCodeWhitespace(text: string): string {
	return text.replace(/\t/g, "    ");
}

function emphasis(theme: DiffTheme, text: string): string {
	return typeof theme.bold === "function" ? theme.bold(text) : text;
}

function sequenceResetsBackground(params: number[]): boolean {
	let index = 0;
	while (index < params.length) {
		const param = params[index] ?? 0;
		if (param === 0 || param === 49) {
			return true;
		}

		const colorSequence = readSgrColorSequence(params, index);
		index += colorSequence ? colorSequence.length : 1;
	}

	return false;
}

function stripBackgroundResetParams(params: number[]): number[] {
	const filtered: number[] = [];

	for (let i = 0; i < params.length; i++) {
		const param = params[i] ?? 0;

		if (param === 0) {
			filtered.push(...expandSgrReset(param)!);
			continue;
		}

		if (param === 49) {
			continue;
		}

		const colorSequence = readSgrColorSequence(params, i);
		if (colorSequence) {
			filtered.push(...colorSequence);
			i += colorSequence.length - 1;
			continue;
		}

		filtered.push(param);
	}

	return filtered;
}

function stabilizeBackgroundResets(text: string): string {
	if (!text) {
		return text;
	}
	return filterSgrSequences(text, stripBackgroundResetParams);
}

function fitToWidth(text: string, width: number): string {
	const trimmed = truncateToWidth(text, width, "");
	const gap = Math.max(0, width - visibleWidth(trimmed));
	return gap > 0 ? `${trimmed}${" ".repeat(gap)}` : trimmed;
}

function applyBackgroundToVisualRow(
	text: string,
	width: number,
	rowBgAnsi: string,
	restoreBgAnsi: string,
): string {
	if (width <= 0) {
		return "";
	}

	const fitted = fitToWidth(text, width);
	const withStableBackground = keepBackgroundAcrossResets(fitted, rowBgAnsi);
	return stabilizeBackgroundResets(`${rowBgAnsi}${withStableBackground}${restoreBgAnsi}`);
}

function applyLineBackgroundToWrappedRows(
	rows: string[],
	width: number,
	rowBgAnsi: string,
	restoreBgAnsi: string,
): string[] {
	if (rows.length === 0) {
		return [applyBackgroundToVisualRow("", width, rowBgAnsi, restoreBgAnsi)];
	}

	return rows.map((row) => applyBackgroundToVisualRow(row, width, rowBgAnsi, restoreBgAnsi));
}

function wrapToWidth(text: string, width: number, wordWrap: boolean): string[] {
	if (width <= 0) {
		return [""];
	}

	if (!wordWrap) {
		return [fitToWidth(text, width)];
	}

	const wrapped = wrapTextWithAnsi(text, width);
	if (wrapped.length === 0) {
		return [fitToWidth("", width)];
	}

	return wrapped.map((line) => fitToWidth(line, width));
}

function resolveLanguageFromPath(rawPath: string | undefined): string | undefined {
	if (!rawPath || !rawPath.trim()) {
		return undefined;
	}
	const normalizedPath = rawPath.replace(/^@/, "").trim();
	if (!normalizedPath) {
		return undefined;
	}
	try {
		return getLanguageFromPath(normalizedPath);
	} catch {
		return undefined;
	}
}

function resolveShikiTheme(theme: DiffTheme): string {
	if (process.env.DIFF_THEME) return process.env.DIFF_THEME;
	const background =
		parseAnsiColorCode(readThemeAnsi(theme, "bg", "toolSuccessBg")) ??
		parseAnsiColorCode(readThemeAnsi(theme, "bg", "toolPendingBg")) ??
		parseAnsiColorCode(readThemeAnsi(theme, "bg", "userMessageBg"));
	if (!background) return "github-dark";
	const luminance = (background.r * 299 + background.g * 587 + background.b * 114) / 1000;
	return luminance >= 128 ? "github-light" : "github-dark";
}

function cleanCodeLine(line: string): string {
	return sanitizeToolResultText(line).replace(/\n/g, "");
}

export function shouldHighlightCodeBlock(code: string): boolean {
	return code.length <= MAX_HL_CHARS;
}

function createCodeLineHighlighter(
	language: string | undefined,
	_theme: DiffTheme,
	entries: readonly ParsedDiffEntry[],
	_invalidate?: () => void,
): CodeLineHighlighter {
	const codeEntries = entries.filter((entry): entry is DiffLineEntry => entry.kind === "line");
	const cleanLines = codeEntries.map((entry) =>
		cleanCodeLine(normalizeCodeWhitespace(entry.content)),
	);
	const code = cleanLines.join("\n");
	let highlightedLines = cleanLines;
	if (language && code) {
		try {
			highlightedLines = highlightCode(code, language).map(sanitizeAnsiForThemedOutput);
		} catch {
			// Pi's highlighter may reject an unknown language; plain text is safe.
			highlightedLines = cleanLines.map(sanitizeAnsiForThemedOutput);
		}
	}
	const byEntry = new WeakMap(
		codeEntries.map((entry, index) => [entry, highlightedLines[index] ?? cleanLines[index] ?? ""]),
	);
	return (_line, entry) => byEntry.get(entry) ?? "";
}

function toParsedDiffLine(
	prefix: string,
	lineNumber: string,
	content: string,
): {
	lineKind: DiffLineKind;
	lineNumber: string;
	content: string;
} {
	const normalizedLineNumber = lineNumber.trim();
	if (prefix === "+") {
		return { lineKind: "add", lineNumber: normalizedLineNumber, content };
	}
	if (prefix === "-") {
		return { lineKind: "remove", lineNumber: normalizedLineNumber, content };
	}
	return { lineKind: "context", lineNumber: normalizedLineNumber, content };
}

function parseCanonicalDiffLine(line: string): {
	lineKind: DiffLineKind;
	lineNumber: string;
	content: string;
	hashlineAnchorContent?: string;
} | null {
	const hashlineAnchorMatch = line.match(HASHLINE_ANCHOR_LINE_PATTERN);
	if (hashlineAnchorMatch) {
		const lineNumber = hashlineAnchorMatch[2] ?? "";
		const hash = hashlineAnchorMatch[3] ?? "";
		const content = hashlineAnchorMatch[4] ?? "";
		const parsed = toParsedDiffLine(hashlineAnchorMatch[1] ?? " ", lineNumber, content);
		return {
			...parsed,
			hashlineAnchorContent: `${lineNumber.trim()}#${hash}:${content}`,
		};
	}

	const canonicalMatch = line.match(CANONICAL_LINE_PATTERN);
	const legacyMatch = canonicalMatch ? null : line.match(LEGACY_LINE_PATTERN);
	const matched = canonicalMatch ?? legacyMatch;
	if (!matched) {
		return null;
	}

	return toParsedDiffLine(matched[1] ?? " ", matched[2] ?? "", matched[3] ?? "");
}

function toNumber(value: string | undefined): number | null {
	if (!value) {
		return null;
	}
	const parsed = Number.parseInt(value, 10);
	return Number.isNaN(parsed) ? null : parsed;
}

function anchorCanonicalLineCursors(
	kind: DiffLineKind,
	parsedNumber: number | null,
	oldLineCursor: number | null,
	newLineCursor: number | null,
	lineNumberDelta: number,
): { oldLineCursor: number | null; newLineCursor: number | null } {
	if (parsedNumber === null) {
		return { oldLineCursor, newLineCursor };
	}

	if (kind === "add") {
		return {
			oldLineCursor,
			newLineCursor: newLineCursor ?? parsedNumber,
		};
	}

	return {
		oldLineCursor: parsedNumber,
		newLineCursor: parsedNumber + lineNumberDelta,
	};
}

function classifyMetaLine(raw: string): DiffMetaEntry["kind"] {
	if (raw.startsWith("@@")) {
		return "hunk";
	}
	if (
		raw.startsWith("diff --git") ||
		raw.startsWith("index ") ||
		raw.startsWith("--- ") ||
		raw.startsWith("+++ ") ||
		raw.startsWith("rename from ") ||
		raw.startsWith("rename to ") ||
		raw.startsWith("new file mode ") ||
		raw.startsWith("deleted file mode ")
	) {
		return "file";
	}
	return "meta";
}

function pushParsedLineEntry(
	entries: ParsedDiffEntry[],
	lineKind: DiffLineKind,
	oldLineNumber: number | null,
	newLineNumber: number | null,
	fallbackLineNumber: string,
	rawLine: string,
	hunkIndex: number,
): void {
	entries.push({
		kind: "line",
		lineKind,
		oldLineNumber,
		newLineNumber,
		fallbackLineNumber,
		content: rawLine.slice(1),
		raw: rawLine,
		hunkIndex,
	});
}

function createMetaEntry(raw: string, hunkIndex: number): DiffMetaEntry {
	return {
		kind: classifyMetaLine(raw),
		raw,
		hunkIndex,
	};
}

function ensureImplicitHunk(currentHunk: number): number {
	return currentHunk > 0 ? currentHunk : 1;
}

function parseDiff(diffText: string): ParsedDiff {
	const stats: DiffStats = {
		added: 0,
		removed: 0,
		context: 0,
		hunks: 0,
		files: 0,
		lines: 0,
	};
	const entries: ParsedDiffEntry[] = [];

	if (!diffText.trim()) {
		return { entries, stats };
	}

	let hunkIndex = 0;
	let oldLineCursor: number | null = null;
	let newLineCursor: number | null = null;
	let lineNumberDelta = 0;

	for (const rawLine of diffText.replace(/\r/g, "").split("\n")) {
		stats.lines++;

		const hunkMatch = rawLine.match(HUNK_HEADER_PATTERN);
		if (hunkMatch) {
			hunkIndex++;
			stats.hunks = Math.max(stats.hunks, hunkIndex);
			oldLineCursor = toNumber(hunkMatch[1]);
			newLineCursor = toNumber(hunkMatch[3]);
			lineNumberDelta = (newLineCursor ?? 0) - (oldLineCursor ?? 0);
			entries.push({ kind: "hunk", raw: rawLine, hunkIndex });
			continue;
		}

		if (rawLine.startsWith("diff --git ")) {
			stats.files++;
			oldLineCursor = null;
			newLineCursor = null;
			lineNumberDelta = 0;
			entries.push({ kind: "file", raw: rawLine, hunkIndex });
			continue;
		}

		if (rawLine.startsWith("--- ") || rawLine.startsWith("+++ ")) {
			oldLineCursor = null;
			newLineCursor = null;
			lineNumberDelta = 0;
		}

		const canonical = parseCanonicalDiffLine(rawLine);
		if (canonical) {
			hunkIndex = ensureImplicitHunk(hunkIndex);
			stats.hunks = Math.max(stats.hunks, hunkIndex);

			const parsedNumber = toNumber(canonical.lineNumber);
			const anchoredCursors = anchorCanonicalLineCursors(
				canonical.lineKind,
				parsedNumber,
				oldLineCursor,
				newLineCursor,
				lineNumberDelta,
			);
			oldLineCursor = anchoredCursors.oldLineCursor;
			newLineCursor = anchoredCursors.newLineCursor;

			const oldLineNumber = canonical.lineKind === "add" ? null : oldLineCursor;
			const newLineNumber = canonical.lineKind === "remove" ? null : newLineCursor;

			if (canonical.lineKind === "add") {
				stats.added++;
				if (newLineCursor !== null) {
					newLineCursor++;
				}
				lineNumberDelta++;
			} else if (canonical.lineKind === "remove") {
				stats.removed++;
				if (oldLineCursor !== null) {
					oldLineCursor++;
				}
				lineNumberDelta--;
			} else {
				stats.context++;
				if (oldLineCursor !== null) {
					oldLineCursor++;
				}
				if (newLineCursor !== null) {
					newLineCursor++;
				}
			}

			entries.push({
				kind: "line",
				lineKind: canonical.lineKind,
				oldLineNumber,
				newLineNumber,
				fallbackLineNumber: canonical.lineNumber,
				content: canonical.content,
				hashlineAnchorContent: canonical.hashlineAnchorContent,
				raw: rawLine,
				hunkIndex,
			});
			continue;
		}

		if (rawLine.startsWith("-") && !rawLine.startsWith("---")) {
			hunkIndex = ensureImplicitHunk(hunkIndex);
			stats.hunks = Math.max(stats.hunks, hunkIndex);
			stats.removed++;
			const oldLineNumber = oldLineCursor;
			if (oldLineCursor !== null) {
				oldLineCursor++;
			}
			lineNumberDelta--;
			pushParsedLineEntry(
				entries,
				"remove",
				oldLineNumber,
				null,
				oldLineNumber !== null ? `${oldLineNumber}` : "",
				rawLine,
				hunkIndex,
			);
			continue;
		}

		if (rawLine.startsWith("+") && !rawLine.startsWith("+++")) {
			hunkIndex = ensureImplicitHunk(hunkIndex);
			stats.hunks = Math.max(stats.hunks, hunkIndex);
			stats.added++;
			const newLineNumber = newLineCursor;
			if (newLineCursor !== null) {
				newLineCursor++;
			}
			lineNumberDelta++;
			pushParsedLineEntry(
				entries,
				"add",
				null,
				newLineNumber,
				newLineNumber !== null ? `${newLineNumber}` : "",
				rawLine,
				hunkIndex,
			);
			continue;
		}

		if (rawLine.startsWith(" ")) {
			hunkIndex = ensureImplicitHunk(hunkIndex);
			stats.hunks = Math.max(stats.hunks, hunkIndex);
			stats.context++;
			const oldLineNumber = oldLineCursor;
			const newLineNumber = newLineCursor;
			if (oldLineCursor !== null) {
				oldLineCursor++;
			}
			if (newLineCursor !== null) {
				newLineCursor++;
			}
			pushParsedLineEntry(
				entries,
				"context",
				oldLineNumber,
				newLineNumber,
				oldLineNumber !== null
					? `${oldLineNumber}`
					: newLineNumber !== null
						? `${newLineNumber}`
						: "",
				rawLine,
				hunkIndex,
			);
			continue;
		}

		entries.push(createMetaEntry(rawLine, hunkIndex));
	}

	if (stats.hunks === 0 && (stats.added > 0 || stats.removed > 0 || stats.context > 0)) {
		stats.hunks = 1;
	}
	if (stats.files === 0) {
		const patchStyleFileHeaders = entries.filter(
			(entry) => entry.kind === "file" && entry.raw.startsWith("+++ "),
		).length;
		if (patchStyleFileHeaders > 0) {
			stats.files = patchStyleFileHeaders;
		} else if (stats.hunks > 0) {
			stats.files = 1;
		}
	}

	return { entries, stats };
}

function getHashlineAnchorLabel(entry: DiffLineEntry): string | undefined {
	if (!entry.hashlineAnchorContent) {
		return undefined;
	}
	const separatorIndex = entry.hashlineAnchorContent.indexOf(":");
	return separatorIndex >= 0
		? entry.hashlineAnchorContent.slice(0, separatorIndex)
		: entry.hashlineAnchorContent;
}

function getLineNumberWidth(entries: ParsedDiffEntry[], showHashlineAnchors = false): number {
	let maxWidth = MIN_LINE_NUMBER_WIDTH;

	for (const entry of entries) {
		if (entry.kind !== "line") {
			continue;
		}

		if (showHashlineAnchors) {
			const anchorLabel = getHashlineAnchorLabel(entry);
			if (anchorLabel) {
				maxWidth = Math.max(maxWidth, visibleWidth(anchorLabel));
				continue;
			}
		}

		const candidates = [
			entry.oldLineNumber,
			entry.newLineNumber,
			toNumber(entry.fallbackLineNumber),
		].filter((value): value is number => value !== null);

		for (const candidate of candidates) {
			const digits = `${candidate}`.length;
			if (digits > maxWidth) {
				maxWidth = digits;
			}
		}
	}

	return maxWidth;
}

function formatLineNumber(value: number | null, fallback: string, width: number): string {
	if (value !== null) {
		return `${value}`.padStart(width, " ");
	}
	if (fallback.trim()) {
		return fallback.trim().slice(-width).padStart(width, " ");
	}
	return " ".repeat(width);
}

function formatLineNumberLabel(
	entry: DiffLineEntry,
	value: number | null,
	fallback: string,
	width: number,
	showHashlineAnchors: boolean,
): string {
	const anchorLabel = showHashlineAnchors ? getHashlineAnchorLabel(entry) : undefined;
	if (anchorLabel) {
		return fitToWidth(anchorLabel, width);
	}
	return formatLineNumber(value, fallback, width);
}

function formatMetaEntryRows(
	entry: DiffMetaEntry,
	width: number,
	theme: DiffTheme,
	wordWrap: boolean,
): RenderedRow[] {
	const normalized = sanitizeAnsiForThemedOutput(normalizeCodeWhitespace(entry.raw));
	const lines = wordWrap
		? wrapToWidth(normalized, width, true)
		: [truncateToWidth(normalized, width)];

	const mapColor = (line: string): string => {
		if (entry.kind === "hunk") {
			return stabilizeBackgroundResets(theme.fg("accent", line));
		}
		if (entry.kind === "file") {
			return stabilizeBackgroundResets(theme.fg("muted", line));
		}
		return stabilizeBackgroundResets(theme.fg("toolDiffContext", line));
	};

	return lines.map((line) => ({
		text: mapColor(line),
		hunkIndex: entry.kind === "file" ? null : entry.hunkIndex || null,
	}));
}

function collectConsecutiveLineEntries(
	entries: ParsedDiffEntry[],
	startIndex: number,
	lineKind: DiffLineKind,
): { collected: DiffLineEntry[]; nextIndex: number } {
	const collected: DiffLineEntry[] = [];
	let index = startIndex;
	while (index < entries.length) {
		const candidate = entries[index];
		if (!candidate || candidate.kind !== "line" || candidate.lineKind !== lineKind) {
			break;
		}
		collected.push(candidate);
		index++;
	}
	return { collected, nextIndex: index };
}

function buildSplitRows(entries: ParsedDiffEntry[]): SplitDiffRow[] {
	const rows: SplitDiffRow[] = [];
	let index = 0;

	while (index < entries.length) {
		const entry = entries[index];
		if (!entry) {
			break;
		}

		if (entry.kind !== "line") {
			rows.push({ meta: entry, hunkIndex: entry.hunkIndex || null });
			index++;
			continue;
		}

		if (entry.lineKind === "remove") {
			const removedResult = collectConsecutiveLineEntries(entries, index, "remove");
			const removed = removedResult.collected;
			const addedResult = collectConsecutiveLineEntries(entries, removedResult.nextIndex, "add");
			const added = addedResult.collected;
			index = addedResult.nextIndex;

			const pairCount = Math.max(removed.length, added.length);
			for (let pairIndex = 0; pairIndex < pairCount; pairIndex++) {
				const left = removed[pairIndex];
				const right = added[pairIndex];
				rows.push({
					left,
					right,
					hunkIndex: left?.hunkIndex ?? right?.hunkIndex ?? null,
				});
			}
			continue;
		}

		if (entry.lineKind === "add") {
			rows.push({ right: entry, hunkIndex: entry.hunkIndex || null });
			index++;
			continue;
		}

		rows.push({ left: entry, right: entry, hunkIndex: entry.hunkIndex || null });
		index++;
	}

	return rows;
}

function getCellLineNumber(line: DiffLineEntry, side: "left" | "right"): number | null {
	if (side === "left") {
		return line.oldLineNumber ?? (line.lineKind === "context" ? line.newLineNumber : null);
	}
	return line.newLineNumber ?? (line.lineKind === "context" ? line.oldLineNumber : null);
}

function tokenizeInlineDiff(input: string): Array<{ value: string; start: number; end: number }> {
	if (!input) {
		return [];
	}

	const tokens: Array<{ value: string; start: number; end: number }> = [];
	const pattern = /(\s+|[A-Za-z0-9_]+|[^A-Za-z0-9_\s])/g;
	let match: RegExpExecArray | null;

	while ((match = pattern.exec(input)) !== null) {
		const value = match[0] ?? "";
		if (!value) {
			continue;
		}
		tokens.push({
			value,
			start: match.index,
			end: match.index + value.length,
		});
	}

	if (tokens.length === 0 && input.length > 0) {
		tokens.push({ value: input, start: 0, end: input.length });
	}

	return tokens;
}

function mergeSpans(spans: DiffSpan[]): DiffSpan[] {
	if (spans.length <= 1) {
		return spans;
	}

	const sorted = [...spans].sort((a, b) => a.start - b.start);
	const merged: DiffSpan[] = [sorted[0]];

	for (let index = 1; index < sorted.length; index++) {
		const current = sorted[index];
		const previous = merged[merged.length - 1];
		if (!current || !previous) {
			continue;
		}

		if (current.start <= previous.end) {
			previous.end = Math.max(previous.end, current.end);
			continue;
		}

		merged.push({ ...current });
	}

	return merged;
}

function tokensToDiffSpans(
	text: string,
	tokens: Array<{ value: string; start: number; end: number }>,
	changedIndexes: Set<number>,
): DiffSpan[] {
	if (tokens.length === 0 || changedIndexes.size === 0) {
		return [];
	}

	const spans: DiffSpan[] = [];
	let start: number | null = null;
	let end = -1;

	for (let index = 0; index < tokens.length; index++) {
		if (!changedIndexes.has(index)) {
			if (start !== null && end > start) {
				spans.push({ start, end });
				start = null;
				end = -1;
			}
			continue;
		}

		const token = tokens[index];
		if (!token) {
			continue;
		}

		if (start === null) {
			start = token.start;
			end = token.end;
		} else {
			end = token.end;
		}
	}

	if (start !== null && end > start) {
		spans.push({ start, end });
	}

	const trimmed: DiffSpan[] = [];
	for (const span of spans) {
		let spanStart = span.start;
		let spanEnd = span.end;

		while (spanStart < spanEnd && /\s/.test(text[spanStart] ?? "")) {
			spanStart++;
		}
		while (spanEnd > spanStart && /\s/.test(text[spanEnd - 1] ?? "")) {
			spanEnd--;
		}
		if (spanEnd > spanStart) {
			trimmed.push({ start: spanStart, end: spanEnd });
		}
	}

	return mergeSpans(trimmed);
}

function computeInlineDiffSpans(
	leftLine: string,
	rightLine: string,
): { left: DiffSpan[]; right: DiffSpan[] } {
	if (leftLine === rightLine) {
		return { left: [], right: [] };
	}
	if (
		leftLine.length > MAX_INLINE_DIFF_LINE_LENGTH ||
		rightLine.length > MAX_INLINE_DIFF_LINE_LENGTH
	) {
		return { left: [], right: [] };
	}

	const leftTokens = tokenizeInlineDiff(leftLine);
	const rightTokens = tokenizeInlineDiff(rightLine);
	const leftCount = leftTokens.length;
	const rightCount = rightTokens.length;

	if (leftCount === 0 || rightCount === 0) {
		return {
			left: leftLine.trim().length > 0 ? [{ start: 0, end: leftLine.length }] : [],
			right: rightLine.trim().length > 0 ? [{ start: 0, end: rightLine.length }] : [],
		};
	}

	const table: number[][] = Array.from({ length: leftCount + 1 }, () =>
		Array<number>(rightCount + 1).fill(0),
	);

	for (let leftIndex = 1; leftIndex <= leftCount; leftIndex++) {
		const leftToken = leftTokens[leftIndex - 1];
		for (let rightIndex = 1; rightIndex <= rightCount; rightIndex++) {
			const rightToken = rightTokens[rightIndex - 1];
			if (leftToken?.value === rightToken?.value) {
				table[leftIndex][rightIndex] = (table[leftIndex - 1]?.[rightIndex - 1] ?? 0) + 1;
			} else {
				const top = table[leftIndex - 1]?.[rightIndex] ?? 0;
				const side = table[leftIndex]?.[rightIndex - 1] ?? 0;
				table[leftIndex][rightIndex] = Math.max(top, side);
			}
		}
	}

	const changedLeft = new Set<number>();
	const changedRight = new Set<number>();
	let leftCursor = leftCount;
	let rightCursor = rightCount;

	while (leftCursor > 0 && rightCursor > 0) {
		const leftToken = leftTokens[leftCursor - 1];
		const rightToken = rightTokens[rightCursor - 1];
		if (leftToken?.value === rightToken?.value) {
			leftCursor--;
			rightCursor--;
			continue;
		}

		const top = table[leftCursor - 1]?.[rightCursor] ?? 0;
		const side = table[leftCursor]?.[rightCursor - 1] ?? 0;
		if (top >= side) {
			changedLeft.add(leftCursor - 1);
			leftCursor--;
		} else {
			changedRight.add(rightCursor - 1);
			rightCursor--;
		}
	}

	while (leftCursor > 0) {
		changedLeft.add(leftCursor - 1);
		leftCursor--;
	}
	while (rightCursor > 0) {
		changedRight.add(rightCursor - 1);
		rightCursor--;
	}

	return {
		left: tokensToDiffSpans(leftLine, leftTokens, changedLeft),
		right: tokensToDiffSpans(rightLine, rightTokens, changedRight),
	};
}

function getCompactLineRenderContent(entry: DiffLineEntry, showHashlineAnchors: boolean): string {
	return showHashlineAnchors && entry.hashlineAnchorContent
		? entry.hashlineAnchorContent
		: entry.content;
}

function buildInlineHighlightMap(rows: SplitDiffRow[]): WeakMap<DiffLineEntry, DiffSpan[]> {
	const highlights = new WeakMap<DiffLineEntry, DiffSpan[]>();

	for (const row of rows) {
		if (!row.left || !row.right) {
			continue;
		}
		if (row.left.lineKind !== "remove" || row.right.lineKind !== "add") {
			continue;
		}

		const leftText = normalizeCodeWhitespace(row.left.content);
		const rightText = normalizeCodeWhitespace(row.right.content);
		const inline = computeInlineDiffSpans(leftText, rightText);
		if (inline.left.length > 0) {
			highlights.set(row.left, inline.left);
		}
		if (inline.right.length > 0) {
			highlights.set(row.right, inline.right);
		}
	}

	return highlights;
}

function ansi256ToRgb(code: number): RgbColor {
	if (code < 0) {
		return { r: 0, g: 0, b: 0 };
	}
	if (code <= 15) {
		const base16: RgbColor[] = [
			{ r: 0, g: 0, b: 0 },
			{ r: 128, g: 0, b: 0 },
			{ r: 0, g: 128, b: 0 },
			{ r: 128, g: 128, b: 0 },
			{ r: 0, g: 0, b: 128 },
			{ r: 128, g: 0, b: 128 },
			{ r: 0, g: 128, b: 128 },
			{ r: 192, g: 192, b: 192 },
			{ r: 128, g: 128, b: 128 },
			{ r: 255, g: 0, b: 0 },
			{ r: 0, g: 255, b: 0 },
			{ r: 255, g: 255, b: 0 },
			{ r: 0, g: 0, b: 255 },
			{ r: 255, g: 0, b: 255 },
			{ r: 0, g: 255, b: 255 },
			{ r: 255, g: 255, b: 255 },
		];
		return base16[code] ?? { r: 255, g: 255, b: 255 };
	}
	if (code >= 232) {
		const value = Math.max(0, Math.min(255, 8 + (code - 232) * 10));
		return { r: value, g: value, b: value };
	}

	const cube = code - 16;
	const levels = [0, 95, 135, 175, 215, 255];
	const blue = cube % 6;
	const green = Math.floor(cube / 6) % 6;
	const red = Math.floor(cube / 36) % 6;
	return {
		r: levels[red] ?? 0,
		g: levels[green] ?? 0,
		b: levels[blue] ?? 0,
	};
}

function parseAnsiColorCode(ansi: string | undefined): RgbColor | null {
	if (!ansi) {
		return null;
	}
	const rgbMatch = /\x1b\[(?:3|4)8;2;(\d{1,3});(\d{1,3});(\d{1,3})m/.exec(ansi);
	if (rgbMatch) {
		const r = Number.parseInt(rgbMatch[1] ?? "0", 10);
		const g = Number.parseInt(rgbMatch[2] ?? "0", 10);
		const b = Number.parseInt(rgbMatch[3] ?? "0", 10);
		if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
			return {
				r: Math.max(0, Math.min(255, r)),
				g: Math.max(0, Math.min(255, g)),
				b: Math.max(0, Math.min(255, b)),
			};
		}
	}

	const bitMatch = /\x1b\[(?:3|4)8;5;(\d{1,3})m/.exec(ansi);
	if (bitMatch) {
		const code = Number.parseInt(bitMatch[1] ?? "0", 10);
		if (Number.isFinite(code)) {
			return ansi256ToRgb(code);
		}
	}

	const basicMatch = /\x1b\[(?:3|4)([0-7])m/.exec(ansi);
	if (basicMatch) return ansi256ToRgb(Number(basicMatch[1]));
	const brightMatch = /\x1b\[(?:9|10)([0-7])m/.exec(ansi);
	if (brightMatch) return ansi256ToRgb(Number(brightMatch[1]) + 8);
	return null;
}

function rgbToBgAnsi(color: RgbColor): string {
	const r = Math.max(0, Math.min(255, Math.round(color.r)));
	const g = Math.max(0, Math.min(255, Math.round(color.g)));
	const b = Math.max(0, Math.min(255, Math.round(color.b)));
	return `\x1b[48;2;${r};${g};${b}m`;
}

function mixRgb(base: RgbColor, tint: RgbColor, ratio: number): RgbColor {
	const clamped = Math.max(0, Math.min(1, ratio));
	return {
		r: base.r * (1 - clamped) + tint.r * clamped,
		g: base.g * (1 - clamped) + tint.g * clamped,
		b: base.b * (1 - clamped) + tint.b * clamped,
	};
}

function extractThemeBackgroundAnsi(text: string): string | undefined {
	if (!text || !text.includes("\x1b[")) {
		return undefined;
	}

	ANSI_SGR_PATTERN.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = ANSI_SGR_PATTERN.exec(text)) !== null) {
		const parsed = toSgrParams(match[1] ?? "");
		for (let index = 0; index < parsed.length; index += 1) {
			const param = parsed[index] ?? 0;
			if ((param >= 40 && param <= 47) || (param >= 100 && param <= 107)) {
				return `\x1b[${param}m`;
			}

			const colorSequence = readSgrColorSequence(parsed, index);
			if (colorSequence?.[0] === 48) {
				return `\x1b[${colorSequence.join(";")}m`;
			}
			if (colorSequence) {
				index += colorSequence.length - 1;
			}
		}
	}

	return undefined;
}

function readThemeAnsi(theme: DiffTheme, kind: "fg" | "bg", slot: string): string | undefined {
	try {
		if (kind === "fg" && typeof theme.getFgAnsi === "function") {
			return theme.getFgAnsi(slot);
		}
		if (kind === "bg") {
			if (typeof theme.getBgAnsi === "function") {
				return theme.getBgAnsi(slot);
			}
			if (typeof theme.bg === "function") {
				return extractThemeBackgroundAnsi(theme.bg(slot, " "));
			}
		}
	} catch {
		return undefined;
	}
	return undefined;
}

function resolveDiffPalette(theme: DiffTheme): DiffPalette {
	const baseBg = parseAnsiColorCode(readThemeAnsi(theme, "bg", "toolSuccessBg")) ??
		parseAnsiColorCode(readThemeAnsi(theme, "bg", "toolPendingBg")) ??
		parseAnsiColorCode(readThemeAnsi(theme, "bg", "userMessageBg")) ?? { r: 32, g: 35, b: 42 };
	const addFg = parseAnsiColorCode(readThemeAnsi(theme, "fg", "toolDiffAdded")) ?? {
		r: 88,
		g: 173,
		b: 88,
	};
	const removeFg = parseAnsiColorCode(readThemeAnsi(theme, "fg", "toolDiffRemoved")) ?? {
		r: 196,
		g: 98,
		b: 98,
	};
	const addTint = mixRgb(addFg, ADDITION_TINT_TARGET, 0.35);
	const removeTint = mixRgb(removeFg, DELETION_TINT_TARGET, 0.65);

	const addRowBg = mixRgb(baseBg, addTint, ADD_ROW_BACKGROUND_MIX_RATIO);
	const removeRowBg = mixRgb(baseBg, removeTint, REMOVE_ROW_BACKGROUND_MIX_RATIO);
	const addEmphasisBg = mixRgb(baseBg, addTint, ADD_INLINE_EMPHASIS_MIX_RATIO);
	const removeEmphasisBg = mixRgb(baseBg, removeTint, REMOVE_INLINE_EMPHASIS_MIX_RATIO);

	return {
		addRowBgAnsi: rgbToBgAnsi(addRowBg),
		removeRowBgAnsi: rgbToBgAnsi(removeRowBg),
		addEmphasisBgAnsi: rgbToBgAnsi(addEmphasisBg),
		removeEmphasisBgAnsi: rgbToBgAnsi(removeEmphasisBg),
	};
}

function getLineBackground(
	kind: DiffLineKind,
	palette: DiffPalette,
	emphasis: boolean,
): string | undefined {
	if (kind === "add") {
		return emphasis ? palette.addEmphasisBgAnsi : palette.addRowBgAnsi;
	}
	if (kind === "remove") {
		return emphasis ? palette.removeEmphasisBgAnsi : palette.removeRowBgAnsi;
	}
	return undefined;
}

function applyBackgroundToVisibleRange(
	ansiText: string,
	start: number,
	end: number,
	backgroundAnsi: string,
	restoreBackgroundAnsi: string,
): string {
	if (!ansiText || start >= end || end <= 0) {
		return ansiText;
	}

	const rangeStart = Math.max(0, start);
	const rangeEnd = Math.max(rangeStart, end);
	let output = "";
	let visibleIndex = 0;
	let index = 0;
	let inRange = false;

	while (index < ansiText.length) {
		if (ansiText[index] === "\x1b") {
			const sequenceEnd = ansiText.indexOf("m", index);
			if (sequenceEnd !== -1) {
				output += ansiText.slice(index, sequenceEnd + 1);
				index = sequenceEnd + 1;
				continue;
			}
		}

		if (visibleIndex === rangeStart && !inRange) {
			output += backgroundAnsi;
			inRange = true;
		}
		if (visibleIndex === rangeEnd && inRange) {
			output += restoreBackgroundAnsi;
			inRange = false;
		}

		output += ansiText[index] ?? "";
		visibleIndex++;
		index++;
	}

	if (inRange) {
		output += restoreBackgroundAnsi;
	}

	return output;
}

function applyInlineSpanHighlight(
	plainText: string,
	renderedText: string,
	spans: DiffSpan[],
	emphasisBgAnsi: string | undefined,
	rowBgAnsi: string | undefined,
	fallbackBgAnsi: string | undefined,
): string {
	if (!renderedText || !plainText || spans.length === 0 || !emphasisBgAnsi) {
		return renderedText;
	}

	const sorted = mergeSpans(
		spans
			.map((span) => ({
				start: Math.max(0, Math.min(plainText.length, span.start)),
				end: Math.max(0, Math.min(plainText.length, span.end)),
			}))
			.filter((span) => span.end > span.start),
	);
	if (sorted.length === 0) {
		return renderedText;
	}

	const restoreBackgroundAnsi = rowBgAnsi ?? fallbackBgAnsi ?? ANSI_BG_RESET;
	let highlighted = renderedText;
	for (let index = sorted.length - 1; index >= 0; index--) {
		const span = sorted[index];
		if (!span) {
			continue;
		}
		highlighted = applyBackgroundToVisibleRange(
			highlighted,
			span.start,
			span.end,
			emphasisBgAnsi,
			restoreBackgroundAnsi,
		);
	}

	return highlighted;
}

function resolveDiffIndicatorMode(
	config: Partial<Pick<ToolDisplayConfig, "diffIndicatorMode">>,
): DiffIndicatorMode {
	return config.diffIndicatorMode ?? DEFAULT_TOOL_DISPLAY_CONFIG.diffIndicatorMode;
}

/** Snapshot or live getter — panel changes must apply on the next paint. */
export type DisplayConfigInput = ToolDisplayConfig | (() => ToolDisplayConfig);

const RICH_DIFF_COMPONENT = Symbol.for("pi.ccstyle.rich-diff-component");

export function isRichDiffComponent(value: unknown): boolean {
	return Boolean(
		value && typeof value === "object" && (value as any)[RICH_DIFF_COMPONENT] === true,
	);
}

function resolveLiveDisplayConfig(input: DisplayConfigInput): ToolDisplayConfig {
	return typeof input === "function" ? input() : input;
}

/** Cache key fragment so indicator/wrap/limits invalidate without host recreate. */
function displayConfigCacheKey(config: ToolDisplayConfig): string {
	return [
		config.diffViewMode,
		config.diffIndicatorMode,
		String(config.diffSplitMinWidth),
		String(config.editDiffCollapsedLines),
		String(config.writeDiffCollapsedLines),
		config.diffWordWrap ? "1" : "0",
		String(config.expandedPreviewMaxLines),
	].join(":");
}

function resolveIndicatorGlyph(
	kind: DiffLineKind,
	indicatorMode: DiffIndicatorMode,
	continuation: boolean,
): string {
	if (kind === "context") {
		return " ";
	}

	switch (indicatorMode) {
		case "bars":
			return "▌";
		case "classic":
			if (continuation) {
				return " ";
			}
			return kind === "add" ? "+" : "-";
		case "none":
		default:
			return " ";
	}
}

function colorizeSegment(
	theme: DiffTheme,
	color: "dim" | "toolDiffAdded" | "toolDiffRemoved",
	text: string,
	rowBg: string | undefined,
): string {
	let themedText: string;
	try {
		themedText = theme.fg(color, text);
	} catch {
		themedText = text;
	}

	if (!rowBg) {
		return themedText;
	}

	const stableText = keepBackgroundAcrossResets(themedText, rowBg);
	return `${rowBg}${stableText}${rowBg}`;
}

function keepBackgroundAcrossResets(text: string, rowBg: string): string {
	if (!text) {
		return text;
	}

	return text.replace(ANSI_SGR_PATTERN, (sequence, rawParams: string) => {
		const params = toSgrParams(rawParams);
		if (params.length === 0 || !sequenceResetsBackground(params)) {
			return sequence;
		}
		return `${sequence}${rowBg}`;
	});
}

function renderChangeMarker(
	kind: DiffLineKind,
	theme: DiffTheme,
	rowBg: string | undefined,
	indicatorMode: DiffIndicatorMode,
	continuation = false,
): string {
	const glyph = resolveIndicatorGlyph(kind, indicatorMode, continuation);
	if (glyph === " ") {
		return rowBg ? `${rowBg} ${rowBg}` : " ";
	}
	if (kind === "add") {
		return colorizeSegment(theme, "toolDiffAdded", glyph, rowBg);
	}
	if (kind === "remove") {
		return colorizeSegment(theme, "toolDiffRemoved", glyph, rowBg);
	}
	return colorizeSegment(theme, "dim", glyph, rowBg);
}

function usesHashlineGutter(showHashlineAnchors: boolean): boolean {
	return showHashlineAnchors;
}

function getHashlineGutterMarkerWidth(_indicatorMode: DiffIndicatorMode): number {
	return 0;
}

function getLineDividerPlainWidth(
	indicatorMode: DiffIndicatorMode,
	hashlineGutter = false,
): number {
	if (hashlineGutter) {
		return 2;
	}
	return indicatorMode === "classic" ? 1 : 2;
}

function renderCodeDivider(
	theme: DiffTheme,
	rowBg: string | undefined,
	indicatorMode: DiffIndicatorMode,
	hashlineGutter = false,
): string {
	return colorizeSegment(
		theme,
		"dim",
		hashlineGutter || indicatorMode !== "classic" ? "│ " : "│",
		rowBg,
	);
}

function getLineNumberColor(kind: DiffLineKind): "dim" | "toolDiffAdded" | "toolDiffRemoved" {
	if (kind === "add") {
		return "toolDiffAdded";
	}
	if (kind === "remove") {
		return "toolDiffRemoved";
	}
	return "dim";
}

function renderLineNumberSegment(
	kind: DiffLineKind,
	lineNumber: string,
	theme: DiffTheme,
	rowBg: string | undefined,
): string {
	return colorizeSegment(theme, getLineNumberColor(kind), lineNumber, rowBg);
}

function getLinePrefixPlainWidth(
	lineNumberWidth: number,
	indicatorMode: DiffIndicatorMode,
	hashlineGutter = false,
): number {
	if (hashlineGutter) {
		return getHashlineGutterMarkerWidth(indicatorMode) + lineNumberWidth;
	}
	return indicatorMode === "bars"
		? visibleWidth(`▌ ${" ".repeat(lineNumberWidth)} `)
		: visibleWidth(`${" ".repeat(lineNumberWidth)} `);
}

function getLineContentIndicatorPrefixPlainWidth(indicatorMode: DiffIndicatorMode): number {
	return indicatorMode === "classic" ? 2 : 0;
}

function renderClassicContentPrefix(
	kind: DiffLineKind,
	theme: DiffTheme,
	rowBg: string | undefined,
	continuation = false,
): string {
	if (kind === "context" || continuation) {
		return rowBg ? `${rowBg}  ${rowBg}` : "  ";
	}

	const glyph = kind === "add" ? "+" : "-";
	const glyphColor = kind === "add" ? "toolDiffAdded" : "toolDiffRemoved";
	const spacer = rowBg ? `${rowBg} ` : " ";
	return `${colorizeSegment(theme, glyphColor, glyph, rowBg)}${spacer}`;
}

function renderLinePrefix(
	kind: DiffLineKind,
	lineNumber: string,
	theme: DiffTheme,
	rowBg: string | undefined,
	indicatorMode: DiffIndicatorMode,
	continuation = false,
	hashlineGutter = false,
): string {
	const number = renderLineNumberSegment(kind, lineNumber, theme, rowBg);
	if (hashlineGutter) {
		return number;
	}
	const spacer = rowBg ? `${rowBg} ` : " ";
	if (indicatorMode !== "bars") {
		return `${number}${spacer}`;
	}
	const marker = renderChangeMarker(kind, theme, rowBg, indicatorMode, continuation);
	return `${marker}${spacer}${number}${spacer}`;
}

function renderLineContinuationPrefix(
	kind: DiffLineKind,
	lineNumberWidth: number,
	rowBg: string | undefined,
	theme: DiffTheme,
	indicatorMode: DiffIndicatorMode,
	hashlineGutter = false,
): string {
	const blankLineNumber = " ".repeat(lineNumberWidth);
	return renderLinePrefix(kind, blankLineNumber, theme, rowBg, indicatorMode, true, hashlineGutter);
}

function renderLineContentIndicatorPrefix(
	kind: DiffLineKind,
	theme: DiffTheme,
	rowBg: string | undefined,
	indicatorMode: DiffIndicatorMode,
	continuation = false,
): string {
	return indicatorMode === "classic"
		? renderClassicContentPrefix(kind, theme, rowBg, continuation)
		: "";
}

function renderCompactLinePrefix(
	kind: DiffLineKind,
	theme: DiffTheme,
	rowBg: string | undefined,
	indicatorMode: DiffIndicatorMode,
	continuation = false,
): string {
	const marker = renderChangeMarker(kind, theme, rowBg, indicatorMode, continuation);
	const spacer = rowBg ? `${rowBg} ` : " ";
	return `${marker}${spacer}`;
}

interface LineCellRenderParams {
	kind: DiffLineKind;
	code: string;
	width: number;
	rowBg: string | undefined;
	restoreBgAnsi: string | undefined;
	theme: DiffTheme;
	wordWrap: boolean;
	indicatorMode: DiffIndicatorMode;
}

function renderWrappedRowsWithOptionalBackground(
	wrappedCodeLines: string[],
	buildRow: (index: number, wrappedCodeLine: string) => string,
	width: number,
	rowBg: string | undefined,
	restoreBgAnsi: string | undefined,
): string[] {
	if (!rowBg) {
		return wrappedCodeLines.map((wrappedCodeLine, index) =>
			stabilizeBackgroundResets(buildRow(index, wrappedCodeLine)),
		);
	}
	const safeRestoreBgAnsi = restoreBgAnsi ?? rowBg ?? ANSI_BG_RESET;
	const visualRows = wrappedCodeLines.map((wrappedCodeLine, index) =>
		buildRow(index, wrappedCodeLine),
	);
	return applyLineBackgroundToWrappedRows(visualRows, width, rowBg, safeRestoreBgAnsi);
}

function computeLineCellCodeWidth(
	width: number,
	lineNumberWidth: number,
	indicatorMode: DiffIndicatorMode,
	hashlineGutter: boolean,
): number {
	const prefixPlainWidth = getLinePrefixPlainWidth(lineNumberWidth, indicatorMode, hashlineGutter);
	const dividerPlainWidth = getLineDividerPlainWidth(indicatorMode, hashlineGutter);
	const contentIndicatorWidth = hashlineGutter
		? 0
		: getLineContentIndicatorPrefixPlainWidth(indicatorMode);
	return Math.max(0, width - prefixPlainWidth - dividerPlainWidth - contentIndicatorWidth);
}

function buildLineCellParams(
	kind: DiffLineKind,
	code: string,
	width: number,
	rowBg: string | undefined,
	restoreBgAnsi: string | undefined,
	theme: DiffTheme,
	wordWrap: boolean,
	indicatorMode: DiffIndicatorMode,
): LineCellRenderParams {
	return { kind, code, width, rowBg, restoreBgAnsi, theme, wordWrap, indicatorMode };
}

function renderCompactLineCell({
	kind,
	code,
	width,
	rowBg,
	restoreBgAnsi,
	theme,
	wordWrap,
	indicatorMode,
}: LineCellRenderParams): string[] {
	if (width <= 0) {
		return [""];
	}

	const prefix = renderCompactLinePrefix(kind, theme, undefined, indicatorMode);
	const continuationPrefix = renderCompactLinePrefix(kind, theme, undefined, indicatorMode, true);
	const prefixPlainWidth = 2;
	const codeWidth = Math.max(0, width - prefixPlainWidth);
	const wrappedCodeLines = wrapToWidth(code, codeWidth, wordWrap);
	return renderWrappedRowsWithOptionalBackground(
		wrappedCodeLines,
		(index, line) => `${index === 0 ? prefix : continuationPrefix}${line}`,
		width,
		rowBg,
		restoreBgAnsi,
	);
}

function renderLineCell(
	{ kind, code, width, rowBg, restoreBgAnsi, theme, wordWrap, indicatorMode }: LineCellRenderParams,
	lineNumber: string,
	hashlineGutter = false,
): string[] {
	if (width <= 0) {
		return [""];
	}

	const codeWidth = computeLineCellCodeWidth(
		width,
		lineNumber.length,
		indicatorMode,
		hashlineGutter,
	);
	const prefix = renderLinePrefix(
		kind,
		lineNumber,
		theme,
		undefined,
		indicatorMode,
		false,
		hashlineGutter,
	);
	const continuationPrefix = renderLineContinuationPrefix(
		kind,
		lineNumber.length,
		undefined,
		theme,
		indicatorMode,
		hashlineGutter,
	);
	const divider = renderCodeDivider(theme, undefined, indicatorMode, hashlineGutter);
	const firstContentPrefix = hashlineGutter
		? ""
		: renderLineContentIndicatorPrefix(kind, theme, undefined, indicatorMode);
	const continuationContentPrefix = hashlineGutter
		? ""
		: renderLineContentIndicatorPrefix(kind, theme, undefined, indicatorMode, true);
	const wrappedCodeLines = wrapToWidth(code, codeWidth, wordWrap);
	return renderWrappedRowsWithOptionalBackground(
		wrappedCodeLines,
		(index, line) => {
			const linePrefix = index === 0 ? prefix : continuationPrefix;
			const contentPrefix = index === 0 ? firstContentPrefix : continuationContentPrefix;
			return `${linePrefix}${divider}${contentPrefix}${line}`;
		},
		width,
		rowBg,
		restoreBgAnsi,
	);
}

function highlightDiffLine(
	codeText: string,
	entry: DiffLineEntry,
	inlineHighlights: WeakMap<DiffLineEntry, DiffSpan[]>,
	palette: DiffPalette,
	highlightLine: CodeLineHighlighter,
	containerBgAnsi: string | undefined,
): { highlighted: string; rowBg: string | undefined } {
	const syntaxHighlighted = highlightLine(codeText, entry);
	const rowBg = getLineBackground(entry.lineKind, palette, false);
	const emphasisBg = getLineBackground(entry.lineKind, palette, true);
	const inlineSpans = inlineHighlights.get(entry) ?? [];
	const highlighted = applyInlineSpanHighlight(
		codeText,
		syntaxHighlighted,
		inlineSpans,
		emphasisBg,
		rowBg,
		containerBgAnsi,
	);
	return { highlighted, rowBg };
}

function pushDiffLineRows(rows: RenderedRow[], lines: string[], entry: DiffLineEntry): void {
	rows.push(
		...lines.map((text) => ({
			text,
			hunkIndex: entry.hunkIndex || null,
		})),
	);
}

interface DiffRenderContext {
	width: number;
	theme: DiffTheme;
	inlineHighlights: WeakMap<DiffLineEntry, DiffSpan[]>;
	palette: DiffPalette;
	highlightLine: CodeLineHighlighter;
	containerBgAnsi: string | undefined;
	wordWrap: boolean;
	indicatorMode: DiffIndicatorMode;
	showHashlineAnchors: boolean;
}

function processDiffEntries(
	entries: ParsedDiffEntry[],
	ctx: DiffRenderContext,
	processLine: (entry: DiffLineEntry) => string[],
): RenderedRow[] {
	const { width, theme, wordWrap } = ctx;
	const rows: RenderedRow[] = [];
	for (const entry of entries) {
		if (entry.kind !== "line") {
			rows.push(...formatMetaEntryRows(entry, width, theme, wordWrap));
			continue;
		}
		pushDiffLineRows(rows, processLine(entry), entry);
	}
	return rows;
}

function renderUnified(
	entries: ParsedDiffEntry[],
	ctx: DiffRenderContext,
	lineNumberWidth: number,
): RenderedRow[] {
	return processDiffEntries(entries, ctx, (entry) => {
		const lineNumber =
			entry.lineKind === "add"
				? formatLineNumberLabel(
						entry,
						entry.newLineNumber,
						entry.fallbackLineNumber,
						lineNumberWidth,
						ctx.showHashlineAnchors,
					)
				: formatLineNumberLabel(
						entry,
						entry.oldLineNumber,
						entry.fallbackLineNumber,
						lineNumberWidth,
						ctx.showHashlineAnchors,
					);
		const codeText = normalizeCodeWhitespace(entry.content);
		const { highlighted, rowBg } = highlightDiffLine(
			codeText,
			entry,
			ctx.inlineHighlights,
			ctx.palette,
			ctx.highlightLine,
			ctx.containerBgAnsi,
		);
		return renderLineCell(
			buildLineCellParams(
				entry.lineKind,
				highlighted,
				ctx.width,
				rowBg,
				ctx.containerBgAnsi,
				ctx.theme,
				ctx.wordWrap,
				ctx.indicatorMode,
			),
			lineNumber,
			usesHashlineGutter(ctx.showHashlineAnchors),
		);
	});
}

function toUnifiedFallbackRows(
	rows: SplitDiffRow[],
	ctx: DiffRenderContext,
	lineNumberWidth: number,
): RenderedRow[] {
	const flattened: ParsedDiffEntry[] = [];
	for (const row of rows) {
		if (row.meta) {
			flattened.push(row.meta);
			continue;
		}
		if (row.left) {
			flattened.push(row.left);
		}
		if (row.right && row.right !== row.left) {
			flattened.push(row.right);
		}
	}
	return renderUnified(flattened, ctx, lineNumberWidth);
}

function renderCompact(entries: ParsedDiffEntry[], ctx: DiffRenderContext): RenderedRow[] {
	return processDiffEntries(entries, ctx, (entry) => {
		const codeText = normalizeCodeWhitespace(
			getCompactLineRenderContent(entry, ctx.showHashlineAnchors),
		);
		const { highlighted, rowBg } = highlightDiffLine(
			codeText,
			entry,
			ctx.inlineHighlights,
			ctx.palette,
			ctx.highlightLine,
			ctx.containerBgAnsi,
		);
		return renderCompactLineCell(
			buildLineCellParams(
				entry.lineKind,
				highlighted,
				ctx.width,
				rowBg,
				ctx.containerBgAnsi,
				ctx.theme,
				ctx.wordWrap,
				ctx.indicatorMode,
			),
		);
	});
}

function renderSplitBlankCell(
	columnWidth: number,
	lineNumberWidth: number,
	theme: DiffTheme,
	indicatorMode: DiffIndicatorMode,
	hashlineGutter = false,
): string {
	const codeWidth = computeLineCellCodeWidth(
		columnWidth,
		lineNumberWidth,
		indicatorMode,
		hashlineGutter,
	);
	const prefix = renderLinePrefix(
		"context",
		" ".repeat(lineNumberWidth),
		theme,
		undefined,
		indicatorMode,
		true,
		hashlineGutter,
	);
	const divider = renderCodeDivider(theme, undefined, indicatorMode, hashlineGutter);
	const contentPrefix = hashlineGutter
		? ""
		: renderLineContentIndicatorPrefix("context", theme, undefined, indicatorMode, true);
	return stabilizeBackgroundResets(`${prefix}${divider}${contentPrefix}${" ".repeat(codeWidth)}`);
}

function renderSplitCell(
	line: DiffLineEntry | undefined,
	side: "left" | "right",
	columnWidth: number,
	lineNumberWidth: number,
	theme: DiffTheme,
	inlineHighlights: WeakMap<DiffLineEntry, DiffSpan[]>,
	palette: DiffPalette,
	highlightLine: CodeLineHighlighter,
	containerBgAnsi: string | undefined,
	wordWrap: boolean,
	indicatorMode: DiffIndicatorMode,
	showHashlineAnchors: boolean,
): string[] {
	const hashlineGutter = usesHashlineGutter(showHashlineAnchors);
	if (!line) {
		return [
			renderSplitBlankCell(columnWidth, lineNumberWidth, theme, indicatorMode, hashlineGutter),
		];
	}

	const lineNumber = formatLineNumberLabel(
		line,
		getCellLineNumber(line, side),
		line.fallbackLineNumber,
		lineNumberWidth,
		showHashlineAnchors,
	);
	const codeText = normalizeCodeWhitespace(line.content);
	const { highlighted, rowBg } = highlightDiffLine(
		codeText,
		line,
		inlineHighlights,
		palette,
		highlightLine,
		containerBgAnsi,
	);
	return renderLineCell(
		buildLineCellParams(
			line.lineKind,
			highlighted,
			columnWidth,
			rowBg,
			containerBgAnsi,
			theme,
			wordWrap,
			indicatorMode,
		),
		lineNumber,
		hashlineGutter,
	);
}

function renderSplitDivider(
	theme: DiffTheme,
	containerBgAnsi: string | undefined,
	separatorText: string = SPLIT_SEPARATOR,
): string {
	const dimAnsi = readThemeAnsi(theme, "fg", "dim");
	if (!containerBgAnsi) {
		return stabilizeBackgroundResets(theme.fg("dim", separatorText));
	}
	if (!dimAnsi) {
		return stabilizeBackgroundResets(
			`${containerBgAnsi}${theme.fg("dim", separatorText)}${containerBgAnsi}`,
		);
	}
	return stabilizeBackgroundResets(
		`${containerBgAnsi}${dimAnsi}${separatorText}\x1b[39m${containerBgAnsi}`,
	);
}

function renderSplitTopBorderCell(
	columnWidth: number,
	lineNumberWidth: number,
	theme: DiffTheme,
	indicatorMode: DiffIndicatorMode,
	hashlineGutter = false,
): string {
	const safeColumnWidth = Math.max(1, columnWidth);
	const chars = "─".repeat(safeColumnWidth).split("");
	const dividerIndex = getLinePrefixPlainWidth(lineNumberWidth, indicatorMode, hashlineGutter);
	if (dividerIndex >= 0 && dividerIndex < chars.length) {
		chars[dividerIndex] = "┬";
	}
	return stabilizeBackgroundResets(theme.fg("dim", chars.join("")));
}

function renderSplitHeaderCell(
	label: string,
	columnWidth: number,
	lineNumberWidth: number,
	theme: DiffTheme,
	indicatorMode: DiffIndicatorMode,
	hashlineGutter = false,
): string {
	const markerPad = hashlineGutter
		? " ".repeat(getHashlineGutterMarkerWidth(indicatorMode))
		: indicatorMode === "bars"
			? "  "
			: "";
	const lineNumberLabel = fitToWidth(label, lineNumberWidth);
	const lineNumberSpacer = hashlineGutter ? "" : " ";
	const divider = hashlineGutter || indicatorMode !== "classic" ? "│ " : "│";
	const prefix = `${theme.fg("dim", markerPad)}${theme.fg("muted", lineNumberLabel)}${theme.fg("dim", lineNumberSpacer)}${theme.fg("dim", divider)}`;
	const prefixWidth = visibleWidth(`${markerPad}${lineNumberLabel}${lineNumberSpacer}${divider}`);
	const contentIndicatorWidth = hashlineGutter
		? 0
		: getLineContentIndicatorPrefixPlainWidth(indicatorMode);
	const codeWidth = Math.max(0, columnWidth - prefixWidth - contentIndicatorWidth);
	const contentPad = !hashlineGutter && indicatorMode === "classic" ? "  " : "";
	return stabilizeBackgroundResets(`${prefix}${contentPad}${" ".repeat(codeWidth)}`);
}

function canRenderSplitLayout(width: number): boolean {
	const separatorWidth = visibleWidth(SPLIT_SEPARATOR);
	const minimumSplitWidth = MIN_SPLIT_COLUMN_WIDTH * 2 + separatorWidth;
	return width >= minimumSplitWidth;
}

function renderSplit(
	rows: SplitDiffRow[],
	ctx: DiffRenderContext,
	lineNumberWidth: number,
): RenderedRow[] {
	const {
		width,
		theme,
		inlineHighlights,
		palette,
		highlightLine,
		containerBgAnsi,
		wordWrap,
		indicatorMode,
		showHashlineAnchors,
	} = ctx;
	if (!canRenderSplitLayout(width)) {
		return toUnifiedFallbackRows(rows, ctx, lineNumberWidth);
	}

	const separatorWidth = visibleWidth(SPLIT_SEPARATOR);
	const leftWidth = Math.max(MIN_SPLIT_COLUMN_WIDTH, Math.floor((width - separatorWidth) / 2));
	const rightWidth = Math.max(MIN_SPLIT_COLUMN_WIDTH, width - separatorWidth - leftWidth);
	const splitLineNumberWidth = Math.max(3, lineNumberWidth);
	const hashlineGutter = usesHashlineGutter(showHashlineAnchors);
	const separator = renderSplitDivider(theme, containerBgAnsi);
	const topSeparator = renderSplitDivider(theme, containerBgAnsi, "─┬─");
	const output: RenderedRow[] = [];
	output.push({
		text: `${renderSplitTopBorderCell(leftWidth, splitLineNumberWidth, theme, indicatorMode, hashlineGutter)}${topSeparator}${renderSplitTopBorderCell(rightWidth, splitLineNumberWidth, theme, indicatorMode, hashlineGutter)}`,
		hunkIndex: null,
	});
	output.push({
		text: `${renderSplitHeaderCell("old", leftWidth, splitLineNumberWidth, theme, indicatorMode, hashlineGutter)}${separator}${renderSplitHeaderCell("new", rightWidth, splitLineNumberWidth, theme, indicatorMode, hashlineGutter)}`,
		hunkIndex: null,
	});

	for (const row of rows) {
		if (row.meta) {
			output.push(...formatMetaEntryRows(row.meta, width, theme, wordWrap));
			continue;
		}

		const leftCells = renderSplitCell(
			row.left,
			"left",
			leftWidth,
			splitLineNumberWidth,
			theme,
			inlineHighlights,
			palette,
			highlightLine,
			containerBgAnsi,
			wordWrap,
			indicatorMode,
			showHashlineAnchors,
		);
		const rightCells = renderSplitCell(
			row.right,
			"right",
			rightWidth,
			splitLineNumberWidth,
			theme,
			inlineHighlights,
			palette,
			highlightLine,
			containerBgAnsi,
			wordWrap,
			indicatorMode,
			showHashlineAnchors,
		);

		const rowCount = Math.max(leftCells.length, rightCells.length);
		for (let index = 0; index < rowCount; index++) {
			const leftCell =
				leftCells[index] ??
				renderSplitBlankCell(leftWidth, splitLineNumberWidth, theme, indicatorMode, hashlineGutter);
			const rightCell =
				rightCells[index] ??
				renderSplitBlankCell(
					rightWidth,
					splitLineNumberWidth,
					theme,
					indicatorMode,
					hashlineGutter,
				);
			output.push({ text: `${leftCell}${separator}${rightCell}`, hunkIndex: row.hunkIndex });
		}
	}

	return output;
}

function renderDiffStatBar(stats: DiffStats, width: number, theme: DiffTheme): string | null {
	const totalChanges = stats.added + stats.removed;
	if (totalChanges === 0 || width < 20) {
		return null;
	}

	const barSlots = Math.max(8, Math.min(24, Math.floor(width / 12)));
	let addedSlots = Math.max(
		0,
		Math.min(barSlots, Math.round((stats.added / totalChanges) * barSlots)),
	);
	if (stats.added > 0 && addedSlots === 0) {
		addedSlots = 1;
	}
	if (stats.removed > 0 && addedSlots >= barSlots) {
		addedSlots = barSlots - 1;
	}
	const removedSlots = Math.max(0, barSlots - addedSlots);

	const addedBar = addedSlots > 0 ? theme.fg("toolDiffAdded", "━".repeat(addedSlots)) : "";
	const removedBar = removedSlots > 0 ? theme.fg("toolDiffRemoved", "━".repeat(removedSlots)) : "";
	return stabilizeBackgroundResets(
		`${theme.fg("dim", "[")}${addedBar}${removedBar}${theme.fg("dim", "]")}`,
	);
}

function buildDiffSummaryBasePieces(stats: DiffStats, theme: DiffTheme): string[] {
	return [
		theme.fg("toolOutput", `↳ ${emphasis(theme, "diff")}`),
		theme.fg("toolDiffAdded", `+${stats.added}`),
		theme.fg("toolDiffRemoved", `-${stats.removed}`),
	];
}

function renderHeaderRows(
	stats: DiffStats,
	mode: Exclude<DiffPresentationMode, "summary">,
	width: number,
	theme: DiffTheme,
): RenderedRow[] {
	if (mode === "compact") {
		const summary = buildDiffSummaryBasePieces(stats, theme).join(" ");
		return [{ text: stabilizeBackgroundResets(truncateToWidth(summary, width)), hunkIndex: null }];
	}

	const summaryPieces = [...buildDiffSummaryBasePieces(stats, theme), theme.fg("muted", mode)];

	const summary = summaryPieces.join(mode === "split" ? " " : theme.fg("muted", " • "));
	const meter = renderDiffStatBar(stats, width, theme);
	if (!meter) {
		return [{ text: stabilizeBackgroundResets(truncateToWidth(summary, width)), hunkIndex: null }];
	}

	const meterSeparator = " ";
	const meterWidth = visibleWidth(meterSeparator) + visibleWidth(meter);
	if (meterWidth >= width) {
		return [{ text: stabilizeBackgroundResets(truncateToWidth(summary, width)), hunkIndex: null }];
	}

	const summaryWidth = Math.max(0, width - meterWidth);
	const fittedSummary = truncateToWidth(summary, summaryWidth);
	return [
		{
			text: stabilizeBackgroundResets(`${fittedSummary}${meterSeparator}${meter}`),
			hunkIndex: null,
		},
	];
}

function renderDiffFrameLine(width: number, theme: DiffTheme): string {
	const frameWidth = Math.max(0, width);
	if (frameWidth === 0) {
		return "";
	}
	return stabilizeBackgroundResets(theme.fg("dim", "─".repeat(frameWidth)));
}

function renderDiffSpacerLine(width: number): string {
	const safeWidth = Math.max(0, width);
	return safeWidth > 0 ? " ".repeat(safeWidth) : "";
}

function resolveDiffDisplayLimit(
	expanded: boolean,
	maxCollapsedLines: number,
	maxExpandedLines: number,
): number {
	const expandedLimit = typeof maxExpandedLines === "number" && Number.isFinite(maxExpandedLines)
		? maxExpandedLines
		: DEFAULT_TOOL_DISPLAY_CONFIG.expandedPreviewMaxLines;
	const collapsedLimit = typeof maxCollapsedLines === "number" && Number.isFinite(maxCollapsedLines)
		? maxCollapsedLines
		: DEFAULT_TOOL_DISPLAY_CONFIG.editDiffCollapsedLines;
	return expanded ? Math.max(0, expandedLimit) : Math.max(1, collapsedLimit);
}

/** Write collapsed body limit. Missing/NaN falls back to edit's limit. */
function resolveWriteCollapsedLimit(config: ToolDisplayConfig): number {
	const value = config.writeDiffCollapsedLines;
	if (typeof value === "number" && Number.isFinite(value)) {
		return Math.max(0, value);
	}
	const fallback = typeof config.editDiffCollapsedLines === "number" && Number.isFinite(config.editDiffCollapsedLines)
		? config.editDiffCollapsedLines
		: DEFAULT_TOOL_DISPLAY_CONFIG.writeDiffCollapsedLines ?? 0;
	return Math.max(0, fallback);
}

/**
 * How many source rows/entries to fully highlight+render before applyLineLimit.
 * Extra headroom covers word-wrap expansion so the display limit can still fill.
 */
function resolveDiffProcessBudget(displayLimit: number, wordWrap: boolean): number {
	if (!Number.isFinite(displayLimit) || displayLimit <= 0) {
		return Number.POSITIVE_INFINITY;
	}
	return wordWrap ? displayLimit * 2 + 8 : displayLimit + 4;
}

function countDiffLineEntries(entries: readonly ParsedDiffEntry[]): number {
	let count = 0;
	for (const entry of entries) {
		if (entry.kind === "line") count++;
	}
	return count;
}

function takeEntriesForLineBudget(
	entries: ParsedDiffEntry[],
	maxLineEntries: number,
): { entries: ParsedDiffEntry[]; totalLineEntries: number; processedLineEntries: number } {
	const totalLineEntries = countDiffLineEntries(entries);
	if (!Number.isFinite(maxLineEntries) || maxLineEntries >= totalLineEntries) {
		return { entries, totalLineEntries, processedLineEntries: totalLineEntries };
	}
	const limited: ParsedDiffEntry[] = [];
	let processedLineEntries = 0;
	for (const entry of entries) {
		if (entry.kind === "line") {
			if (processedLineEntries >= maxLineEntries) break;
			processedLineEntries++;
		}
		limited.push(entry);
	}
	return { entries: limited, totalLineEntries, processedLineEntries };
}

function takeSplitRowsForBudget(
	rows: SplitDiffRow[],
	maxRows: number,
): { rows: SplitDiffRow[]; totalRows: number; processedRows: number } {
	const totalRows = rows.length;
	if (!Number.isFinite(maxRows) || maxRows >= totalRows) {
		return { rows, totalRows, processedRows: totalRows };
	}
	const limited = rows.slice(0, maxRows);
	return { rows: limited, totalRows, processedRows: limited.length };
}

function applyLineLimit(
	rows: RenderedRow[],
	width: number,
	expanded: boolean,
	maxCollapsedLines: number,
	maxExpandedLines: number,
	totalHunks: number,
	theme: DiffTheme,
	/**
	 * When the caller only rendered a prefix of the full diff, pass the unprocessed
	 * remainder so the collapse hint still reflects total hidden content.
	 */
	unprocessedLogicalRows = 0,
	hovered = false,
): string[] {
	const limit = resolveDiffDisplayLimit(expanded, maxCollapsedLines, maxExpandedLines);
	const safeUnprocessed = Math.max(0, unprocessedLogicalRows);
	if (limit === 0 || (rows.length <= limit && safeUnprocessed === 0)) {
		return rows.map((row) => clampDiffLineToWidth(row.text, width));
	}

	const shown = rows.length <= limit ? rows : rows.slice(0, limit);
	const remaining = Math.max(0, rows.length - shown.length) + safeUnprocessed;
	if (remaining === 0) {
		return shown.map((row) => clampDiffLineToWidth(row.text, width));
	}
	const visibleHunks = new Set(
		shown
			.map((row) => row.hunkIndex)
			.filter((hunkIndex): hunkIndex is number => typeof hunkIndex === "number" && hunkIndex > 0),
	);
	const hiddenHunks = Math.max(0, totalHunks - visibleHunks.size);
	const hintText = buildCollapsedDiffHintText(
		{
			remainingLines: remaining,
			hiddenHunks,
		},
		width,
		DIFF_WIDTH_OPS,
	);

	const clickLabel = showMoreHintText();
	const clickIndex = hintText.lastIndexOf(clickLabel);
	const styledHint =
		hovered && !expanded && clickIndex >= 0
			? theme.fg("muted", hintText.slice(0, clickIndex)) +
				theme.fg("text", clickLabel) +
				theme.fg("muted", hintText.slice(clickIndex + clickLabel.length))
			: theme.fg(expanded ? "warning" : "muted", hintText);
	return [
		...shown.map((row) => clampDiffLineToWidth(row.text, width)),
		renderDiffSpacerLine(width),
		clampDiffLineToWidth(styledHint, width),
	];
}

function collectDiffStats(
	entries: ParsedDiffEntry[],
	fallbackHunks = 0,
	fallbackFiles = 0,
): DiffStats {
	const stats: DiffStats = {
		added: 0,
		removed: 0,
		context: 0,
		hunks: fallbackHunks,
		files: fallbackFiles,
		lines: entries.length,
	};

	const hunkIndexes = new Set<number>();
	let explicitFileCount = 0;

	for (const entry of entries) {
		if (entry.kind === "line") {
			if (entry.lineKind === "add") {
				stats.added++;
			} else if (entry.lineKind === "remove") {
				stats.removed++;
			} else {
				stats.context++;
			}
			if (entry.hunkIndex > 0) {
				hunkIndexes.add(entry.hunkIndex);
			}
			continue;
		}

		if (entry.kind === "hunk" && entry.hunkIndex > 0) {
			hunkIndexes.add(entry.hunkIndex);
		}
		if (entry.kind === "file") {
			explicitFileCount++;
		}
	}

	if (hunkIndexes.size > 0) {
		stats.hunks = Math.max(stats.hunks, hunkIndexes.size);
	}
	if (explicitFileCount > 0) {
		stats.files = Math.max(stats.files, explicitFileCount);
	} else if (entries.length > 0) {
		stats.files = Math.max(stats.files, 1);
	}
	if (stats.hunks === 0 && entries.some((entry) => entry.kind === "line")) {
		stats.hunks = 1;
	}

	return stats;
}

function renderSingleDiffRow(
	text: string,
	color: string,
	width: number,
	theme: DiffTheme,
): string[] {
	if (width <= 0) {
		return [""];
	}
	return [clampDiffLineToWidth(stabilizeBackgroundResets(theme.fg(color, text)), width)];
}

function safeGetDiff(details: unknown): string {
	if (!details || typeof details !== "object") {
		return "";
	}
	const typed = details as { diff?: unknown };
	return typeof typed.diff === "string" ? typed.diff : "";
}

function createDiffRenderCache() {
	let cachedWidth: number | undefined;
	let cachedExpanded: boolean | undefined;
	let cachedMode: DiffPresentationMode | undefined;
	let cachedConfigKey: string | undefined;
	let cachedHovered: boolean | undefined;
	let cachedLines: string[] | undefined;

	return {
		get(
			width: number,
			expanded: boolean,
			mode: DiffPresentationMode,
			configKey: string,
			hovered: boolean,
		): string[] | undefined {
			if (
				cachedLines &&
				cachedWidth === width &&
				cachedExpanded === expanded &&
				cachedMode === mode &&
				cachedConfigKey === configKey &&
				cachedHovered === hovered
			) {
				return cachedLines;
			}
			return undefined;
		},
		set(
			width: number,
			expanded: boolean,
			mode: DiffPresentationMode,
			configKey: string,
			hovered: boolean,
			lines: string[],
		): string[] {
			cachedWidth = width;
			cachedExpanded = expanded;
			cachedMode = mode;
			cachedConfigKey = configKey;
			cachedHovered = hovered;
			cachedLines = lines;
			return lines;
		},
		invalidate(): void {
			cachedWidth = undefined;
			cachedExpanded = undefined;
			cachedMode = undefined;
			cachedConfigKey = undefined;
			cachedHovered = undefined;
			cachedLines = undefined;
		},
	};
}

/**
 * edit 变更行统计（compact 单行 `(+A -D)` 用）：复用现有 parser，diff 文件头不计入。
 * 无 diff 或解析失败时返回 undefined，不把未知状态误报为零变更。
 */
export function countEditDiffStats(
	details: unknown,
): { added: number; removed: number } | undefined {
	const diffText = sanitizeToolResultText(safeGetDiff(details));
	if (!diffText.trim()) return undefined;
	try {
		const parsed = parseDiff(diffText);
		return { added: parsed.stats.added, removed: parsed.stats.removed };
	} catch {
		return undefined;
	}
}

/**
 * write 变更行统计（compact 单行用）：复用当前 write diff 算法。
 * 新文件 = 全部新内容为 added；覆盖已有文件用 LCS 精确统计。
 * content 非字符串、元数据缺失或超过矩阵预算时返回 undefined（不显示计数）。
 */
export function countWriteDiffStats(
	content: string | undefined,
	previousContent: string | undefined,
	fileExistedBeforeWrite: boolean | undefined,
): { added: number; removed: number } | undefined {
	if (typeof content !== "string" || fileExistedBeforeWrite === undefined) return undefined;
	const lines = splitWriteContentLines(sanitizeToolResultText(content));
	if (fileExistedBeforeWrite === false) return { added: lines.length, removed: 0 };
	if (typeof previousContent !== "string") return undefined;
	const previousLines = splitWriteContentLines(sanitizeToolResultText(previousContent));
	if (previousLines.length === 0 || lines.length === 0) {
		return { added: lines.length, removed: previousLines.length };
	}
	if (previousLines.length * lines.length > MAX_COLLAPSED_WRITE_OVERWRITE_DIFF_MATRIX_CELLS) {
		return undefined;
	}
	let added = 0;
	let removed = 0;
	for (const operation of buildWriteDiffOperations(previousLines, lines)) {
		if (operation.kind === "add") added++;
		else if (operation.kind === "remove") removed++;
	}
	return { added, removed };
}

export function renderEditDiffResult(
	details: unknown,
	options: DiffRenderOptions,
	config: DisplayConfigInput,
	theme: DiffTheme,
	fallbackText: string,
): Component {
	const diffText = sanitizeToolResultText(safeGetDiff(details));
	const safeFallbackText = sanitizeToolResultText(fallbackText);
	if (!diffText.trim()) {
		if (!safeFallbackText.trim()) {
			return new Text(theme.fg("muted", "↳ edit completed (no diff payload)"), 0, 0);
		}
		return new Text(theme.fg("toolOutput", safeFallbackText), 0, 0);
	}

	let parsed: ParsedDiff;
	try {
		parsed = parseDiff(diffText);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return new Text(theme.fg("warning", `↳ unable to render diff: ${message}`), 0, 0);
	}

	if (parsed.entries.length === 0) {
		return new Text(theme.fg("muted", "↳ no diff data"), 0, 0);
	}

	const splitRows = buildSplitRows(parsed.entries);
	const showHashlineAnchors =
		options.expanded === true &&
		parsed.entries.some((entry) => entry.kind === "line" && !!entry.hashlineAnchorContent);
	const lineNumberWidth = getLineNumberWidth(parsed.entries, showHashlineAnchors);
	const palette = resolveDiffPalette(theme);
	// Rich diffs use ccstyle's self shell. Keep the panel transparent so the
	// separator cannot leak toolSuccessBg across the entire new column.
	const containerBgAnsi = undefined;
	const language = resolveLanguageFromPath(options.filePath);
	const cache = createDiffRenderCache();
	const highlightLine = createCodeLineHighlighter(language, theme, parsed.entries, () => {
		cache.invalidate();
		options.invalidate?.();
	});

	return {
		[RICH_DIFF_COMPONENT]: true,
		render(width: number): string[] {
			// Live config: panel can change indicator/wrap/limits after this component is created.
			const live = resolveLiveDisplayConfig(config);
			const wordWrap = live.diffWordWrap;
			const indicatorMode = resolveDiffIndicatorMode(live);
			const configKey = displayConfigCacheKey(live);
			const safeWidth = normalizeDiffRenderWidth(width);
			const mode = resolveDiffPresentationMode(live, safeWidth, canRenderSplitLayout(safeWidth));
			const hovered = options.isHovered?.() ?? false;
			const cached = cache.get(safeWidth, options.expanded, mode, configKey, hovered);
			if (cached) {
				return cached;
			}

			if (mode === "summary") {
				return cache.set(
					safeWidth,
					options.expanded,
					mode,
					configKey,
					hovered,
					clampDiffLinesToWidth(
						renderSingleDiffRow(
							buildDiffSummaryText(parsed.stats, safeWidth),
							"toolOutput",
							safeWidth,
							theme,
						),
						safeWidth,
					),
				);
			}

			const headerRows = renderHeaderRows(parsed.stats, mode, safeWidth, theme);
			const displayLimit = resolveDiffDisplayLimit(
				options.expanded,
				live.editDiffCollapsedLines,
				live.expandedPreviewMaxLines,
			);
			const processBudget = resolveDiffProcessBudget(displayLimit, wordWrap);
			// Only highlight/render a prefix that can fill the display limit; full-diff
			// LCS + syntax highlight on thousands of hidden lines is pure waste when collapsed.
			const entryBudget = takeEntriesForLineBudget(parsed.entries, processBudget);
			const splitBudget = takeSplitRowsForBudget(splitRows, processBudget);
			const inlineHighlights = buildInlineHighlightMap(splitBudget.rows);
			const renderCtx: DiffRenderContext = {
				width: safeWidth,
				theme,
				inlineHighlights,
				palette,
				highlightLine,
				containerBgAnsi,
				wordWrap,
				indicatorMode,
				showHashlineAnchors,
			};
			const bodyRows =
				mode === "split"
					? renderSplit(splitBudget.rows, renderCtx, lineNumberWidth)
					: mode === "compact"
						? renderCompact(entryBudget.entries, renderCtx)
						: renderUnified(entryBudget.entries, renderCtx, lineNumberWidth);
			const unprocessedLogicalRows =
				mode === "split"
					? Math.max(0, splitBudget.totalRows - splitBudget.processedRows)
					: Math.max(0, entryBudget.totalLineEntries - entryBudget.processedLineEntries);
			const bodyWithLimit = applyLineLimit(
				bodyRows,
				safeWidth,
				options.expanded,
				live.editDiffCollapsedLines,
				live.expandedPreviewMaxLines,
				parsed.stats.hunks,
				theme,
				unprocessedLogicalRows,
				hovered,
			);
			const frame = renderDiffFrameLine(safeWidth, theme);
			const renderedLines =
				mode === "unified"
					? [...headerRows.map((row) => row.text), frame, ...bodyWithLimit, frame]
					: [...headerRows.map((row) => row.text), ...bodyWithLimit];

			const clampedLines = clampDiffLinesToWidth(renderedLines, safeWidth);
			return cache.set(safeWidth, options.expanded, mode, configKey, hovered, clampedLines);
		},
		invalidate: cache.invalidate,
	} as Component;
}

function renderWriteHeader(
	wasOverwrite: boolean,
	width: number,
	theme: DiffTheme,
	headerLabel?: string,
): string {
	const actionLabel = headerLabel?.trim() || (wasOverwrite ? "overwritten" : "created");
	return stabilizeBackgroundResets(
		truncateToWidth(theme.fg("toolOutput", `↳ ${emphasis(theme, actionLabel)}`), width),
	);
}

type WriteDiffOperationKind = "context" | "remove" | "add";

interface WriteDiffOperation {
	kind: WriteDiffOperationKind;
	content: string;
}

function buildWriteDiffOperations(oldLines: string[], newLines: string[]): WriteDiffOperation[] {
	const oldLength = oldLines.length;
	const newLength = newLines.length;
	const table: number[][] = Array.from({ length: oldLength + 1 }, () =>
		Array<number>(newLength + 1).fill(0),
	);

	for (let oldIndex = 1; oldIndex <= oldLength; oldIndex++) {
		for (let newIndex = 1; newIndex <= newLength; newIndex++) {
			if ((oldLines[oldIndex - 1] ?? "") === (newLines[newIndex - 1] ?? "")) {
				table[oldIndex]![newIndex] = (table[oldIndex - 1]?.[newIndex - 1] ?? 0) + 1;
				continue;
			}
			const top = table[oldIndex - 1]?.[newIndex] ?? 0;
			const left = table[oldIndex]?.[newIndex - 1] ?? 0;
			table[oldIndex]![newIndex] = Math.max(top, left);
		}
	}

	const operations: WriteDiffOperation[] = [];
	let oldCursor = oldLength;
	let newCursor = newLength;

	while (oldCursor > 0 || newCursor > 0) {
		const oldLine = oldCursor > 0 ? (oldLines[oldCursor - 1] ?? "") : undefined;
		const newLine = newCursor > 0 ? (newLines[newCursor - 1] ?? "") : undefined;

		if (oldCursor > 0 && newCursor > 0 && oldLine === newLine) {
			operations.push({ kind: "context", content: oldLine ?? "" });
			oldCursor--;
			newCursor--;
			continue;
		}

		const top = oldCursor > 0 ? (table[oldCursor - 1]?.[newCursor] ?? 0) : -1;
		const left = newCursor > 0 ? (table[oldCursor]?.[newCursor - 1] ?? 0) : -1;

		if (newCursor > 0 && left >= top) {
			operations.push({ kind: "add", content: newLine ?? "" });
			newCursor--;
			continue;
		}

		if (oldCursor > 0) {
			operations.push({ kind: "remove", content: oldLine ?? "" });
			oldCursor--;
		}
	}

	operations.reverse();
	return operations;
}

function buildWriteEntries(lines: string[]): ParsedDiffEntry[] {
	return lines.map((line, index) => ({
		kind: "line",
		lineKind: "add",
		oldLineNumber: null,
		newLineNumber: index + 1,
		fallbackLineNumber: `${index + 1}`,
		content: line,
		raw: `+${line}`,
		hunkIndex: 1,
	}));
}

function buildWriteOverwriteEntries(oldLines: string[], newLines: string[]): ParsedDiffEntry[] {
	const operations = buildWriteDiffOperations(oldLines, newLines);
	const entries: ParsedDiffEntry[] = [];
	let oldLineNumber = 1;
	let newLineNumber = 1;

	for (const operation of operations) {
		if (operation.kind === "context") {
			entries.push({
				kind: "line",
				lineKind: "context",
				oldLineNumber,
				newLineNumber,
				fallbackLineNumber: `${newLineNumber}`,
				content: operation.content,
				raw: ` ${operation.content}`,
				hunkIndex: 1,
			});
			oldLineNumber++;
			newLineNumber++;
			continue;
		}

		if (operation.kind === "remove") {
			entries.push({
				kind: "line",
				lineKind: "remove",
				oldLineNumber,
				newLineNumber: null,
				fallbackLineNumber: `${oldLineNumber}`,
				content: operation.content,
				raw: `-${operation.content}`,
				hunkIndex: 1,
			});
			oldLineNumber++;
			continue;
		}

		entries.push({
			kind: "line",
			lineKind: "add",
			oldLineNumber: null,
			newLineNumber,
			fallbackLineNumber: `${newLineNumber}`,
			content: operation.content,
			raw: `+${operation.content}`,
			hunkIndex: 1,
		});
		newLineNumber++;
	}

	return entries;
}

interface WriteDiffData {
	entries: ParsedDiffEntry[];
	splitRows: SplitDiffRow[];
	inlineHighlights: WeakMap<DiffLineEntry, DiffSpan[]>;
	lineNumberWidth: number;
	stats: DiffStats;
	hunkCount: number;
}

interface WriteOverwriteGuard {
	previousLineCount: number;
	nextLineCount: number;
}

const MAX_WRITE_OVERWRITE_DIFF_LINES = 4000;
const MAX_WRITE_OVERWRITE_DIFF_MATRIX_CELLS = 1_000_000;
/** Collapsed overwrite previews refuse larger LCS matrices to avoid TUI freezes. */
const MAX_COLLAPSED_WRITE_OVERWRITE_DIFF_MATRIX_CELLS = 200_000;

function buildApproximateWriteStats(
	lineCount: number,
	previousLineCount: number,
	hasComparablePrevious: boolean,
): DiffStats {
	const removed = hasComparablePrevious ? previousLineCount : 0;
	const added = lineCount;
	const hasContent = lineCount > 0 || removed > 0;
	return {
		added,
		removed,
		context: 0,
		hunks: hasContent ? 1 : 0,
		files: 1,
		lines: added + removed,
	};
}

function buildWriteDiffData(entries: ParsedDiffEntry[]): WriteDiffData {
	const splitRows = buildSplitRows(entries);
	const inlineHighlights = buildInlineHighlightMap(splitRows);
	const lineNumberWidth = getLineNumberWidth(entries);
	const hunkCount = entries.length > 0 ? 1 : 0;
	const stats = collectDiffStats(entries, hunkCount, 1);
	return {
		entries,
		splitRows,
		inlineHighlights,
		lineNumberWidth,
		stats,
		hunkCount,
	};
}

function resolveWriteOverwriteGuard(
	previousLines: string[],
	nextLines: string[],
	expanded = true,
): WriteOverwriteGuard | undefined {
	const previousLineCount = previousLines.length;
	const nextLineCount = nextLines.length;
	if (
		previousLineCount > MAX_WRITE_OVERWRITE_DIFF_LINES ||
		nextLineCount > MAX_WRITE_OVERWRITE_DIFF_LINES
	) {
		return { previousLineCount, nextLineCount };
	}
	if (previousLineCount === 0 || nextLineCount === 0) {
		return undefined;
	}
	const cellLimit = expanded
		? MAX_WRITE_OVERWRITE_DIFF_MATRIX_CELLS
		: MAX_COLLAPSED_WRITE_OVERWRITE_DIFF_MATRIX_CELLS;
	return previousLineCount * nextLineCount > cellLimit
		? { previousLineCount, nextLineCount }
		: undefined;
}

function buildWriteOverwriteGuardText(guard: WriteOverwriteGuard, width: number): string {
	const safeWidth = normalizeDiffRenderWidth(width);
	if (safeWidth === 0) {
		return "";
	}

	const candidates = [
		`↳ overwrite diff omitted (${guard.previousLineCount} → ${guard.nextLineCount} lines)`,
		`↳ overwrite diff omitted (${guard.previousLineCount}→${guard.nextLineCount})`,
		"↳ overwrite diff omitted",
		"diff omitted",
		"…",
	];
	for (const candidate of candidates) {
		if (visibleWidth(candidate) <= safeWidth) {
			return candidate;
		}
	}
	return truncateToWidth(candidates[candidates.length - 1] ?? "", safeWidth, "");
}

function renderWriteOverwriteGuardRows(
	guard: WriteOverwriteGuard,
	width: number,
	theme: DiffTheme,
): string[] {
	return renderSingleDiffRow(buildWriteOverwriteGuardText(guard, width), "warning", width, theme);
}

/** Folded write with a zero body limit: `↳ created • click to show more`. */
function renderWriteCollapsedHintLine(
	wasOverwrite: boolean,
	width: number,
	theme: DiffTheme,
	hovered: boolean,
	headerLabel?: string,
): string[] {
	const safeWidth = normalizeDiffRenderWidth(width);
	if (safeWidth === 0) {
		return [""];
	}
	const actionLabel = headerLabel?.trim() || (wasOverwrite ? "overwritten" : "created");
	const clickLabel = showMoreHintText();
	const candidates = [`↳ ${actionLabel} • ${clickLabel}`, `↳ ${actionLabel}`, actionLabel, "…"];
	let text = candidates[candidates.length - 1] ?? "…";
	for (const candidate of candidates) {
		if (visibleWidth(candidate) <= safeWidth) {
			text = candidate;
			break;
		}
	}
	if (visibleWidth(text) > safeWidth) {
		text = truncateToWidth(text, safeWidth, "");
	}
	const clickIndex = text.lastIndexOf(clickLabel);
	const styled =
		hovered && clickIndex >= 0
			? theme.fg("muted", text.slice(0, clickIndex)) +
				theme.fg("text", clickLabel) +
				theme.fg("muted", text.slice(clickIndex + clickLabel.length))
			: theme.fg("muted", text);
	return [clampDiffLineToWidth(styled, safeWidth)];
}

export function renderWriteDiffResult(
	content: string | undefined,
	options: DiffRenderOptions,
	config: DisplayConfigInput,
	theme: DiffTheme,
	fallbackText: string,
): Component {
	const safeFallbackText = sanitizeToolResultText(fallbackText);
	const persisted = options.persistedDiff;
	const persistedText = persisted
		? typeof persisted.diff === "string" && persisted.diff.trim()
			? persisted.diff
			: typeof persisted.patch === "string" && persisted.patch.trim()
				? persisted.patch
				: ""
		: "";
	if (persisted && !persistedText.trim()) {
		const reason = persisted.diffUnavailableReason?.trim() || "durable diff payload is unavailable";
		return new Text(theme.fg("warning", `↳ diff unavailable: ${reason}`), 0, 0);
	}
	let persistedParsed: ParsedDiff | undefined;
	if (persistedText.trim()) {
		try {
			persistedParsed = parseDiff(sanitizeToolResultText(persistedText));
		} catch {
			return new Text(theme.fg("warning", "↳ diff unavailable: invalid durable diff payload"), 0, 0);
		}
		if (!persistedParsed.entries.some((entry) => entry.kind === "line")) {
			return new Text(theme.fg("warning", "↳ diff unavailable: durable diff has no displayable lines"), 0, 0);
		}
	}
	if (typeof content !== "string" && !persistedParsed) {
		if (!safeFallbackText.trim()) {
			return new Text(theme.fg("muted", "↳ write completed"), 0, 0);
		}
		return new Text(theme.fg("toolOutput", safeFallbackText), 0, 0);
	}

	const filePath = options.filePath?.trim() || "(unknown path)";
	const lines = typeof content === "string"
		? splitWriteContentLines(sanitizeToolResultText(content))
		: (persistedParsed?.entries.filter((entry): entry is DiffLineEntry => entry.kind === "line").map((entry) => entry.content) ?? []);
	const previousLines =
		typeof options.previousContent === "string"
			? splitWriteContentLines(sanitizeToolResultText(options.previousContent))
			: [];
	const hasComparablePrevious =
		options.fileExistedBeforeWrite === true && typeof options.previousContent === "string";
	const approximateStats = persistedParsed?.stats ?? buildApproximateWriteStats(
		lines.length,
		previousLines.length,
		hasComparablePrevious,
	);
	const palette = resolveDiffPalette(theme);
	// Keep the panel transparent; changed rows and inline spans retain their own highlights.
	const containerBgAnsi = undefined;
	const language = resolveLanguageFromPath(filePath);
	const cache = createDiffRenderCache();
	let highlightLine: CodeLineHighlighter | undefined;
	let detailedData: WriteDiffData | undefined;

	function getDetailedData(): WriteDiffData {
		if (detailedData) {
			return detailedData;
		}
		const entries = persistedParsed?.entries ?? (hasComparablePrevious
			? buildWriteOverwriteEntries(previousLines, lines)
			: buildWriteEntries(lines));
		detailedData = buildWriteDiffData(entries);
		highlightLine = createCodeLineHighlighter(language, theme, entries, () => {
			cache.invalidate();
			options.invalidate?.();
		});
		return detailedData;
	}

	return {
		[RICH_DIFF_COMPONENT]: true,
		render(width: number): string[] {
			// Live config: panel can change indicator/wrap/limits after this component is created.
			const live = resolveLiveDisplayConfig(config);
			const wordWrap = live.diffWordWrap;
			const indicatorMode = resolveDiffIndicatorMode(live);
			const configKey = displayConfigCacheKey(live);
			const safeWidth = normalizeDiffRenderWidth(width);
			const resolvedMode = resolveDiffPresentationMode(
				live,
				safeWidth,
				canRenderSplitLayout(safeWidth),
			);
			const mode: DiffPresentationMode = hasComparablePrevious
				? resolvedMode
				: resolvedMode === "split"
					? "unified"
					: resolvedMode;
			const hovered = options.isHovered?.() ?? false;
			const cached = cache.get(safeWidth, options.expanded, mode, configKey, hovered);
			if (cached) {
				return cached;
			}

			const writeCollapsedLimit = resolveWriteCollapsedLimit(live);
			if (!options.expanded && writeCollapsedLimit === 0) {
				return cache.set(
					safeWidth,
					options.expanded,
					mode,
					configKey,
					hovered,
					clampDiffLinesToWidth(
						renderWriteCollapsedHintLine(
							options.fileExistedBeforeWrite === true,
							safeWidth,
							theme,
							hovered,
							options.headerLabel,
						),
						safeWidth,
					),
				);
			}

			const header = renderWriteHeader(
				options.fileExistedBeforeWrite === true,
				safeWidth,
				theme,
				options.headerLabel,
			);
			// Guard depends on expanded: collapsed previews use a stricter LCS cell budget.
			const overwriteGuard = hasComparablePrevious
				? resolveWriteOverwriteGuard(previousLines, lines, options.expanded)
				: undefined;
			if (overwriteGuard) {
				return cache.set(
					safeWidth,
					options.expanded,
					mode,
					configKey,
					hovered,
					clampDiffLinesToWidth(
						[header, ...renderWriteOverwriteGuardRows(overwriteGuard, safeWidth, theme)],
						safeWidth,
					),
				);
			}

			if (mode === "summary") {
				const summaryRows =
					approximateStats.lines === 0
						? [header]
						: [
								header,
								...renderSingleDiffRow(
									buildDiffSummaryText(approximateStats, safeWidth),
									"toolOutput",
									safeWidth,
									theme,
								),
							];
				return cache.set(
					safeWidth,
					options.expanded,
					mode,
					configKey,
					hovered,
					clampDiffLinesToWidth(summaryRows, safeWidth),
				);
			}

			const data = getDetailedData();
			const displayLimit = resolveDiffDisplayLimit(
				options.expanded,
				writeCollapsedLimit,
				live.expandedPreviewMaxLines,
			);
			const processBudget = resolveDiffProcessBudget(displayLimit, wordWrap);
			const entryBudget = takeEntriesForLineBudget(data.entries, processBudget);
			const splitBudget = takeSplitRowsForBudget(data.splitRows, processBudget);
			const inlineHighlights =
				splitBudget.processedRows < splitBudget.totalRows
					? buildInlineHighlightMap(splitBudget.rows)
					: data.inlineHighlights;
			const renderCtx: DiffRenderContext = {
				width: safeWidth,
				theme,
				inlineHighlights,
				palette,
				highlightLine: highlightLine!,
				containerBgAnsi,
				wordWrap,
				indicatorMode,
				showHashlineAnchors: false,
			};
			const bodyRows: RenderedRow[] =
				entryBudget.entries.length === 0
					? [{ text: theme.fg("muted", "(empty file)"), hunkIndex: null }]
					: mode === "split"
						? renderSplit(splitBudget.rows, renderCtx, data.lineNumberWidth)
						: mode === "compact"
							? renderCompact(entryBudget.entries, renderCtx)
							: renderUnified(entryBudget.entries, renderCtx, data.lineNumberWidth);
			const unprocessedLogicalRows =
				mode === "split"
					? Math.max(0, splitBudget.totalRows - splitBudget.processedRows)
					: Math.max(0, entryBudget.totalLineEntries - entryBudget.processedLineEntries);

			const bodyWithLimit = applyLineLimit(
				bodyRows,
				safeWidth,
				options.expanded,
				writeCollapsedLimit,
				live.expandedPreviewMaxLines,
				data.hunkCount,
				theme,
				unprocessedLogicalRows,
				hovered,
			);
			const frame = renderDiffFrameLine(safeWidth, theme);
			const renderedLines =
				mode === "unified" ? [header, frame, ...bodyWithLimit, frame] : [header, ...bodyWithLimit];
			const finalLines = clampDiffLinesToWidth(renderedLines, safeWidth);
			return cache.set(safeWidth, options.expanded, mode, configKey, hovered, finalLines);
		},
		invalidate: cache.invalidate,
	} as Component;
}
