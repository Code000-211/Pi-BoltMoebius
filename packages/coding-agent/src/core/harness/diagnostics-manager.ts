import { existsSync, readFileSync, statSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import { stripBom } from "../../utils/text.ts";
import type { BackgroundChecks } from "../checks/background-checks.ts";
import { notifySearchFileTouched } from "../tools/native-search.ts";
import { CppHipDiagnosticsEngine } from "./cpp-hip-engine.ts";
import {
	type DiagnosticsResult,
	FileStateTracker,
	type HarnessDiagnostic,
	isCppOrHipFile,
} from "./file-state-tracker.ts";

function normalizeWarmupKey(filePath: string): string {
	const norm = normalize(resolve(filePath));
	return process.platform === "win32" ? norm.toLowerCase() : norm;
}

const NESTED_INSTRUCTION_CANDIDATES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];

function loadInstructionFileFromDir(dir: string): { path: string; content: string } | null {
	for (const filename of NESTED_INSTRUCTION_CANDIDATES) {
		const filePath = join(dir, filename);
		if (!existsSync(filePath)) continue;
		try {
			if (!statSync(filePath).isFile()) continue;
			return {
				path: filePath,
				content: stripBom(readFileSync(filePath, "utf-8")),
			};
		} catch {
			// Ignore unreadable files
		}
	}
	return null;
}

/**
 * Format nested `CLAUDE.md` / `AGENTS.md` files discovered on `read`, matching Claude Code's
 * `mods/agents-md` framing (`Contents of <path>:\n\n<content>`).
 */
export function formatNestedInstructionsReminder(files: Array<{ path: string; content: string }>): string {
	if (files.length === 0) return "";
	const frames = files.map((f) => `Contents of ${f.path}:\n\n${f.content.trimEnd()}`);
	return `\n\n<system-reminder>\n${frames.join("\n\n")}\n</system-reminder>`;
}

export type CustomDiagnosticsProvider = (
	absolutePath: string,
	content: string,
	workspaceCwd: string,
	isWarmup: boolean,
) => Promise<HarnessDiagnostic[]> | HarnessDiagnostic[];

export interface ClaudeHarnessOptions {
	/** Enforce that existing files must be read before edit/write and not modified externally. */
	enforceReadBeforeEdit?: boolean;
	/** Append a compact line-numbered context snippet around the edited region. */
	includePostEditSnippet?: boolean;
	/** Enable C++/HIP (libclang) automatic diagnostics during an edit. Default: true */
	enableDiagnostics?: boolean;
	/** Optional custom diagnostics provider (used for testing or custom toolchains). */
	customProvider?: CustomDiagnosticsProvider;
}

/**
 * Extract 1-indexed line `targetLine` without splitting the whole file into an array of strings.
 */
function extractSingleLine(text: string, targetLine: number): string | undefined {
	if (targetLine < 1 || !text) return undefined;
	let currentLine = 1;
	let lineStart = 0;
	while (currentLine < targetLine) {
		const nl = text.indexOf("\n", lineStart);
		if (nl === -1) return undefined;
		lineStart = nl + 1;
		currentLine++;
	}
	const lineEnd = text.indexOf("\n", lineStart);
	return lineEnd === -1 ? text.slice(lineStart) : text.slice(lineStart, lineEnd);
}

/**
 * Format a compact `cat -n` style snippet around `firstChangedLine` using a single `indexOf("\n")`
 * scan so large files never allocate a full `split("\n")` array.
 */
export function formatPostEditSnippet(
	newContent: string,
	firstChangedLine: number | undefined,
	contextRadius = 3,
): string {
	if (!firstChangedLine || firstChangedLine < 1 || !newContent) return "";

	const startLine = Math.max(1, firstChangedLine - contextRadius);
	const endLine = firstChangedLine + contextRadius + 2;

	const snippetLines: string[] = [];
	let currentLine = 1;
	let pos = 0;
	const len = newContent.length;

	while (pos <= len && currentLine <= endLine) {
		const nextNl = newContent.indexOf("\n", pos);
		if (currentLine >= startLine) {
			const lineText = nextNl === -1 ? newContent.slice(pos) : newContent.slice(pos, nextNl);
			const lineNo = String(currentLine).padStart(6, " ");
			snippetLines.push(`${lineNo}→${lineText}`);
		}
		if (nextNl === -1) break;
		pos = nextNl + 1;
		currentLine++;
	}

	if (snippetLines.length === 0) return "";
	return `\n\nHere is a snippet of the edited file around line ${firstChangedLine}:\n${snippetLines.join("\n")}`;
}

/**
 * Format newly introduced diagnostics into the `<new-diagnostics>` XML block Claude expects.
 */
export function formatNewDiagnosticsBlock(
	displayPath: string,
	fileContent: string | undefined,
	diagnostics: HarnessDiagnostic[],
): string {
	if (diagnostics.length === 0) return "";
	const formattedItems: string[] = [];

	// Cap at 15 diagnostics so a cascading syntax error never floods the context window
	const capped = diagnostics.slice(0, 15);
	for (const d of capped) {
		const sevLabel = d.severity === "error" ? "Error" : "Warning";
		const codePart = d.code ? ` (${d.code})` : "";
		let entry = `  Line ${d.line}, Col ${d.column} [${sevLabel}]${codePart}: ${d.message}`;
		const srcLine = fileContent ? extractSingleLine(fileContent, d.line) : undefined;
		if (srcLine !== undefined && srcLine.trim().length > 0 && srcLine.length <= 160) {
			entry += `\n    ${d.line} | ${srcLine}`;
		}
		formattedItems.push(entry);
	}

	if (diagnostics.length > capped.length) {
		formattedItems.push(`  ... and ${diagnostics.length - capped.length} more diagnostic(s).`);
	}

	return `\n\n<new-diagnostics>\nThe following new diagnostic issues were introduced by your edit in ${displayPath}:\n${formattedItems.join("\n")}\n</new-diagnostics>`;
}

export class ClaudeHarnessManager {
	readonly stateTracker = new FileStateTracker();
	readonly cppHipEngine: CppHipDiagnosticsEngine;
	private customProvider?: CustomDiagnosticsProvider;
	/** The checks other languages get in the background after an edit (see checks/background-checks.ts). */
	private checks?: BackgroundChecks;
	private defaultEnableDiagnostics: boolean;
	private inflightWarmups = new Map<string, Promise<void>>();

	constructor(options?: { customProvider?: CustomDiagnosticsProvider; enableDiagnostics?: boolean }) {
		this.cppHipEngine = new CppHipDiagnosticsEngine(this.stateTracker);
		this.customProvider = options?.customProvider;
		this.defaultEnableDiagnostics = options?.enableDiagnostics ?? true;
	}

	setCustomProvider(provider: CustomDiagnosticsProvider | undefined): void {
		this.customProvider = provider;
	}

	setBackgroundChecks(checks: BackgroundChecks | undefined): void {
		this.checks = checks;
	}

	dispose(): void {
		this.cppHipEngine.dispose();
		this.inflightWarmups.clear();
	}

	/**
	 * Called by `read.ts` as soon as a file is read.
	 * Records the file's mtime & content, starts the background libclang warmup and the file's background check
	 * (its baseline), and returns the nested instruction files found on the way.
	 * Pass `contentComplete: false` when `content` is only a prefix of a large file.
	 */
	onFileRead(
		absolutePath: string,
		content: string,
		mtimeMs: number,
		workspaceCwd: string,
		rawBuffer?: Buffer,
		contentComplete = true,
	): string {
		this.stateTracker.recordFileRead(absolutePath, content, mtimeMs, contentComplete);
		if (contentComplete) {
			notifySearchFileTouched(absolutePath, rawBuffer ?? content, mtimeMs);
			this.checks?.onRead(absolutePath);
		}

		// Fire-and-forget pre-warming on background worker / LSP so `read` returns in 0ms!
		// A prefix of a large file would only produce bogus baseline diagnostics, so skip it.
		if (
			contentComplete &&
			this.defaultEnableDiagnostics &&
			(this.customProvider !== undefined || isCppOrHipFile(absolutePath))
		) {
			const key = normalizeWarmupKey(absolutePath);
			const p: Promise<void> = this.runWarmupInBackground(absolutePath, content, workspaceCwd).finally(() => {
				// A newer read may have replaced this warmup; only remove our own entry.
				if (this.inflightWarmups.get(key) === p) this.inflightWarmups.delete(key);
			});
			this.inflightWarmups.set(key, p);
		}

		const nestedFiles = this.stateTracker.discoverNestedInstructionsOnRead(
			absolutePath,
			workspaceCwd,
			loadInstructionFileFromDir,
		);
		return formatNestedInstructionsReminder(nestedFiles);
	}

	/**
	 * Verify Read-Before-Edit, mtime staleness & content equality guard before modifying an existing file.
	 */
	assertCanModifyExistingFile(
		absolutePath: string,
		currentMtimeMs: number | undefined,
		currentContent?: string,
	): void {
		this.stateTracker.assertCanModifyExistingFile(absolutePath, currentMtimeMs, currentContent);
	}

	/**
	 * Called by `edit.ts` / `write.ts` after writing the new content.
	 * Runs fast in-memory reparse, diffs against baseline diagnostics, updates tracked state,
	 * and returns the formatted snippet + `<new-diagnostics>` suffix.
	 *
	 * `newContent` must be exactly what was written to disk (BOM and line endings included) so the
	 * next read-before-edit content check matches. `displayContent` is the LF-normalized text used
	 * for the snippet and diagnostic source lines; it defaults to `newContent`.
	 */
	async onFileModified(params: {
		absolutePath: string;
		displayPath: string;
		newContent: string;
		displayContent?: string;
		newMtimeMs: number;
		workspaceCwd: string;
		firstChangedLine?: number;
		includePostEditSnippet?: boolean;
		enableDiagnostics?: boolean;
	}): Promise<{ suffix: string; newDiagnostics: HarnessDiagnostic[] }> {
		const {
			absolutePath,
			displayPath,
			newContent,
			displayContent = newContent,
			newMtimeMs,
			workspaceCwd,
			firstChangedLine,
			includePostEditSnippet = false,
			enableDiagnostics = this.defaultEnableDiagnostics,
		} = params;

		let result: DiagnosticsResult | undefined;
		let newDiagnostics: HarnessDiagnostic[] = [];

		// Fast path: only enter the async diagnostics pipeline for supported languages or custom providers
		const shouldRunDiagnostics =
			enableDiagnostics && (this.customProvider !== undefined || isCppOrHipFile(absolutePath));

		if (shouldRunDiagnostics) {
			const pendingWarmup = this.inflightWarmups.get(normalizeWarmupKey(absolutePath));
			if (pendingWarmup) {
				await pendingWarmup;
			}
			try {
				result = await this.collectDiagnostics(absolutePath, newContent, workspaceCwd, false);
				newDiagnostics = this.stateTracker.diffAgainstBaseline(absolutePath, result.diagnostics);
			} catch {
				// A failing diagnostics provider must never fail the edit/write itself
				result = undefined;
			}
		}

		this.stateTracker.recordFileModifiedByAgent(
			absolutePath,
			newContent,
			newMtimeMs,
			result?.diagnostics,
			result?.complete === false ? "merge" : "replace",
		);
		notifySearchFileTouched(absolutePath, newContent, newMtimeMs);
		this.checks?.onEdited(absolutePath);

		let suffix = "";
		if (includePostEditSnippet && firstChangedLine !== undefined) {
			suffix += formatPostEditSnippet(displayContent, firstChangedLine);
		}
		if (newDiagnostics.length > 0) {
			suffix += formatNewDiagnosticsBlock(displayPath, displayContent, newDiagnostics);
		}

		return { suffix, newDiagnostics };
	}

	private async runWarmupInBackground(absolutePath: string, content: string, workspaceCwd: string): Promise<void> {
		try {
			const result = await this.collectDiagnostics(absolutePath, content, workspaceCwd, true);
			this.stateTracker.updateBaselineDiagnostics(
				absolutePath,
				result.diagnostics,
				result.complete ? "replace" : "merge",
			);
		} catch {
			// Never let background warmup errors surface as unhandled rejections
		}
	}

	private async collectDiagnostics(
		absolutePath: string,
		content: string,
		workspaceCwd: string,
		isWarmup: boolean,
	): Promise<DiagnosticsResult> {
		if (this.customProvider) {
			const diagnostics = await this.customProvider(absolutePath, content, workspaceCwd, isWarmup);
			return { diagnostics, complete: true };
		}
		if (isCppOrHipFile(absolutePath)) {
			return isWarmup
				? await this.cppHipEngine.warmupFile(absolutePath, content, workspaceCwd)
				: await this.cppHipEngine.checkEditedFile(absolutePath, content, workspaceCwd);
		}
		return { diagnostics: [], complete: true };
	}
}

export const defaultClaudeHarnessManager = new ClaudeHarnessManager();
