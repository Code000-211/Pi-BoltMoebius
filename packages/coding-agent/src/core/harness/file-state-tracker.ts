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
}

const CPP_HIP_SOURCE_EXTENSIONS = new Set([".cpp", ".cc", ".cxx", ".c", ".cu", ".hip"]);
const CPP_HIP_HEADER_EXTENSIONS = new Set([".h", ".hh", ".hpp", ".hxx", ".cuh", ".hiph"]);

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
	/** `#include "..."` text (with `/`) -> the sources that include it that way, for headers found through -I folders. */
	private readonly includeTextToSources = new Map<string, Set<string>>();
	private readonly dirInstructionCache = new Map<string, { path: string; content: string } | null>();
	private readonly sentNestedInstructions = new Set<string>();

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
		};
		this.files.set(key, state);

		if (contentComplete && isCppOrHipSource(absolutePath)) {
			this.indexLocalIncludes(state.absolutePath, content);
		}
		return state;
	}

	/**
	 * Update the file's content and mtime after a successful edit/write by the agent.
	 * `newContent` must be exactly what was written to disk.
	 */
	recordFileModifiedByAgent(absolutePath: string, newContent: string, newMtimeMs: number): void {
		const normalizedPath = normalize(resolve(absolutePath));
		this.files.set(this.normalizeKey(absolutePath), {
			absolutePath: normalizedPath,
			lastReadMtimeMs: newMtimeMs,
			content: newContent,
			contentComplete: true,
			modifiedByAgent: true,
		});

		if (isCppOrHipSource(normalizedPath)) {
			this.indexLocalIncludes(normalizedPath, newContent);
		}
	}

	hasBeenRead(absolutePath: string): boolean {
		return this.files.has(this.normalizeKey(absolutePath));
	}

	getTrackedState(absolutePath: string): TrackedFileState | undefined {
		return this.files.get(this.normalizeKey(absolutePath));
	}

	/**
	 * The source read in this session that includes a header (.h/.hpp/.cuh) by a path relative to its own folder, so
	 * libclang can reparse the header with the full TU context. A source that does not include the header would give it
	 * no diagnostics at all, so there is no fallback to another source here (see `findSourcesIncludingByPath`).
	 */
	findHostSourceForHeader(headerAbsolutePath: string): string | undefined {
		return this.headerToHostSource.get(this.normalizeKey(headerAbsolutePath));
	}

	/**
	 * The sources read in this session with an `#include "..."` whose text is a trailing part of the header's path
	 * (`kernels/gemm.h` for `/src/include/kernels/gemm.h`), longest first: candidates to check against their -I folders.
	 */
	findSourcesIncludingByPath(headerAbsolutePath: string): Array<{ source: string; include: string }> {
		const parts = normalize(resolve(headerAbsolutePath)).split(/[\\/]/);
		const found: Array<{ source: string; include: string }> = [];
		for (let k = Math.min(parts.length - 1, 6); k >= 1; k--) {
			const include = parts.slice(-k).join("/");
			const key = process.platform === "win32" ? include.toLowerCase() : include;
			for (const source of this.includeTextToSources.get(key) ?? []) found.push({ source, include });
		}
		return found;
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
			const text = relInclude.replace(/\\/g, "/").replace(/^(\.\/)+/, "");
			const textKey = process.platform === "win32" ? text.toLowerCase() : text;
			let sources = this.includeTextToSources.get(textKey);
			if (!sources) this.includeTextToSources.set(textKey, (sources = new Set()));
			sources.add(sourceAbsolutePath);
		}
	}
}
