import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { getNativeAddonPath } from "../../../config.ts";
import { type FileStateTracker, pathKey } from "../../file-tracking/file-state.ts";
import type { Diagnostic } from "../checkers.ts";
import { CompileCommandsResolver } from "./compile-commands.ts";
import { isCppOrHipHeader } from "./files.ts";

interface NativeLibclangAddon {
	initLibclang(customPath?: string): boolean;
	checkFileAsync(
		filename: string,
		args: string[],
		unsavedFiles: Array<{ filename: string; content: string }>,
	): Promise<string>;
}

interface RawClangDiagnostic {
	line: number;
	column: number;
	severity: number;
	file: string;
	message: string;
	code?: string;
}

function tryLoadNativeLibclangAddon(): NativeLibclangAddon | null {
	const candidate = getNativeAddonPath("libclang", "libclang-bridge.node");
	if (!existsSync(candidate)) return null;
	try {
		const addon = createRequire(import.meta.url)(candidate) as NativeLibclangAddon;
		return typeof addon?.initLibclang === "function" && addon.initLibclang() ? addon : null;
	} catch {
		return null;
	}
}

/** The folders `-I`, `-iquote` and `-isystem` name in compiler flags, absolute (relative ones from the working directory). */
function includeDirs(flags: string[], baseDir: string): string[] {
	const workingDir = flags.find((a) => a.startsWith("-working-directory="))?.slice("-working-directory=".length);
	const base = workingDir ? resolve(baseDir, workingDir) : baseDir;
	const dirs: string[] = [];
	for (let i = 0; i < flags.length; i++) {
		for (const flag of ["-I", "-iquote", "-isystem"]) {
			if (flags[i] === flag && i + 1 < flags.length) dirs.push(resolve(base, flags[++i]));
			else if (flags[i].startsWith(flag) && flags[i].length > flag.length)
				dirs.push(resolve(base, flags[i].slice(flag.length)));
			else continue;
			break;
		}
	}
	return dirs;
}

export class LibclangEngine {
	private nativeAddon: NativeLibclangAddon | null | undefined = undefined;
	private readonly compileCommands = new CompileCommandsResolver();
	private readonly stateTracker: FileStateTracker;

	constructor(stateTracker: FileStateTracker) {
		this.stateTracker = stateTracker;
	}

	private getAddon(): NativeLibclangAddon | null {
		if (this.nativeAddon === undefined) {
			this.nativeAddon = tryLoadNativeLibclangAddon();
		}
		return this.nativeAddon;
	}

	/** Whether the libclang bridge loaded: without it there are no C, C++ and HIP diagnostics. */
	available(): boolean {
		return this.getAddon() !== null;
	}

	/**
	 * Headers are parsed inside a source that includes them when one was read completely, so they get its flags and
	 * preceding declarations: one that includes it relative to its own folder, else through one of its -I folders.
	 * Otherwise the header is parsed on its own, with the flags of a source near it.
	 */
	private resolveTranslationUnit(resolvedTarget: string, workspaceCwd: string): string {
		if (!isCppOrHipHeader(resolvedTarget)) return resolvedTarget;
		const complete = (source: string | undefined) =>
			source && this.stateTracker.getTrackedState(source)?.contentComplete ? source : undefined;
		const direct = complete(this.stateTracker.findHostSourceForHeader(resolvedTarget));
		if (direct) return direct;
		const targetKey = pathKey(resolvedTarget);
		for (const { source, include } of this.stateTracker.findSourcesIncludingByPath(resolvedTarget)) {
			const content = complete(source) && this.stateTracker.getTrackedState(source)?.content;
			if (!content) continue;
			const flags = this.compileCommands.getFlagsForFile(source, workspaceCwd, content);
			if (includeDirs(flags, dirname(source)).some((dir) => pathKey(join(dir, include)) === targetKey)) {
				return source;
			}
		}
		return resolvedTarget;
	}

	/**
	 * The diagnostics of `absolutePath` with `content`, through libclang. A header is parsed inside its host translation
	 * unit with its text as an unsaved file; the other headers the agent changed come along the same way. Throws when the
	 * parse fails, so a background check keeps its baseline.
	 */
	async check(absolutePath: string, content: string, workspaceCwd: string): Promise<Diagnostic[]> {
		const addon = this.getAddon();
		if (!addon) throw new Error("The libclang bridge is not available");
		const resolvedTarget = resolve(workspaceCwd, absolutePath);
		const targetKey = pathKey(resolvedTarget);
		const tuFilePath = this.resolveTranslationUnit(resolvedTarget, workspaceCwd);
		const tuKey = pathKey(tuFilePath);
		const unsavedFiles = [
			{ filename: resolvedTarget, content },
			...this.stateTracker.getUnsavedHeaderOverlays(resolvedTarget),
		];
		// Always the flags (resolved once and cached): the bridge reparses a TU kept with the same flags, and parses it
		// again when they changed (compile_commands.json) or a reparse failed.
		const tuContent = tuKey === targetKey ? content : this.stateTracker.getTrackedState(tuFilePath)?.content;
		const flags = this.compileCommands.getFlagsForFile(tuFilePath, workspaceCwd, tuContent);
		const rawDiags = JSON.parse(await addon.checkFileAsync(tuFilePath, flags, unsavedFiles)) as RawClangDiagnostic[];
		const diagnostics = this.filterRelevantDiagnostics(rawDiags, targetKey);
		// A header that is not found makes every use of what it declares an error: only the missing header counts, as
		// the compiler with the project's own flags may well find it.
		const missing = diagnostics.filter((d) => / file not found$/.test(d.message));
		return missing.length > 0 ? missing : diagnostics;
	}

	/**
	 * Keep only diagnostics located in the target file. For a header parsed inside its host TU,
	 * diagnostics in the host source refer to the host's lines and belong to the host's own baseline.
	 */
	private filterRelevantDiagnostics(rawDiags: RawClangDiagnostic[], targetKey: string): Diagnostic[] {
		const results: Diagnostic[] = [];
		for (const d of rawDiags) {
			const diagFileKey = d.file ? pathKey(d.file) : targetKey;
			if (diagFileKey !== targetKey) {
				continue;
			}
			results.push({
				file: d.file || targetKey,
				line: d.line || 1,
				column: d.column || 1,
				severity: d.severity >= 3 ? "error" : "warning",
				message: d.message,
				code: d.code || undefined,
			});
		}
		return results;
	}
}
