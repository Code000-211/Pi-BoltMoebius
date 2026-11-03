/**
 * Shared diff computation utilities for the edit and similar tools.
 */

import { constants } from "fs";
import { access, readFile } from "fs/promises";
import { splitBom } from "../../utils/text.ts";
import { resolveToCwd } from "./path-utils.ts";

export function detectLineEnding(content: string): "\r\n" | "\n" {
	const crlfIdx = content.indexOf("\r\n");
	const lfIdx = content.indexOf("\n");
	if (lfIdx === -1) return "\n";
	if (crlfIdx === -1) return "\n";
	return crlfIdx < lfIdx ? "\r\n" : "\n";
}

export function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
	return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

const ASCII_ONLY = /^[\x00-\x7f]*$/;
// The ASCII characters trimEnd strips, other than "\n", at the end of a line.
const ASCII_TRAILING_WHITESPACE = /[\t\v\f\r ](?:\n|$)/;

/** Strip trailing whitespace from each line. */
function trimLineEnds(text: string): string {
	return text
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n");
}

/**
 * Normalize text for fuzzy matching. Applies progressive transformations:
 * - Strip trailing whitespace from each line
 * - Normalize smart quotes to ASCII equivalents
 * - Normalize Unicode dashes/hyphens to ASCII hyphen
 * - Normalize special Unicode spaces to regular space
 */
export function normalizeForFuzzyMatch(text: string): string {
	if (ASCII_ONLY.test(text)) {
		// NFKC leaves ASCII unchanged and the replacements below only match non-ASCII characters, so
		// only trailing whitespace can change. Scanning the large Unicode classes dominated this call.
		return ASCII_TRAILING_WHITESPACE.test(text) ? trimLineEnds(text) : text;
	}
	return (
		trimLineEnds(text.normalize("NFKC"))
			// Smart single quotes → '
			.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
			// Smart double quotes → "
			.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
			// Various dashes/hyphens → -
			// U+2010 hyphen, U+2011 non-breaking hyphen, U+2012 figure dash,
			// U+2013 en-dash, U+2014 em-dash, U+2015 horizontal bar, U+2212 minus
			.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
			// Special spaces → regular space
			// U+00A0 NBSP, U+2002-U+200A various spaces, U+202F narrow NBSP,
			// U+205F medium math space, U+3000 ideographic space
			.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ")
	);
}

let lastFuzzyInput: string | undefined;
let lastFuzzyOutput = "";

/**
 * normalizeForFuzzyMatch for whole file contents, remembering the last result. The edit preview and the
 * edit itself normalize the same file content one after the other.
 */
function normalizeContentForFuzzyMatch(content: string): string {
	if (content !== lastFuzzyInput) {
		lastFuzzyOutput = normalizeForFuzzyMatch(content);
		lastFuzzyInput = content;
	}
	return lastFuzzyOutput;
}

function splitLinesWithEndings(content: string): string[] {
	return content.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

interface LineSpan {
	start: number;
	end: number;
}

interface MatchedEdit {
	editIndex: number;
	matchIndex: number;
	matchLength: number;
	newText: string;
}

type TextReplacement = Pick<MatchedEdit, "matchIndex" | "matchLength" | "newText">;

function getLineSpans(content: string): LineSpan[] {
	let offset = 0;
	return splitLinesWithEndings(content).map((line) => {
		const span = { start: offset, end: offset + line.length };
		offset = span.end;
		return span;
	});
}

function getReplacementLineRange(lines: LineSpan[], replacement: TextReplacement) {
	const replacementStart = replacement.matchIndex;
	const replacementEnd = replacement.matchIndex + replacement.matchLength;

	let startLine = -1;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (replacementStart >= line.start && replacementStart < line.end) {
			startLine = i;
			break;
		}
	}
	if (startLine === -1) {
		throw new Error("Replacement range is outside the base content.");
	}

	let endLine = startLine;
	while (endLine < lines.length && lines[endLine].end < replacementEnd) {
		endLine++;
	}
	if (endLine >= lines.length) {
		throw new Error("Replacement range is outside the base content.");
	}

	return { startLine, endLine: endLine + 1 };
}

function applyReplacements(content: string, replacements: TextReplacement[], offset = 0): string {
	let result = content;
	for (let i = replacements.length - 1; i >= 0; i--) {
		const replacement = replacements[i];
		const matchIndex = replacement.matchIndex - offset;
		result =
			result.substring(0, matchIndex) + replacement.newText + result.substring(matchIndex + replacement.matchLength);
	}
	return result;
}

/**
 * Apply replacements matched against `baseContent` to `originalContent` while
 * preserving unchanged line blocks from the original.
 *
 * This is useful when `baseContent` is a normalized view of the original. Each
 * replacement is widened to the lines it actually touches, those touched lines
 * are rewritten from the normalized base, and all other lines are copied back
 * from `originalContent`. The actual replacement ranges drive preservation so
 * duplicate normalized lines cannot be aligned to the wrong occurrence.
 */
export function applyReplacementsPreservingUnchangedLines(
	originalContent: string,
	baseContent: string,
	replacements: TextReplacement[],
): string {
	const originalLines = splitLinesWithEndings(originalContent);
	const baseLines = getLineSpans(baseContent);
	if (originalLines.length !== baseLines.length) {
		throw new Error("Cannot preserve unchanged lines because the base content has a different line count.");
	}

	const groups: Array<{ startLine: number; endLine: number; replacements: TextReplacement[] }> = [];
	const sortedReplacements = [...replacements].sort((a, b) => a.matchIndex - b.matchIndex);
	for (const replacement of sortedReplacements) {
		const range = getReplacementLineRange(baseLines, replacement);
		const current = groups[groups.length - 1];
		if (current && range.startLine < current.endLine) {
			current.endLine = Math.max(current.endLine, range.endLine);
			current.replacements.push(replacement);
			continue;
		}
		groups.push({ ...range, replacements: [replacement] });
	}

	let originalLineIndex = 0;
	let result = "";
	for (const group of groups) {
		result += originalLines.slice(originalLineIndex, group.startLine).join("");

		const groupStartOffset = baseLines[group.startLine].start;
		const groupEndOffset = baseLines[group.endLine - 1].end;
		result += applyReplacements(
			baseContent.slice(groupStartOffset, groupEndOffset),
			group.replacements,
			groupStartOffset,
		);
		originalLineIndex = group.endLine;
	}
	result += originalLines.slice(originalLineIndex).join("");

	return result;
}

export interface FuzzyMatchResult {
	/** Whether a match was found */
	found: boolean;
	/** The index where the match starts (in the content that should be used for replacement) */
	index: number;
	/** Length of the matched text */
	matchLength: number;
	/** Whether fuzzy matching was used (false = exact match) */
	usedFuzzyMatch: boolean;
	/**
	 * The content to use for replacement operations.
	 * When exact match: original content. When fuzzy match: normalized content.
	 */
	contentForReplacement: string;
}

export interface Edit {
	oldText: string;
	newText: string;
}

export interface AppliedEditsResult {
	baseContent: string;
	newContent: string;
}

/**
 * Find oldText in content, trying exact match first, then fuzzy match.
 * When fuzzy matching is used, the returned contentForReplacement is the
 * fuzzy-normalized version of the content (trailing whitespace stripped,
 * Unicode quotes/dashes normalized to ASCII).
 */
export function fuzzyFindText(content: string, oldText: string): FuzzyMatchResult {
	return findText(content, oldText, () => normalizeForFuzzyMatch(content));
}

/** fuzzyFindText with `normalizeForFuzzyMatch(content)` supplied by the caller, so it can be shared. */
function findText(content: string, oldText: string, getFuzzyContent: () => string): FuzzyMatchResult {
	// Try exact match first
	const exactIndex = content.indexOf(oldText);
	if (exactIndex !== -1) {
		return {
			found: true,
			index: exactIndex,
			matchLength: oldText.length,
			usedFuzzyMatch: false,
			contentForReplacement: content,
		};
	}

	// Try fuzzy match - work entirely in normalized space
	const fuzzyContent = getFuzzyContent();
	const fuzzyOldText = normalizeForFuzzyMatch(oldText);
	const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText);

	if (fuzzyIndex === -1) {
		return {
			found: false,
			index: -1,
			matchLength: 0,
			usedFuzzyMatch: false,
			contentForReplacement: content,
		};
	}

	// When fuzzy matching, return offsets in normalized space. Callers can use
	// the normalized content to compute replacements, then decide how much of
	// that normalized output should be written back.
	return {
		found: true,
		index: fuzzyIndex,
		matchLength: fuzzyOldText.length,
		usedFuzzyMatch: true,
		contentForReplacement: fuzzyContent,
	};
}

/** Occurrences of `oldText` in `fuzzyContent`, which is already fuzzy-normalized. */
function countOccurrences(fuzzyContent: string, oldText: string): number {
	const fuzzyOldText = normalizeForFuzzyMatch(oldText);
	return fuzzyContent.split(fuzzyOldText).length - 1;
}

interface TrimmedSequenceMatch {
	matchIndex: number;
	matchLength: number;
	occurrences: number;
	adjustedNewText: string;
}

function getLeadingWhitespace(line: string): string {
	let i = 0;
	while (i < line.length && (line[i] === " " || line[i] === "\t")) {
		i++;
	}
	return line.slice(0, i);
}

/**
 * Adjust the leading indentation of `newText` lines when `oldText` matched via
 * Codex-style trimmed line matching (e.g., model sent 2-space indent instead of tab indent).
 */
function reindentNewTextForMatchedLines(matchedOriginalSlice: string, oldText: string, newText: string): string {
	const hasTrailingNewline = newText.endsWith("\n");
	const origLines = matchedOriginalSlice.endsWith("\n")
		? matchedOriginalSlice.slice(0, -1).split("\n")
		: matchedOriginalSlice.split("\n");
	const oldLines = oldText.endsWith("\n") ? oldText.slice(0, -1).split("\n") : oldText.split("\n");
	const newLines = hasTrailingNewline ? newText.slice(0, -1).split("\n") : newText.split("\n");

	let origAnchorIndent: string | undefined;
	let oldAnchorIndent: string | undefined;
	const pairCount = Math.min(origLines.length, oldLines.length);
	for (let i = 0; i < pairCount; i++) {
		if (origLines[i].trim().length > 0 && oldLines[i].trim().length > 0) {
			origAnchorIndent = getLeadingWhitespace(origLines[i]);
			oldAnchorIndent = getLeadingWhitespace(oldLines[i]);
			break;
		}
	}

	if (origAnchorIndent === undefined || oldAnchorIndent === undefined || origAnchorIndent === oldAnchorIndent) {
		return newText;
	}

	const adjustedLines = newLines.map((line) => {
		if (line.trim().length === 0) return line;
		if (oldAnchorIndent.length === 0) {
			return origAnchorIndent + line;
		}
		if (line.startsWith(oldAnchorIndent)) {
			return origAnchorIndent + line.slice(oldAnchorIndent.length);
		}
		return line;
	});

	const joined = adjustedLines.join("\n");
	return hasTrailingNewline ? `${joined}\n` : joined;
}

/**
 * Codex `seek_sequence` fallback pass (`codex-rs/apply-patch/src/seek_sequence.rs`):
 * When exact and trailing-whitespace matches fail, match line-by-line ignoring
 * leading/trailing whitespace and Unicode punctuation differences.
 */
function findTrimmedLineSequence(content: string, oldText: string, newText: string): TrimmedSequenceMatch | undefined {
	const rawLines = splitLinesWithEndings(content);
	if (rawLines.length === 0) return undefined;

	const lineOffsets: number[] = new Array(rawLines.length);
	const trimmedFileLines: string[] = new Array(rawLines.length);
	let offset = 0;
	for (let i = 0; i < rawLines.length; i++) {
		lineOffsets[i] = offset;
		const lineWithoutEnding = rawLines[i].endsWith("\n") ? rawLines[i].slice(0, -1) : rawLines[i];
		trimmedFileLines[i] = normalizeForFuzzyMatch(lineWithoutEnding).trim();
		offset += rawLines[i].length;
	}

	const patternEndsWithNewline = oldText.endsWith("\n");
	const rawPatternLines = (patternEndsWithNewline ? oldText.slice(0, -1) : oldText).split("\n");
	if (rawPatternLines.length === 0 || rawPatternLines.length > rawLines.length) {
		return undefined;
	}

	const trimmedPatternLines = rawPatternLines.map((line) => normalizeForFuzzyMatch(line).trim());
	// Avoid matching purely blank patterns via trimmed sequence
	if (trimmedPatternLines.every((line) => line.length === 0)) {
		return undefined;
	}

	const maxStart = rawLines.length - trimmedPatternLines.length;
	let firstMatchStartLine = -1;
	let occurrences = 0;

	for (let i = 0; i <= maxStart; i++) {
		let ok = true;
		for (let p = 0; p < trimmedPatternLines.length; p++) {
			if (trimmedFileLines[i + p] !== trimmedPatternLines[p]) {
				ok = false;
				break;
			}
		}
		if (ok) {
			if (firstMatchStartLine === -1) {
				firstMatchStartLine = i;
			}
			occurrences++;
		}
	}

	if (occurrences === 0) return undefined;

	const endLineIdx = firstMatchStartLine + trimmedPatternLines.length - 1;
	const matchIndex = lineOffsets[firstMatchStartLine];
	const lastLine = rawLines[endLineIdx];
	const lastLineLength = !patternEndsWithNewline && lastLine.endsWith("\n") ? lastLine.length - 1 : lastLine.length;
	const matchEnd = lineOffsets[endLineIdx] + lastLineLength;
	const matchLength = matchEnd - matchIndex;
	const matchedOriginalSlice = content.slice(matchIndex, matchEnd);

	return {
		matchIndex,
		matchLength,
		occurrences,
		adjustedNewText: reindentNewTextForMatchedLines(matchedOriginalSlice, oldText, newText),
	};
}

/** An oldText that matched nowhere in the file, neither exactly, fuzzily nor line by line. */
export class EditNotFoundError extends Error {
	readonly editIndex: number;
	constructor(message: string, editIndex: number) {
		super(message);
		this.name = "EditNotFoundError";
		this.editIndex = editIndex;
	}
}

function getNotFoundError(path: string, editIndex: number, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new EditNotFoundError(
			`Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`,
			editIndex,
		);
	}
	return new EditNotFoundError(
		`Could not find edits[${editIndex}] in ${path}. The oldText must match exactly including all whitespace and newlines.`,
		editIndex,
	);
}

/** The character pairs of a line, counted, keyed by their two UTF-16 code units. */
function linePairs(line: string): Map<number, number> {
	const pairs = new Map<number, number>();
	for (let i = 0; i < line.length - 1; i++) {
		const pair = (line.charCodeAt(i) << 16) | line.charCodeAt(i + 1);
		pairs.set(pair, (pairs.get(pair) ?? 0) + 1);
	}
	return pairs;
}

/** Dice coefficient of the character pairs of two lines (`pairsOfB` from `linePairs(b)`): 1 for equal lines. */
function lineSimilarity(a: string, b: string, pairsOfB: Map<number, number> = linePairs(b)): number {
	if (a === b) return 1;
	if (a.length < 2 || b.length < 2) return 0;
	// At most the shorter line's pairs are shared.
	if ((2 * (Math.min(a.length, b.length) - 1)) / (a.length + b.length - 2) < CLOSEST_MIN_SIMILARITY) return 0;
	const used = new Map<number, number>();
	let shared = 0;
	for (let i = 0; i < a.length - 1; i++) {
		const pair = (a.charCodeAt(i) << 16) | a.charCodeAt(i + 1);
		const count = used.get(pair) ?? 0;
		if (count < (pairsOfB.get(pair) ?? 0)) {
			shared++;
			used.set(pair, count + 1);
		}
	}
	return (2 * shared) / (a.length + b.length - 2);
}

const CLOSEST_MAX_LINES = 20;
const CLOSEST_MAX_LINE_CHARS = 200;
const CLOSEST_MIN_SIMILARITY = 0.5;

/**
 * Where the file has text most like `oldText`, shown with line numbers, so the agent can correct the edit without
 * reading the file again; undefined when nothing is similar enough. Candidate places are the lines equal to one of
 * oldText's lines (ignoring surrounding whitespace), else the lines most like its first non-blank line.
 */
export function describeClosestText(content: string, oldText: string): string | undefined {
	const fileLines = content.split("\n");
	const trimmedFile = fileLines.map((line) => normalizeForFuzzyMatch(line).trim());
	const patternLines = normalizeToLF(oldText).replace(/\n$/, "").split("\n");
	const pattern = patternLines.map((line) => normalizeForFuzzyMatch(line).trim());
	const n = Math.min(pattern.length, fileLines.length);
	if (n === 0 || pattern.every((line) => line.length === 0)) return undefined;

	const starts = new Set<number>();
	const lineIndex = new Map<string, number[]>();
	for (let i = 0; i < trimmedFile.length; i++) {
		if (!trimmedFile[i]) continue;
		const list = lineIndex.get(trimmedFile[i]);
		if (list) list.push(i);
		else lineIndex.set(trimmedFile[i], [i]);
	}
	for (let j = 0; j < n; j++) {
		// Lines such as "}" occur everywhere and say nothing about the place.
		if (pattern[j].length < 4) continue;
		for (const i of lineIndex.get(pattern[j]) ?? []) {
			if (starts.size >= 200) break;
			starts.add(Math.max(0, Math.min(i - j, fileLines.length - n)));
		}
	}
	if (starts.size === 0) {
		const first = pattern.findIndex((line) => line.length > 0);
		const firstPairs = linePairs(pattern[first]);
		const best: Array<{ start: number; score: number }> = [];
		for (let i = 0; i < trimmedFile.length; i++) {
			const score = lineSimilarity(trimmedFile[i], pattern[first], firstPairs);
			if (score < CLOSEST_MIN_SIMILARITY) continue;
			best.push({ start: Math.max(0, Math.min(i - first, fileLines.length - n)), score });
		}
		best.sort((a, b) => b.score - a.score);
		for (const { start } of best.slice(0, 5)) starts.add(start);
	}

	let bestStart = -1;
	let bestScore = 0;
	for (const start of [...starts].sort((a, b) => a - b)) {
		let score = 0;
		for (let j = 0; j < n; j++) score += lineSimilarity(trimmedFile[start + j], pattern[j]);
		score /= n;
		if (score > bestScore) {
			bestScore = score;
			bestStart = start;
		}
	}
	if (bestStart === -1 || bestScore < CLOSEST_MIN_SIMILARITY) return undefined;

	const firstDifference = pattern.findIndex((line, j) => j < n && line !== trimmedFile[bestStart + j]);
	const shown = Math.min(n, CLOSEST_MAX_LINES);
	const width = String(bestStart + shown).length;
	const lines = fileLines.slice(bestStart, bestStart + shown).map((line, j) => {
		const text = line.length > CLOSEST_MAX_LINE_CHARS ? `${line.slice(0, CLOSEST_MAX_LINE_CHARS)}...` : line;
		return `${String(bestStart + j + 1).padStart(width)}→${text}`;
	});
	const range = n === 1 ? `line ${bestStart + 1}` : `lines ${bestStart + 1}-${bestStart + n}`;
	const difference =
		firstDifference === -1 ? "" : ` It differs from oldText first at line ${bestStart + firstDifference + 1}.`;
	const more = shown < n ? `\n[${n - shown} more lines]` : "";
	return `The closest text in the file is at ${range}.${difference}\n${lines.join("\n")}${more}`;
}

function getDuplicateError(path: string, editIndex: number, totalEdits: number, occurrences: number): Error {
	if (totalEdits === 1) {
		return new Error(
			`Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`,
		);
	}
	return new Error(
		`Found ${occurrences} occurrences of edits[${editIndex}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`,
	);
}

function getEmptyOldTextError(path: string, editIndex: number, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(`oldText must not be empty in ${path}.`);
	}
	return new Error(`edits[${editIndex}].oldText must not be empty in ${path}.`);
}

function getNoChangeError(path: string, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(
			`No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`,
		);
	}
	return new Error(`No changes made to ${path}. The replacements produced identical content.`);
}

/**
 * Apply one or more exact-text replacements to LF-normalized content.
 *
 * All edits are matched against the same original content. Replacements are
 * then applied in reverse order so offsets remain stable. If any edit needs
 * fuzzy matching, the operation runs in fuzzy-normalized content space and then
 * overlays those line-level changes onto the original content so unchanged line
 * blocks keep their original bytes.
 */
export function applyEditsToNormalizedContent(
	normalizedContent: string,
	edits: Edit[],
	path: string,
): AppliedEditsResult {
	const normalizedEdits = edits.map((edit) => ({
		oldText: normalizeToLF(edit.oldText),
		newText: normalizeToLF(edit.newText),
	}));

	for (let i = 0; i < normalizedEdits.length; i++) {
		if (normalizedEdits[i].oldText.length === 0) {
			throw getEmptyOldTextError(path, i, normalizedEdits.length);
		}
	}

	// Normalized once for all edits: normalizing a large file per edit took most of a multi-edit call.
	const fuzzyContent = normalizeContentForFuzzyMatch(normalizedContent);
	const getFuzzyContent = (): string => fuzzyContent;
	const initialMatches = normalizedEdits.map((edit) => findText(normalizedContent, edit.oldText, getFuzzyContent));
	const usedFuzzyMatch = initialMatches.some((match) => match.usedFuzzyMatch);
	const replacementBaseContent = usedFuzzyMatch ? fuzzyContent : normalizedContent;
	let fuzzyOfFuzzyContent: string | undefined;
	const getReplacementBaseFuzzyContent = usedFuzzyMatch
		? (): string => {
				fuzzyOfFuzzyContent ??= normalizeForFuzzyMatch(fuzzyContent);
				return fuzzyOfFuzzyContent;
			}
		: getFuzzyContent;

	const matchedEdits: MatchedEdit[] = [];
	for (let i = 0; i < normalizedEdits.length; i++) {
		const edit = normalizedEdits[i];
		const matchResult = findText(replacementBaseContent, edit.oldText, getReplacementBaseFuzzyContent);
		if (!matchResult.found) {
			const trimmedMatch = findTrimmedLineSequence(replacementBaseContent, edit.oldText, edit.newText);
			if (!trimmedMatch) {
				throw getNotFoundError(path, i, normalizedEdits.length);
			}
			if (trimmedMatch.occurrences > 1) {
				throw getDuplicateError(path, i, normalizedEdits.length, trimmedMatch.occurrences);
			}
			matchedEdits.push({
				editIndex: i,
				matchIndex: trimmedMatch.matchIndex,
				matchLength: trimmedMatch.matchLength,
				newText: trimmedMatch.adjustedNewText,
			});
			continue;
		}

		// normalizeForFuzzyMatch is idempotent, so this is the normalized replacement base either way.
		const occurrences = countOccurrences(fuzzyContent, edit.oldText);
		if (occurrences > 1) {
			throw getDuplicateError(path, i, normalizedEdits.length, occurrences);
		}

		matchedEdits.push({
			editIndex: i,
			matchIndex: matchResult.index,
			matchLength: matchResult.matchLength,
			newText: edit.newText,
		});
	}

	matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex);
	for (let i = 1; i < matchedEdits.length; i++) {
		const previous = matchedEdits[i - 1];
		const current = matchedEdits[i];
		if (previous.matchIndex + previous.matchLength > current.matchIndex) {
			throw new Error(
				`edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
			);
		}
	}

	const baseContent = normalizedContent;
	const newContent = usedFuzzyMatch
		? applyReplacementsPreservingUnchangedLines(normalizedContent, replacementBaseContent, matchedEdits)
		: applyReplacements(replacementBaseContent, matchedEdits);

	if (baseContent === newContent) {
		throw getNoChangeError(path, normalizedEdits.length);
	}

	return { baseContent, newContent };
}

/*
 * Line diffs over the changed window.
 *
 * Diff.diffLines tokenizes both texts in full, and the edit tool diffs the whole file up to three times per
 * edit (preview, display diff, patch). An edit changes a few lines of a large file, so most of that work walks
 * the unchanged prefix and suffix. `computeLineDiff` runs the same Myers search as jsdiff 8 (`Diff.diffWithOptionsObj`
 * with default options), step for step, so it returns the same parts, but:
 * - the common prefix is found by comparing text instead of lines; jsdiff's first step consumes exactly those lines,
 * - lines are split from the text on demand, so lines the search never reaches are never split,
 * - on the diagonal that ends at the end of both texts, reaching the common suffix ends the walk directly; jsdiff
 *   compares those lines one by one and finds them all equal.
 * The display diff and the patch are then built from the parts exactly as `generateDiffString` and
 * `Diff.structuredPatch` did, reading only the lines they output.
 *
 * Calling jsdiff on a cut-out window is not equivalent: lines after the change can make it align the change
 * differently. Lines "b c" against "c b" diff as "-b c +b", but with a common "b" appended jsdiff returns
 * "-b c b +b", not "-b c +b b". test/edit-diff-fast-path.test.ts
 * compares the output with jsdiff on randomized inputs; rerun it when upgrading the diff package.
 */

/** A part of a line diff: like a jsdiff change object, without its value. */
interface LineRun {
	count: number;
	added: boolean;
	removed: boolean;
}

interface LineComponent extends LineRun {
	previousComponent: LineComponent | undefined;
}

interface DiffPath {
	oldPos: number;
	lastComponent: LineComponent | undefined;
}

/**
 * The lines of a text as jsdiff tokenizes them (each with its trailing "\n"), split on demand. Splitting
 * starts at a known line start and goes forward or backward from there.
 */
class LazyLines {
	readonly text: string;
	readonly count: number;
	private readonly base: number;
	private readonly forward: string[] = [];
	private readonly backward: string[] = [];
	private forwardEnd: number;
	private backwardStart: number;

	constructor(text: string, count: number, base: number, baseOffset: number) {
		this.text = text;
		this.count = count;
		this.base = base;
		this.forwardEnd = baseOffset;
		this.backwardStart = baseOffset;
	}

	get(index: number): string {
		if (index >= this.base) {
			const forwardIndex = index - this.base;
			while (this.forward.length <= forwardIndex) {
				const newline = this.text.indexOf("\n", this.forwardEnd);
				const end = newline === -1 ? this.text.length : newline + 1;
				this.forward.push(this.text.slice(this.forwardEnd, end));
				this.forwardEnd = end;
			}
			return this.forward[forwardIndex];
		}
		const backwardIndex = this.base - 1 - index;
		while (this.backward.length <= backwardIndex) {
			const end = this.backwardStart;
			const start = end < 2 ? 0 : this.text.lastIndexOf("\n", end - 2) + 1;
			this.backward.push(this.text.slice(start, end));
			this.backwardStart = start;
		}
		return this.backward[backwardIndex];
	}
}

/** Array.prototype.slice index resolution. */
function resolveSliceIndex(value: number | undefined, length: number, fallback: number): number {
	if (value === undefined) return fallback;
	const index = Math.trunc(value) || 0;
	return index < 0 ? Math.max(length + index, 0) : Math.min(index, length);
}

/** The lines of one diff part, read on demand. Stands in for the arrays split from a part's value. */
class PartLines {
	readonly length: number;
	private readonly lines: LazyLines;
	private readonly start: number;
	private readonly keepNewlines: boolean;

	constructor(lines: LazyLines, start: number, length: number, keepNewlines: boolean) {
		this.lines = lines;
		this.start = start;
		this.length = length;
		this.keepNewlines = keepNewlines;
	}

	/** Same result as `slice` on the array of the part's lines. */
	slice(start?: number, end?: number): string[] {
		const from = resolveSliceIndex(start, this.length, 0);
		const to = resolveSliceIndex(end, this.length, this.length);
		const result: string[] = [];
		for (let i = from; i < to; i++) {
			const line = this.lines.get(this.start + i);
			result.push(this.keepNewlines || !line.endsWith("\n") ? line : line.slice(0, -1));
		}
		return result;
	}
}

interface LineDiff {
	oldText: string;
	newText: string;
	runs: LineRun[];
	oldLines: LazyLines;
	newLines: LazyLines;
	/** `text.split("\n").length` of each side. */
	oldSplitLength: number;
	newSplitLength: number;
}

const COMMON_RUN_INITIAL_CHUNK = 256;
const COMMON_RUN_LINEAR_SCAN = 32;

function commonPrefixLength(a: string, b: string): number {
	const max = Math.min(a.length, b.length);
	let low = 0;
	let step = COMMON_RUN_INITIAL_CHUNK;
	while (low < max) {
		let high = Math.min(low + step, max);
		if (a.slice(low, high) !== b.slice(low, high)) {
			// The first difference is in [low, high).
			while (high - low > COMMON_RUN_LINEAR_SCAN) {
				const mid = low + Math.floor((high - low) / 2);
				if (a.slice(low, mid) === b.slice(low, mid)) low = mid;
				else high = mid;
			}
			while (a.charCodeAt(low) === b.charCodeAt(low)) low++;
			return low;
		}
		low = high;
		step *= 2;
	}
	return max;
}

/** Length of the common suffix of `a` and `b`, at most `max`. */
function commonSuffixLength(a: string, b: string, max: number): number {
	let low = 0;
	let step = COMMON_RUN_INITIAL_CHUNK;
	while (low < max) {
		let high = Math.min(low + step, max);
		if (a.slice(a.length - high, a.length - low) !== b.slice(b.length - high, b.length - low)) {
			// The last difference is in the suffix lengths (low, high].
			while (high - low > COMMON_RUN_LINEAR_SCAN) {
				const mid = low + Math.floor((high - low) / 2);
				if (a.slice(a.length - mid, a.length - low) === b.slice(b.length - mid, b.length - low)) low = mid;
				else high = mid;
			}
			while (a.charCodeAt(a.length - low - 1) === b.charCodeAt(b.length - low - 1)) low++;
			return low;
		}
		low = high;
		step *= 2;
	}
	return max;
}

function countNewlines(text: string, from: number, to: number): number {
	let count = 0;
	let index = text.indexOf("\n", from);
	while (index !== -1 && index < to) {
		count++;
		index = text.indexOf("\n", index + 1);
	}
	return count;
}

/** Number of jsdiff line tokens in `text.slice(from, to)`, where `from` is a line start. */
function countLines(text: string, from: number, to: number): number {
	return countNewlines(text, from, to) + (to > from && text.charCodeAt(to - 1) !== 10 ? 1 : 0);
}

function addToPath(path: DiffPath, added: boolean, removed: boolean, oldPosInc: number): DiffPath {
	const last = path.lastComponent;
	if (last && last.added === added && last.removed === removed) {
		return {
			oldPos: path.oldPos + oldPosInc,
			lastComponent: { count: last.count + 1, added, removed, previousComponent: last.previousComponent },
		};
	}
	return {
		oldPos: path.oldPos + oldPosInc,
		lastComponent: { count: 1, added, removed, previousComponent: last },
	};
}

function buildRuns(lastComponent: LineComponent | undefined): LineRun[] {
	const runs: LineRun[] = [];
	for (let component = lastComponent; component; component = component.previousComponent) {
		runs.push({ count: component.count, added: component.added, removed: component.removed });
	}
	return runs.reverse();
}

/** jsdiff's Myers search (`Diff.diffWithOptionsObj`, default options) over lazily split lines. */
function diffLineRuns(oldLines: LazyLines, newLines: LazyLines, prefixLines: number, suffixLines: number): LineRun[] {
	const oldLen = oldLines.count;
	const newLen = newLines.count;
	const endDiagonal = oldLen - newLen;
	const oldSuffixStart = oldLen - suffixLines;

	const extractCommon = (basePath: DiffPath, diagonalPath: number): number => {
		let oldPos = basePath.oldPos;
		let newPos = oldPos - diagonalPath;
		let commonCount = 0;
		while (newPos + 1 < newLen && oldPos + 1 < oldLen) {
			if (diagonalPath === endDiagonal && oldPos + 1 >= oldSuffixStart) {
				// Both sides are in the common suffix at the same distance from the end: all remaining lines match.
				const remaining = oldLen - 1 - oldPos;
				oldPos += remaining;
				newPos += remaining;
				commonCount += remaining;
				break;
			}
			if (oldLines.get(oldPos + 1) !== newLines.get(newPos + 1)) break;
			newPos++;
			oldPos++;
			commonCount++;
		}
		if (commonCount) {
			basePath.lastComponent = {
				count: commonCount,
				previousComponent: basePath.lastComponent,
				added: false,
				removed: false,
			};
		}
		basePath.oldPos = oldPos;
		return newPos;
	};

	// jsdiff's first step: the common prefix on diagonal 0.
	const firstPath: DiffPath = {
		oldPos: prefixLines - 1,
		lastComponent:
			prefixLines > 0
				? { count: prefixLines, added: false, removed: false, previousComponent: undefined }
				: undefined,
	};
	let newPos = prefixLines - 1;
	if (firstPath.oldPos + 1 >= oldLen && newPos + 1 >= newLen) {
		return buildRuns(firstPath.lastComponent);
	}
	const bestPath = new Map<number, DiffPath | undefined>([[0, firstPath]]);

	let minDiagonalToConsider = -Infinity;
	let maxDiagonalToConsider = Infinity;
	const maxEditLength = newLen + oldLen;
	for (let editLength = 1; editLength <= maxEditLength; editLength++) {
		for (
			let diagonalPath = Math.max(minDiagonalToConsider, -editLength);
			diagonalPath <= Math.min(maxDiagonalToConsider, editLength);
			diagonalPath += 2
		) {
			const removePath = bestPath.get(diagonalPath - 1);
			const addPath = bestPath.get(diagonalPath + 1);
			if (removePath) {
				bestPath.set(diagonalPath - 1, undefined);
			}
			const canAdd =
				addPath !== undefined && 0 <= addPath.oldPos - diagonalPath && addPath.oldPos - diagonalPath < newLen;
			const canRemove = removePath !== undefined && removePath.oldPos + 1 < oldLen;
			let basePath: DiffPath;
			if (canAdd && (!canRemove || removePath.oldPos < addPath.oldPos)) {
				basePath = addToPath(addPath, true, false, 0);
			} else if (canRemove) {
				basePath = addToPath(removePath, false, true, 1);
			} else {
				bestPath.set(diagonalPath, undefined);
				continue;
			}
			newPos = extractCommon(basePath, diagonalPath);
			if (basePath.oldPos + 1 >= oldLen && newPos + 1 >= newLen) {
				return buildRuns(basePath.lastComponent);
			}
			bestPath.set(diagonalPath, basePath);
			if (basePath.oldPos + 1 >= oldLen) {
				maxDiagonalToConsider = Math.min(maxDiagonalToConsider, diagonalPath - 1);
			}
			if (newPos + 1 >= newLen) {
				minDiagonalToConsider = Math.max(minDiagonalToConsider, diagonalPath + 1);
			}
		}
	}
	// Unreachable: an edit script of length oldLen + newLen always exists.
	throw new Error("Line diff did not terminate.");
}

function computeLineDiff(oldText: string, newText: string): LineDiff {
	if (oldText === newText) {
		const count = countLines(oldText, 0, oldText.length);
		const lines = new LazyLines(oldText, count, 0, 0);
		const splitLength = countNewlines(oldText, 0, oldText.length) + 1;
		return {
			oldText,
			newText,
			runs: count > 0 ? [{ count, added: false, removed: false }] : [],
			oldLines: lines,
			newLines: lines,
			oldSplitLength: splitLength,
			newSplitLength: splitLength,
		};
	}

	// Common prefix lines end at the last "\n" of the common prefix. The texts differ, so a final line
	// without "\n" cannot be common to both.
	const prefixChars = commonPrefixLength(oldText, newText);
	const prefixEnd = prefixChars === 0 ? 0 : oldText.lastIndexOf("\n", prefixChars - 1) + 1;

	// Common suffix lines start at a line start in both texts, after the prefix lines.
	const suffixChars = commonSuffixLength(oldText, newText, Math.min(oldText.length, newText.length) - prefixEnd);
	const oldTail = oldText.length - suffixChars;
	const newTail = newText.length - suffixChars;
	let suffixLength: number;
	if (
		(oldTail === 0 || oldText.charCodeAt(oldTail - 1) === 10) &&
		(newTail === 0 || newText.charCodeAt(newTail - 1) === 10)
	) {
		suffixLength = suffixChars;
	} else {
		const newline = oldText.indexOf("\n", oldTail);
		suffixLength = newline === -1 ? 0 : oldText.length - newline - 1;
	}
	const oldSuffixStart = oldText.length - suffixLength;
	const newSuffixStart = newText.length - suffixLength;

	const prefixLines = countNewlines(oldText, 0, prefixEnd);
	const suffixNewlines = countNewlines(oldText, oldSuffixStart, oldText.length);
	const suffixLines = countLines(oldText, oldSuffixStart, oldText.length);
	const oldMiddleNewlines = countNewlines(oldText, prefixEnd, oldSuffixStart);
	const newMiddleNewlines = countNewlines(newText, prefixEnd, newSuffixStart);

	const oldLines = new LazyLines(
		oldText,
		prefixLines + countLines(oldText, prefixEnd, oldSuffixStart) + suffixLines,
		prefixLines,
		prefixEnd,
	);
	const newLines = new LazyLines(
		newText,
		prefixLines + countLines(newText, prefixEnd, newSuffixStart) + suffixLines,
		prefixLines,
		prefixEnd,
	);
	return {
		oldText,
		newText,
		runs: diffLineRuns(oldLines, newLines, prefixLines, suffixLines),
		oldLines,
		newLines,
		oldSplitLength: prefixLines + oldMiddleNewlines + suffixNewlines + 1,
		newSplitLength: prefixLines + newMiddleNewlines + suffixNewlines + 1,
	};
}

let lastLineDiff: LineDiff | undefined;

/** computeLineDiff, remembering the last result: the edit tool builds a display diff and a patch of the same texts. */
function getLineDiff(oldText: string, newText: string): LineDiff {
	if (lastLineDiff?.oldText !== oldText || lastLineDiff.newText !== newText) {
		lastLineDiff = computeLineDiff(oldText, newText);
	}
	return lastLineDiff;
}

/** The lines of each part of `lineDiff`, as jsdiff would put them in the part's value. */
function getPartLines(lineDiff: LineDiff, keepNewlines: boolean): PartLines[] {
	let oldIndex = 0;
	let newIndex = 0;
	return lineDiff.runs.map((run) => {
		if (run.removed) {
			const lines = new PartLines(lineDiff.oldLines, oldIndex, run.count, keepNewlines);
			oldIndex += run.count;
			return lines;
		}
		const lines = new PartLines(lineDiff.newLines, newIndex, run.count, keepNewlines);
		newIndex += run.count;
		if (!run.added) oldIndex += run.count;
		return lines;
	});
}

interface PatchHunk {
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	lines: string[];
}

/**
 * Generate a standard unified patch. Same output as
 * `Diff.createTwoFilesPatch(path, path, oldContent, newContent, undefined, undefined, { context: contextLines, headerOptions: Diff.FILE_HEADERS_ONLY })`.
 */
export function generateUnifiedPatch(path: string, oldContent: string, newContent: string, contextLines = 4): string {
	const lineDiff = getLineDiff(oldContent, newContent);
	const runs = lineDiff.runs;
	const partLines = getPartLines(lineDiff, true);
	const context = contextLines;

	// Diff.structuredPatch, step 1. jsdiff appends an empty part to make cleanup easier; index runs.length is it.
	const partCount = runs.length + 1;
	const emptyLines = new PartLines(lineDiff.newLines, 0, 0, true);
	const contextLinesOf = (lines: string[]): string[] => lines.map((entry) => ` ${entry}`);
	const hunks: PatchHunk[] = [];
	let oldRangeStart = 0;
	let newRangeStart = 0;
	let curRange: string[] = [];
	let oldLine = 1;
	let newLine = 1;
	for (let i = 0; i < partCount; i++) {
		const current: LineRun = i < runs.length ? runs[i] : { count: 0, added: false, removed: false };
		const lines = i < runs.length ? partLines[i] : emptyLines;
		if (current.added || current.removed) {
			// If we have previous context, start with that
			if (!oldRangeStart) {
				oldRangeStart = oldLine;
				newRangeStart = newLine;
				if (i > 0) {
					curRange = context > 0 ? contextLinesOf(partLines[i - 1].slice(-context)) : [];
					oldRangeStart -= curRange.length;
					newRangeStart -= curRange.length;
				}
			}
			// Output our changes
			for (const line of lines.slice()) {
				curRange.push((current.added ? "+" : "-") + line);
			}
			// Track the updated file position
			if (current.added) {
				newLine += lines.length;
			} else {
				oldLine += lines.length;
			}
		} else {
			// Identical context lines. Track line changes
			if (oldRangeStart) {
				// Close out any changes that have been output (or join overlapping)
				if (lines.length <= context * 2 && i < partCount - 2) {
					// Overlapping
					for (const line of contextLinesOf(lines.slice())) {
						curRange.push(line);
					}
				} else {
					// end the range and output
					const contextSize = Math.min(lines.length, context);
					for (const line of contextLinesOf(lines.slice(0, contextSize))) {
						curRange.push(line);
					}
					hunks.push({
						oldStart: oldRangeStart,
						oldLines: oldLine - oldRangeStart + contextSize,
						newStart: newRangeStart,
						newLines: newLine - newRangeStart + contextSize,
						lines: curRange,
					});
					oldRangeStart = 0;
					newRangeStart = 0;
					curRange = [];
				}
			}
			oldLine += lines.length;
			newLine += lines.length;
		}
	}

	// Step 2: eliminate the trailing "\n" from each line of each hunk, and, where needed, add
	// "\ No newline at end of file".
	for (const hunk of hunks) {
		for (let i = 0; i < hunk.lines.length; i++) {
			if (hunk.lines[i].endsWith("\n")) {
				hunk.lines[i] = hunk.lines[i].slice(0, -1);
			} else {
				hunk.lines.splice(i + 1, 0, "\\ No newline at end of file");
				i++; // Skip the line we just added, then continue iterating
			}
		}
	}

	// Diff.formatPatch with Diff.FILE_HEADERS_ONLY.
	const ret = [`--- ${path}`, `+++ ${path}`];
	for (const hunk of hunks) {
		// Unified Diff Format quirk: If the chunk size is 0, the first number is one lower than one would expect.
		if (hunk.oldLines === 0) {
			hunk.oldStart -= 1;
		}
		if (hunk.newLines === 0) {
			hunk.newStart -= 1;
		}
		ret.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
		for (const line of hunk.lines) {
			ret.push(line);
		}
	}
	return `${ret.join("\n")}\n`;
}

/**
 * Generate a display-oriented diff string with line numbers and context.
 * Returns both the diff string and the first changed line number (in the new file).
 */
export function generateDiffString(
	oldContent: string,
	newContent: string,
	contextLines = 4,
): { diff: string; firstChangedLine: number | undefined } {
	const lineDiff = getLineDiff(oldContent, newContent);
	const parts = lineDiff.runs;
	const partLines = getPartLines(lineDiff, false);
	const output: string[] = [];

	const maxLineNum = Math.max(lineDiff.oldSplitLength, lineDiff.newSplitLength);
	const lineNumWidth = String(maxLineNum).length;

	let oldLineNum = 1;
	let newLineNum = 1;
	let lastWasChange = false;
	let firstChangedLine: number | undefined;

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		const raw = partLines[i];

		if (part.added || part.removed) {
			// Capture the first changed line (in the new file)
			if (firstChangedLine === undefined) {
				firstChangedLine = newLineNum;
			}

			// Show the change
			for (const line of raw.slice()) {
				if (part.added) {
					const lineNum = String(newLineNum).padStart(lineNumWidth, " ");
					output.push(`+${lineNum} ${line}`);
					newLineNum++;
				} else {
					// removed
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(`-${lineNum} ${line}`);
					oldLineNum++;
				}
			}
			lastWasChange = true;
		} else {
			// Context lines - only show a few before/after changes
			const nextPartIsChange = i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed);
			const hasLeadingChange = lastWasChange;
			const hasTrailingChange = nextPartIsChange;

			if (hasLeadingChange && hasTrailingChange) {
				if (raw.length <= contextLines * 2) {
					for (const line of raw.slice()) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}
				} else {
					const leadingLines = raw.slice(0, contextLines);
					const trailingLines = raw.slice(raw.length - contextLines);
					const skippedLines = raw.length - leadingLines.length - trailingLines.length;

					for (const line of leadingLines) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}

					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;

					for (const line of trailingLines) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}
				}
			} else if (hasLeadingChange) {
				const shownLines = raw.slice(0, contextLines);
				const skippedLines = raw.length - shownLines.length;

				for (const line of shownLines) {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(` ${lineNum} ${line}`);
					oldLineNum++;
					newLineNum++;
				}

				if (skippedLines > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;
				}
			} else if (hasTrailingChange) {
				const skippedLines = Math.max(0, raw.length - contextLines);
				if (skippedLines > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;
				}

				for (const line of raw.slice(skippedLines)) {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(` ${lineNum} ${line}`);
					oldLineNum++;
					newLineNum++;
				}
			} else {
				// Skip these context lines entirely
				oldLineNum += raw.length;
				newLineNum += raw.length;
			}

			lastWasChange = false;
		}
	}

	return { diff: output.join("\n"), firstChangedLine };
}

export interface EditDiffResult {
	diff: string;
	firstChangedLine: number | undefined;
}

export interface EditDiffError {
	error: string;
}

/**
 * Compute the diff for one or more edit operations without applying them.
 * Used for preview rendering in the TUI before the tool executes.
 */
export async function computeEditsDiff(
	path: string,
	edits: Edit[],
	cwd: string,
): Promise<EditDiffResult | EditDiffError> {
	const absolutePath = resolveToCwd(path, cwd);

	try {
		// Check if file exists and is readable
		try {
			await access(absolutePath, constants.R_OK);
		} catch (error: unknown) {
			const errorMessage = error instanceof Error && "code" in error ? `Error code: ${error.code}` : String(error);
			return { error: `Could not edit file: ${path}. ${errorMessage}.` };
		}

		// Read the file
		const rawContent = await readFile(absolutePath, "utf-8");

		// Strip BOM before matching (LLM won't include invisible BOM in oldText)
		const { text: content } = splitBom(rawContent);
		const normalizedContent = normalizeToLF(content);
		const { baseContent, newContent } = applyEditsToNormalizedContent(normalizedContent, edits, path);

		// Generate the diff
		return generateDiffString(baseContent, newContent);
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * Compute the diff for a single edit operation without applying it.
 * Kept as a convenience wrapper for single-edit callers.
 */
export async function computeEditDiff(
	path: string,
	oldText: string,
	newText: string,
	cwd: string,
): Promise<EditDiffResult | EditDiffError> {
	return computeEditsDiff(path, [{ oldText, newText }], cwd);
}
