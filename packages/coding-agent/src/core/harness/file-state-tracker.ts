import { dirname, extname, normalize, resolve } from "node:path";

export type DiagnosticSeverity = "error" | "warning";

export interface HarnessDiagnostic {
	file: string;
	line: number;
	column: number;
	severity: DiagnosticSeverity;
	message: string;
	code?: string;
}

export interface TrackedFileState {
	absolutePath: string;
	lastReadMtimeMs: number;
	/** Exact on-disk text (BOM and line endings included), or a prefix when `contentComplete` is false. */
	content: string;
	/** False when only a prefix of a large file was read, so `content` cannot be compared or reparsed. */
	contentComplete: boolean;
	/** True once the agent has written this file through edit/write. */
	modifiedByAgent: boolean;
	/** Fingerprint -> occurrence count of the diagnostics present before the agent's latest change. */
	baselineCounts: Map<string, number>;
}

/**
 * How newly collected diagnostics update the baseline: "replace" when the list is the complete,
 * settled set for the file; "merge" when it may be partial (e.g. a language server timed out).
 */
export type BaselineUpdateMode = "replace" | "merge";

/**
 * Diagnostics collected by an engine. `complete` is false when the engine could not wait for the
 * settled set (timeout, or a language server still working), so the list may be partial or empty.
 */
export interface DiagnosticsResult {
	diagnostics: HarnessDiagnostic[];
	complete: boolean;
}

const CPP_HIP_SOURCE_EXTENSIONS = new Set([".cpp", ".cc", ".cxx", ".c", ".cu", ".hip"]);
const CPP_HIP_HEADER_EXTENSIONS = new Set([".h", ".hh", ".hpp", ".hxx", ".cuh", ".hiph"]);
const RUST_EXTENSIONS = new Set([".rs"]);

export function isCppOrHipSource(filePath: string): boolean {
	return CPP_HIP_SOURCE_EXTENSIONS.has(extname(filePath).toLowerCase());
}

export function isCppOrHipHeader(filePath: string): boolean {
	return CPP_HIP_HEADER_EXTENSIONS.has(extname(filePath).toLowerCase());
}

export function isCppOrHipFile(filePath: string): boolean {
	const ext = extname(filePath).toLowerCase();
	return CPP_HIP_SOURCE_EXTENSIONS.has(ext) || CPP_HIP_HEADER_EXTENSIONS.has(ext);
}

export function isRustFile(filePath: string): boolean {
	return RUST_EXTENSIONS.has(extname(filePath).toLowerCase());
}

/**
 * Compute a line-independent fingerprint for a diagnostic so that shifting lines above an
 * existing warning/error does not falsely report pre-existing issues as newly introduced.
 */
export function diagnosticFingerprint(diag: HarnessDiagnostic): string {
	return `${diag.severity}|${diag.code ?? ""}|${diag.message.trim()}`;
}

function countFingerprints(diagnostics: HarnessDiagnostic[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const diag of diagnostics) {
		const fp = diagnosticFingerprint(diag);
		counts.set(fp, (counts.get(fp) ?? 0) + 1);
	}
	return counts;
}

/** An existing file changed on disk since the agent last read or wrote it. */
export class StaleFileError extends Error {
	constructor() {
		super(
			"File has been modified since it was last read (either by the user or an external tool). Read the file again before editing it.",
		);
		this.name = "StaleFileError";
	}
}

const LOCAL_INCLUDE_REGEX = /^\s*#\s*include\s*"([^"]+)"/gm;

export class FileStateTracker {
	private readonly files = new Map<string, TrackedFileState>();
	private readonly headerToHostSource = new Map<string, string>();
	private readonly dirInstructionCache = new Map<string, { path: string; content: string } | null>();
	private readonly sentNestedInstructions = new Set<string>();
	private lastActiveCppHipSource: string | undefined;

	private normalizeKey(filePath: string): string {
		const norm = normalize(resolve(filePath));
		return process.platform === "win32" ? norm.toLowerCase() : norm;
	}

	/**
	 * Verify that an existing file was previously read in this session and has not been modified
	 * externally since the last read/edit. A changed modification time alone is not a change when the
	 * content is known to be the same (`touch`, a formatter that changed nothing): the tracked time is
	 * moved instead. Throws `StaleFileError` when the file changed.
	 */
	assertCanModifyExistingFile(
		absolutePath: string,
		currentMtimeMs: number | undefined,
		currentContent?: string,
	): void {
		const key = this.normalizeKey(absolutePath);
		const state = this.files.get(key);
		if (!state) {
			throw new Error("File has not been read yet. Read it first before writing to it.");
		}
		const sameContent = currentContent !== undefined && state.contentComplete && currentContent === state.content;
		// Allow a 10ms tolerance for filesystem timestamp quantization across platforms
		if (currentMtimeMs !== undefined && currentMtimeMs > state.lastReadMtimeMs + 10) {
			if (!sameContent) throw new StaleFileError();
			state.lastReadMtimeMs = currentMtimeMs;
		}
		// Also guard against sub-millisecond external modifications where mtimeMs did not advance
		// (Claude Code v2.1.295 parity: compare exact content when available). A partial read of a
		// large file only recorded a prefix, so only the mtime check applies there.
		if (currentContent !== undefined && state.contentComplete && !sameContent) {
			throw new StaleFileError();
		}
	}

	/**
	 * Discover any unseen nested `CLAUDE.md` / `AGENTS.md` files in directories strictly below
	 * `workspaceCwd` up to `dirname(readAbsolutePath)` (matching Claude Code's `mods/agents-md`
	 * on-read hook). Each nested instruction file is returned at most once per session.
	 */
	discoverNestedInstructionsOnRead(
		readAbsolutePath: string,
		workspaceCwd: string,
		findInstructionInDir: (dir: string) => { path: string; content: string } | null,
	): Array<{ path: string; content: string }> {
		const rootNorm = normalize(resolve(workspaceCwd));
		const rootKey = this.normalizeKey(rootNorm);
		const readNorm = normalize(resolve(readAbsolutePath));
		const readKey = this.normalizeKey(readNorm);
		const sep = process.platform === "win32" ? "\\" : "/";
		const rootPrefix = rootKey.endsWith(sep) ? rootKey : `${rootKey}${sep}`;
		if (!readKey.startsWith(rootPrefix)) {
			return [];
		}

		// Collect ancestor directories between rootNorm (exclusive) and dirname(readNorm) (inclusive), root-first.
		const dirs: string[] = [];
		let currentDir = dirname(readNorm);
		while (true) {
			const currentKey = this.normalizeKey(currentDir);
			if (currentKey === rootKey || !currentKey.startsWith(rootPrefix)) break;
			dirs.push(currentDir);
			const parentDir = dirname(currentDir);
			if (parentDir === currentDir) break;
			currentDir = parentDir;
		}
		if (dirs.length === 0) return [];
		dirs.reverse();

		const attached: Array<{ path: string; content: string }> = [];
		for (const dir of dirs) {
			const dirKey = this.normalizeKey(dir);
			let cached = this.dirInstructionCache.get(dirKey);
			if (cached === undefined) {
				cached = findInstructionInDir(dir);
				this.dirInstructionCache.set(dirKey, cached);
			}
			if (!cached) continue;
			const fileKey = this.normalizeKey(cached.path);
			// If the user explicitly called Read on the instruction file itself, mark it as seen without duplicating it
			if (fileKey === readKey) {
				this.sentNestedInstructions.add(fileKey);
				continue;
			}
			if (this.sentNestedInstructions.has(fileKey)) continue;
			this.sentNestedInstructions.add(fileKey);
			attached.push(cached);
		}
		return attached;
	}

	/**
	 * Record that a file was read. Pass `contentComplete: false` when `content` is only a prefix.
	 */
	recordFileRead(absolutePath: string, content: string, mtimeMs: number, contentComplete = true): TrackedFileState {
		const key = this.normalizeKey(absolutePath);
		const existing = this.files.get(key);
		const state: TrackedFileState = {
			absolutePath: normalize(resolve(absolutePath)),
			lastReadMtimeMs: mtimeMs,
			content,
			contentComplete,
			modifiedByAgent: existing?.modifiedByAgent ?? false,
			baselineCounts: existing?.baselineCounts ?? new Map<string, number>(),
		};
		this.files.set(key, state);

		if (contentComplete && isCppOrHipSource(absolutePath)) {
			this.lastActiveCppHipSource = state.absolutePath;
			this.indexLocalIncludes(state.absolutePath, content);
		}
		return state;
	}

	/**
	 * Update the file's content and mtime after a successful edit/write by the agent.
	 * `newContent` must be exactly what was written to disk. The diagnostics collected for the new
	 * content become the baseline for the next change (see `BaselineUpdateMode`).
	 */
	recordFileModifiedByAgent(
		absolutePath: string,
		newContent: string,
		newMtimeMs: number,
		currentDiagnostics?: HarnessDiagnostic[],
		baselineMode: BaselineUpdateMode = "replace",
	): void {
		const key = this.normalizeKey(absolutePath);
		const existing = this.files.get(key);
		const normalizedPath = normalize(resolve(absolutePath));
		this.files.set(key, {
			absolutePath: normalizedPath,
			lastReadMtimeMs: newMtimeMs,
			content: newContent,
			contentComplete: true,
			modifiedByAgent: true,
			baselineCounts: existing ? new Map(existing.baselineCounts) : new Map<string, number>(),
		});
		if (currentDiagnostics) {
			this.updateBaselineDiagnostics(absolutePath, currentDiagnostics, baselineMode);
		}

		if (isCppOrHipSource(normalizedPath)) {
			this.lastActiveCppHipSource = normalizedPath;
			this.indexLocalIncludes(normalizedPath, newContent);
		}
	}

	/**
	 * Store baseline diagnostics (captured during warmup on `read`, or the settled result of an edit).
	 */
	setBaselineDiagnostics(absolutePath: string, diagnostics: HarnessDiagnostic[]): void {
		this.updateBaselineDiagnostics(absolutePath, diagnostics, "replace");
	}

	/**
	 * Replace the baseline with `diagnostics`, or merge them in (keeping the higher count per
	 * fingerprint) when they may be an incomplete set.
	 */
	updateBaselineDiagnostics(absolutePath: string, diagnostics: HarnessDiagnostic[], mode: BaselineUpdateMode): void {
		const state = this.files.get(this.normalizeKey(absolutePath));
		if (!state) return;
		const counts = countFingerprints(diagnostics);
		if (mode === "replace") {
			state.baselineCounts = counts;
			return;
		}
		for (const [fp, count] of counts) {
			if ((state.baselineCounts.get(fp) ?? 0) < count) state.baselineCounts.set(fp, count);
		}
	}

	/**
	 * Filter a list of diagnostics to only those NOT present in the baseline. Fingerprints are
	 * line-independent, so occurrences are counted: a second identical diagnostic is still new.
	 */
	diffAgainstBaseline(absolutePath: string, diagnostics: HarnessDiagnostic[]): HarnessDiagnostic[] {
		const state = this.files.get(this.normalizeKey(absolutePath));
		const baseline = state?.baselineCounts;
		if (!baseline || baseline.size === 0) {
			return diagnostics;
		}
		const remaining = new Map(baseline);
		return diagnostics.filter((diag) => {
			const fp = diagnosticFingerprint(diag);
			const count = remaining.get(fp) ?? 0;
			if (count === 0) return true;
			remaining.set(fp, count - 1);
			return false;
		});
	}

	hasBeenRead(absolutePath: string): boolean {
		return this.files.has(this.normalizeKey(absolutePath));
	}

	getTrackedState(absolutePath: string): TrackedFileState | undefined {
		return this.files.get(this.normalizeKey(absolutePath));
	}

	/**
	 * If a header (.h/.hpp/.cuh) is edited, find the best host source (.hip/.cpp) that includes it
	 * (or the most recently active source file in the session) so libclang can reparse it with full TU context.
	 */
	findHostSourceForHeader(headerAbsolutePath: string): string | undefined {
		const key = this.normalizeKey(headerAbsolutePath);
		return this.headerToHostSource.get(key) ?? this.lastActiveCppHipSource;
	}

	/**
	 * Return the headers the agent modified in this session for passing as CXUnsavedFile overlays.
	 * Headers that were only read are left out: their tracked text may be stale against the disk.
	 */
	getUnsavedHeaderOverlays(excludePath?: string): Array<{ filename: string; content: string }> {
		const excludeKey = excludePath ? this.normalizeKey(excludePath) : undefined;
		const overlays: Array<{ filename: string; content: string }> = [];
		for (const [key, state] of this.files.entries()) {
			if (key === excludeKey) continue;
			if (state.modifiedByAgent && state.contentComplete && isCppOrHipHeader(state.absolutePath)) {
				overlays.push({ filename: state.absolutePath, content: state.content });
			}
		}
		return overlays;
	}

	private indexLocalIncludes(sourceAbsolutePath: string, content: string): void {
		const sourceDir = dirname(sourceAbsolutePath);
		LOCAL_INCLUDE_REGEX.lastIndex = 0;
		for (let match = LOCAL_INCLUDE_REGEX.exec(content); match !== null; match = LOCAL_INCLUDE_REGEX.exec(content)) {
			const relInclude = match[1];
			if (!relInclude) continue;
			const resolvedHeader = resolve(sourceDir, relInclude);
			this.headerToHostSource.set(this.normalizeKey(resolvedHeader), sourceAbsolutePath);
		}
	}

	clear(): void {
		this.files.clear();
		this.headerToHostSource.clear();
		this.dirInstructionCache.clear();
		this.sentNestedInstructions.clear();
		this.lastActiveCppHipSource = undefined;
	}
}
