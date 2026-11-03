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
	content: string;
	baselineFingerprints: Set<string>;
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

const LOCAL_INCLUDE_REGEX = /^\s*#\s*include\s*"([^"]+)"/gm;

export class FileStateTracker {
	private readonly files = new Map<string, TrackedFileState>();
	private readonly headerToHostSource = new Map<string, string>();
	private lastActiveCppHipSource: string | undefined;

	private normalizeKey(filePath: string): string {
		const norm = normalize(resolve(filePath));
		return process.platform === "win32" ? norm.toLowerCase() : norm;
	}

	/**
	 * Record that a file was read (or updated by edit/write).
	 */
	recordFileRead(absolutePath: string, content: string, mtimeMs: number): TrackedFileState {
		const key = this.normalizeKey(absolutePath);
		const existing = this.files.get(key);
		const state: TrackedFileState = {
			absolutePath: normalize(resolve(absolutePath)),
			lastReadMtimeMs: mtimeMs,
			content,
			baselineFingerprints: existing?.baselineFingerprints ?? new Set<string>(),
		};
		this.files.set(key, state);

		if (isCppOrHipSource(absolutePath)) {
			this.lastActiveCppHipSource = state.absolutePath;
			this.indexLocalIncludes(state.absolutePath, content);
		}
		return state;
	}

	/**
	 * Update the file's content and mtime after a successful edit/write by the agent.
	 */
	recordFileModifiedByAgent(
		absolutePath: string,
		newContent: string,
		newMtimeMs: number,
		currentDiagnostics?: HarnessDiagnostic[],
	): void {
		const key = this.normalizeKey(absolutePath);
		const existing = this.files.get(key);
		const baselineFingerprints = existing ? new Set(existing.baselineFingerprints) : new Set<string>();
		if (currentDiagnostics) {
			for (const diag of currentDiagnostics) {
				baselineFingerprints.add(diagnosticFingerprint(diag));
			}
		}
		const normalizedPath = normalize(resolve(absolutePath));
		this.files.set(key, {
			absolutePath: normalizedPath,
			lastReadMtimeMs: newMtimeMs,
			content: newContent,
			baselineFingerprints,
		});

		if (isCppOrHipSource(normalizedPath)) {
			this.lastActiveCppHipSource = normalizedPath;
			this.indexLocalIncludes(normalizedPath, newContent);
		}
	}

	/**
	 * Store baseline diagnostics captured during initial warmup on `read`.
	 */
	setBaselineDiagnostics(absolutePath: string, diagnostics: HarnessDiagnostic[]): void {
		const key = this.normalizeKey(absolutePath);
		const state = this.files.get(key);
		if (!state) return;
		state.baselineFingerprints.clear();
		for (const diag of diagnostics) {
			state.baselineFingerprints.add(diagnosticFingerprint(diag));
		}
	}

	/**
	 * Filter a list of diagnostics to only those NOT present in the baseline.
	 */
	diffAgainstBaseline(absolutePath: string, diagnostics: HarnessDiagnostic[]): HarnessDiagnostic[] {
		const key = this.normalizeKey(absolutePath);
		const state = this.files.get(key);
		const baseline = state?.baselineFingerprints;
		if (!baseline || baseline.size === 0) {
			return diagnostics;
		}
		return diagnostics.filter((diag) => !baseline.has(diagnosticFingerprint(diag)));
	}

	/**
	 * Verify that an existing file was previously read in this session and has not been modified
	 * externally since the last read/edit.
	 */
	assertCanModifyExistingFile(absolutePath: string, currentMtimeMs: number | undefined): void {
		const key = this.normalizeKey(absolutePath);
		const state = this.files.get(key);
		if (!state) {
			throw new Error("File has not been read yet. Read it first before writing to it.");
		}
		// Allow a 10ms tolerance for filesystem timestamp quantization across platforms
		if (currentMtimeMs !== undefined && currentMtimeMs > state.lastReadMtimeMs + 10) {
			throw new Error(
				"File has been modified since it was last read (either by the user or an external tool). Read the file again before editing it.",
			);
		}
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
	 * Return all currently tracked modified headers/files for passing as CXUnsavedFile overlays.
	 */
	getUnsavedHeaderOverlays(excludePath?: string): Array<{ filename: string; content: string }> {
		const excludeKey = excludePath ? this.normalizeKey(excludePath) : undefined;
		const overlays: Array<{ filename: string; content: string }> = [];
		for (const [key, state] of this.files.entries()) {
			if (key === excludeKey) continue;
			if (isCppOrHipHeader(state.absolutePath)) {
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
		this.lastActiveCppHipSource = undefined;
	}
}
