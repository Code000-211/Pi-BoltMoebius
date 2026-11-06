import { dirname, normalize, resolve } from "node:path";
import { isCppOrHipHeader, isCppOrHipSource } from "../checks/cpp/files.ts";

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

/** A path as a key: absolute and normalized, and lower case where file names are not case-sensitive (Windows). */
export function pathKey(filePath: string): string {
	const norm = normalize(resolve(filePath));
	return process.platform === "win32" ? norm.toLowerCase() : norm;
}

/** Whether `mtimeMs` is newer than the file's when the agent last read or wrote it, with 10 ms for timestamp rounding. */
function changedSinceRead(state: TrackedFileState, mtimeMs: number): boolean {
	return mtimeMs > state.lastReadMtimeMs + 10;
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
		const key = pathKey(absolutePath);
		const state = this.files.get(key);
		if (!state) {
			throw new Error("File has not been read yet. Read it first before writing to it.");
		}
		const sameContent = currentContent !== undefined && state.contentComplete && currentContent === state.content;
		if (currentMtimeMs !== undefined && changedSinceRead(state, currentMtimeMs)) {
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
	 * Record that a file was read. Pass `contentComplete: false` when `content` is only a prefix.
	 */
	recordFileRead(absolutePath: string, content: string, mtimeMs: number, contentComplete = true): TrackedFileState {
		const key = pathKey(absolutePath);
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
		this.files.set(pathKey(absolutePath), {
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

	/**
	 * Whether `mtimeMs` is newer than when the agent last read or wrote the file, whose whole content it knows: the
	 * content then decides whether it changed (assertCanModifyExistingFile).
	 */
	needsContentCompare(absolutePath: string, mtimeMs: number): boolean {
		const state = this.files.get(pathKey(absolutePath));
		return state?.contentComplete === true && changedSinceRead(state, mtimeMs);
	}

	hasBeenRead(absolutePath: string): boolean {
		return this.files.has(pathKey(absolutePath));
	}

	getTrackedState(absolutePath: string): TrackedFileState | undefined {
		return this.files.get(pathKey(absolutePath));
	}

	/**
	 * The source read in this session that includes a header (.h/.hpp/.cuh) by a path relative to its own folder, so
	 * libclang can reparse the header with the full TU context. A source that does not include the header would give it
	 * no diagnostics at all, so there is no fallback to another source here (see `findSourcesIncludingByPath`).
	 */
	findHostSourceForHeader(headerAbsolutePath: string): string | undefined {
		return this.headerToHostSource.get(pathKey(headerAbsolutePath));
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
		const excludeKey = excludePath ? pathKey(excludePath) : undefined;
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
			this.headerToHostSource.set(pathKey(resolvedHeader), sourceAbsolutePath);
			const text = relInclude.replace(/\\/g, "/").replace(/^(\.\/)+/, "");
			const textKey = process.platform === "win32" ? text.toLowerCase() : text;
			const sources = this.includeTextToSources.get(textKey) ?? new Set<string>();
			sources.add(sourceAbsolutePath);
			this.includeTextToSources.set(textKey, sources);
		}
	}
}
