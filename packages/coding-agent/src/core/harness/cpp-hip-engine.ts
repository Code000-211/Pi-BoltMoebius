import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CompileCommandsResolver } from "./compile-commands.ts";
import { type FileStateTracker, type HarnessDiagnostic, isCppOrHipHeader } from "./file-state-tracker.ts";

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

const moduleRequire = createRequire(import.meta.url);

function normalizeFileCompare(p: string): string {
	const norm = normalize(resolve(p));
	return process.platform === "win32" ? norm.toLowerCase() : norm;
}

function tryLoadNativeLibclangAddon(): NativeLibclangAddon | null {
	const platformArch = `${process.platform}-${process.arch}`;
	const currentDir = dirname(fileURLToPath(import.meta.url));
	const candidates = [
		join(currentDir, "..", "..", "..", "native", "libclang", "prebuilds", platformArch, "libclang-bridge.node"),
		join(dirname(process.execPath), "native", "libclang", "prebuilds", platformArch, "libclang-bridge.node"),
		join(dirname(process.execPath), "libclang-bridge.node"),
	];

	for (const candidate of candidates) {
		if (!existsSync(candidate)) continue;
		try {
			const addon = moduleRequire(candidate) as NativeLibclangAddon;
			if (addon && typeof addon.initLibclang === "function" && addon.initLibclang()) {
				return addon;
			}
		} catch {
			// Ignore and try next candidate or fallback
		}
	}
	return null;
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

export class CppHipDiagnosticsEngine {
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
		const targetKey = normalizeFileCompare(resolvedTarget);
		for (const { source, include } of this.stateTracker.findSourcesIncludingByPath(resolvedTarget)) {
			const content = complete(source) && this.stateTracker.getTrackedState(source)?.content;
			if (!content) continue;
			const flags = this.compileCommands.getFlagsForFile(source, workspaceCwd, content);
			if (
				includeDirs(flags, dirname(source)).some((dir) => normalizeFileCompare(join(dir, include)) === targetKey)
			) {
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
	async check(absolutePath: string, content: string, workspaceCwd: string): Promise<HarnessDiagnostic[]> {
		const addon = this.getAddon();
		if (!addon) throw new Error("The libclang bridge is not available");
		const resolvedTarget = resolve(workspaceCwd, absolutePath);
		const targetKey = normalizeFileCompare(resolvedTarget);
		const tuFilePath = this.resolveTranslationUnit(resolvedTarget, workspaceCwd);
		const tuKey = normalizeFileCompare(tuFilePath);
		const unsavedFiles = [
			{ filename: resolvedTarget, content },
			...this.stateTracker.getUnsavedHeaderOverlays(resolvedTarget),
		];
		// Always the flags (resolved once and cached): the bridge reparses a TU kept with the same flags, and parses it
		// again when they changed (compile_commands.json) or a reparse failed.
		const tuContent = tuKey === targetKey ? content : this.stateTracker.getTrackedState(tuFilePath)?.content;
		const flags = this.compileCommands.getFlagsForFile(tuFilePath, workspaceCwd, tuContent);
		const rawDiags = JSON.parse(await addon.checkFileAsync(tuFilePath, flags, unsavedFiles)) as RawClangDiagnostic[];
		return this.filterRelevantDiagnostics(rawDiags, targetKey);
	}

	/**
	 * Keep only diagnostics located in the target file. For a header parsed inside its host TU,
	 * diagnostics in the host source refer to the host's lines and belong to the host's own baseline.
	 */
	private filterRelevantDiagnostics(rawDiags: RawClangDiagnostic[], targetKey: string): HarnessDiagnostic[] {
		const results: HarnessDiagnostic[] = [];
		for (const d of rawDiags) {
			const diagFileKey = d.file ? normalizeFileCompare(d.file) : targetKey;
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
