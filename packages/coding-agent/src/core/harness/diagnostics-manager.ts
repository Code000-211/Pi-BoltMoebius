import { notifySearchFileTouched } from "../tools/native-search.ts";
import { CppHipDiagnosticsEngine } from "./cpp-hip-engine.ts";
import { FileStateTracker, type HarnessDiagnostic, isCppOrHipFile, isRustFile } from "./file-state-tracker.ts";
import { type LateRustDiagnosticBatch, RustDiagnosticsEngine } from "./rust-engine.ts";

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
	/** Enable C++/HIP (libclang) and Rust (rust-analyzer) automatic diagnostics. Default: true */
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

/**
 * Format late borrow-checker diagnostics into a `<system-reminder>` block for the next turn.
 */
export function formatLateDiagnosticsReminder(batches: LateRustDiagnosticBatch[]): string {
	if (batches.length === 0) return "";
	const sections: string[] = [];
	for (const batch of batches) {
		const items = batch.diagnostics.slice(0, 10).map((d) => {
			const sevLabel = d.severity === "error" ? "Error" : "Warning";
			const codePart = d.code ? ` (${d.code})` : "";
			return `  Line ${d.line}, Col ${d.column} [${sevLabel}]${codePart}: ${d.message}`;
		});
		sections.push(`Late Rust borrow-checker / cargo diagnostics for ${batch.filePath}:\n${items.join("\n")}`);
	}
	return `\n\n<system-reminder>\n<new-diagnostics>\n${sections.join("\n\n")}\n</new-diagnostics>\n</system-reminder>`;
}

export class ClaudeHarnessManager {
	readonly stateTracker = new FileStateTracker();
	readonly cppHipEngine: CppHipDiagnosticsEngine;
	readonly rustEngine: RustDiagnosticsEngine;
	private customProvider?: CustomDiagnosticsProvider;
	private defaultEnableDiagnostics: boolean;
	private inflightWarmups = new Map<string, Promise<void>>();

	constructor(options?: { customProvider?: CustomDiagnosticsProvider; enableDiagnostics?: boolean }) {
		this.cppHipEngine = new CppHipDiagnosticsEngine(this.stateTracker);
		this.rustEngine = new RustDiagnosticsEngine(this.stateTracker);
		this.customProvider = options?.customProvider;
		this.defaultEnableDiagnostics = options?.enableDiagnostics ?? true;
	}

	setCustomProvider(provider: CustomDiagnosticsProvider | undefined): void {
		this.customProvider = provider;
	}

	dispose(): void {
		this.cppHipEngine.dispose();
		this.rustEngine.dispose();
	}

	/**
	 * Called by `read.ts` as soon as a file is read.
	 * Records the file's mtime & content, starts background LSP/libclang warmup (0ms blocking),
	 * and returns any pending late Rust `<system-reminder>` block.
	 */
	onFileRead(
		absolutePath: string,
		content: string,
		mtimeMs: number,
		workspaceCwd: string,
		rawBuffer?: Buffer,
	): string {
		this.stateTracker.recordFileRead(absolutePath, content, mtimeMs);
		notifySearchFileTouched(absolutePath, rawBuffer ?? content, mtimeMs);

		// Fire-and-forget pre-warming on background worker / LSP so `read` returns in 0ms!
		if (
			this.defaultEnableDiagnostics &&
			(this.customProvider !== undefined || isCppOrHipFile(absolutePath) || isRustFile(absolutePath))
		) {
			const p = this.runWarmupInBackground(absolutePath, content, workspaceCwd).finally(() => {
				this.inflightWarmups.delete(absolutePath);
			});
			this.inflightWarmups.set(absolutePath, p);
		}

		return this.drainPendingSystemReminder();
	}

	/**
	 * Verify Read-Before-Edit & mtime staleness guard before modifying an existing file.
	 */
	assertCanModifyExistingFile(absolutePath: string, currentMtimeMs: number | undefined): void {
		this.stateTracker.assertCanModifyExistingFile(absolutePath, currentMtimeMs);
	}

	/**
	 * Called by `edit.ts` / `write.ts` after writing the new content.
	 * Runs fast in-memory reparse, diffs against baseline diagnostics, updates tracked state,
	 * and returns the formatted snippet + `<new-diagnostics>` suffix.
	 */
	async onFileModified(params: {
		absolutePath: string;
		displayPath: string;
		newContent: string;
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
			newMtimeMs,
			workspaceCwd,
			firstChangedLine,
			includePostEditSnippet = false,
			enableDiagnostics = this.defaultEnableDiagnostics,
		} = params;

		let allDiagnostics: HarnessDiagnostic[] = [];
		let newDiagnostics: HarnessDiagnostic[] = [];

		// Fast path: only enter the async diagnostics pipeline for supported languages or custom providers
		const shouldRunDiagnostics =
			enableDiagnostics &&
			(this.customProvider !== undefined || isCppOrHipFile(absolutePath) || isRustFile(absolutePath));

		if (shouldRunDiagnostics) {
			const pendingWarmup = this.inflightWarmups.get(absolutePath);
			if (pendingWarmup) {
				await pendingWarmup;
			}
			allDiagnostics = await this.collectDiagnostics(absolutePath, newContent, workspaceCwd, false);
			newDiagnostics = this.stateTracker.diffAgainstBaseline(absolutePath, allDiagnostics);
		}

		this.stateTracker.recordFileModifiedByAgent(absolutePath, newContent, newMtimeMs, allDiagnostics);
		notifySearchFileTouched(absolutePath, newContent, newMtimeMs);

		let suffix = "";
		if (includePostEditSnippet && firstChangedLine !== undefined) {
			suffix += formatPostEditSnippet(newContent, firstChangedLine);
		}
		if (newDiagnostics.length > 0) {
			suffix += formatNewDiagnosticsBlock(displayPath, newContent, newDiagnostics);
		}
		suffix += this.drainPendingSystemReminder();

		return { suffix, newDiagnostics };
	}

	drainPendingSystemReminder(): string {
		const lateRust = this.rustEngine.drainLateDiagnostics();
		return formatLateDiagnosticsReminder(lateRust);
	}

	private async runWarmupInBackground(absolutePath: string, content: string, workspaceCwd: string): Promise<void> {
		try {
			const diags = await this.collectDiagnostics(absolutePath, content, workspaceCwd, true);
			this.stateTracker.setBaselineDiagnostics(absolutePath, diags);
		} catch {
			// Never let background warmup errors surface as unhandled rejections
		}
	}

	private async collectDiagnostics(
		absolutePath: string,
		content: string,
		workspaceCwd: string,
		isWarmup: boolean,
	): Promise<HarnessDiagnostic[]> {
		if (this.customProvider) {
			return await this.customProvider(absolutePath, content, workspaceCwd, isWarmup);
		}
		if (isCppOrHipFile(absolutePath)) {
			return isWarmup
				? await this.cppHipEngine.warmupFile(absolutePath, content, workspaceCwd)
				: await this.cppHipEngine.checkEditedFile(absolutePath, content, workspaceCwd);
		}
		if (isRustFile(absolutePath)) {
			return isWarmup
				? await this.rustEngine.warmupFile(absolutePath, content, workspaceCwd)
				: await this.rustEngine.checkEditedFile(absolutePath, content, workspaceCwd);
		}
		return [];
	}
}

export const defaultClaudeHarnessManager = new ClaudeHarnessManager();
