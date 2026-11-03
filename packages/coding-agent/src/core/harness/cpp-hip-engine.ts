import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CompileCommandsResolver } from "./compile-commands.ts";
import {
	type DiagnosticsResult,
	type FileStateTracker,
	type HarnessDiagnostic,
	isCppOrHipHeader,
} from "./file-state-tracker.ts";

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

/**
 * Fallback persistent stripped-down clangd client (--pch-storage=memory --background-index=false --clang-tidy=false)
 * used only when the native libclang-bridge.node addon is not yet built on the host.
 */
class StrippedClangdFallback {
	private proc: ChildProcessWithoutNullStreams | null = null;
	private failedToStart = false;
	private nextId = 1;
	private buffer: Buffer = Buffer.alloc(0);
	private docVersions = new Map<string, number>();
	private latestDiagnostics = new Map<string, HarnessDiagnostic[]>();
	private waiters = new Map<string, Array<(diags: HarnessDiagnostic[]) => void>>();

	async updateFile(
		absolutePath: string,
		content: string,
		workspaceCwd: string,
		timeoutMs = 350,
	): Promise<DiagnosticsResult> {
		if (this.failedToStart) return { diagnostics: [], complete: false };
		if (!this.proc) {
			this.start(workspaceCwd);
			if (this.failedToStart || !this.proc) return { diagnostics: [], complete: false };
		}

		const uri = pathToFileURL(resolve(absolutePath)).href;
		const key = normalizeFileCompare(absolutePath);
		const prevVersion = this.docVersions.get(key);

		const diagPromise = new Promise<DiagnosticsResult>((resolveWait) => {
			const timer = setTimeout(() => {
				const list = this.waiters.get(key);
				if (list) {
					const idx = list.indexOf(onDiags);
					if (idx !== -1) list.splice(idx, 1);
				}
				// No push for this version within the budget: whatever is cached may be stale.
				resolveWait({ diagnostics: this.latestDiagnostics.get(key) ?? [], complete: false });
			}, timeoutMs);

			const onDiags = (diags: HarnessDiagnostic[]) => {
				clearTimeout(timer);
				resolveWait({ diagnostics: diags, complete: true });
			};

			const list = this.waiters.get(key) ?? [];
			list.push(onDiags);
			this.waiters.set(key, list);
		});

		if (prevVersion === undefined) {
			this.docVersions.set(key, 1);
			this.sendNotification("textDocument/didOpen", {
				textDocument: {
					uri,
					languageId: absolutePath.endsWith(".hip") || absolutePath.endsWith(".cuh") ? "hip" : "cpp",
					version: 1,
					text: content,
				},
			});
		} else {
			const nextVersion = prevVersion + 1;
			this.docVersions.set(key, nextVersion);
			this.sendNotification("textDocument/didChange", {
				textDocument: { uri, version: nextVersion },
				contentChanges: [{ text: content }],
			});
		}

		return diagPromise;
	}

	private start(workspaceCwd: string): void {
		const clangdBin =
			process.env.CLANGD_PATH || (existsSync("/opt/rocm/llvm/bin/clangd") ? "/opt/rocm/llvm/bin/clangd" : "clangd");
		const clangdArgs = [
			"--pch-storage=memory",
			"--background-index=false",
			"--clang-tidy=false",
			"--completion-style=bundled",
			"--header-insertion=never",
			"--limit-results=1",
			"--log=error",
		];
		const isScript = clangdBin.endsWith(".js") || clangdBin.endsWith(".mjs");
		try {
			this.proc = isScript
				? spawn(process.execPath, [clangdBin, ...clangdArgs], { cwd: workspaceCwd, stdio: "pipe" })
				: spawn(clangdBin, clangdArgs, { cwd: workspaceCwd, stdio: "pipe" });
		} catch {
			this.failedToStart = true;
			return;
		}

		const proc = this.proc;
		proc.on("error", () => {
			this.failedToStart = true;
			if (this.proc === proc) this.proc = null;
		});
		proc.on("exit", () => {
			if (this.proc === proc) this.proc = null;
		});
		// Drain stderr so a chatty server never blocks on a full pipe; ignore EPIPE after exit.
		proc.stderr.resume();
		proc.stdin.on("error", () => {});
		proc.stdout.on("data", (chunk: Buffer) => this.onData(chunk));

		const rootUri = pathToFileURL(resolve(workspaceCwd)).href;
		this.sendRequest("initialize", {
			processId: process.pid,
			rootUri,
			capabilities: {
				textDocument: {
					publishDiagnostics: { relatedInformation: false },
				},
			},
		});
		this.sendNotification("initialized", {});
	}

	private sendRequest(method: string, params: unknown): void {
		this.writeMessage({ jsonrpc: "2.0", id: this.nextId++, method, params });
	}

	private sendNotification(method: string, params: unknown): void {
		this.writeMessage({ jsonrpc: "2.0", method, params });
	}

	dispose(): void {
		if (this.proc) {
			try {
				this.proc.kill();
			} catch {}
			this.proc = null;
		}
		this.docVersions.clear();
	}

	private writeMessage(msg: unknown): void {
		if (!this.proc || !this.proc.stdin.writable) return;
		const json = JSON.stringify(msg);
		const byteLen = Buffer.byteLength(json, "utf-8");
		this.proc.stdin.write(`Content-Length: ${byteLen}\r\n\r\n${json}`, "utf-8");
	}

	private onData(chunk: Buffer): void {
		this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
		while (this.buffer.length > 0) {
			const headerEnd = this.buffer.indexOf("\r\n\r\n");
			if (headerEnd === -1) break;
			const headerText = this.buffer.subarray(0, headerEnd).toString("ascii");
			const match = /Content-Length:\s*(\d+)/i.exec(headerText);
			if (!match) {
				this.buffer = this.buffer.subarray(headerEnd + 4);
				continue;
			}
			const contentLength = Number.parseInt(match[1], 10);
			const totalLength = headerEnd + 4 + contentLength;
			if (this.buffer.length < totalLength) break;
			const jsonBytes = this.buffer.subarray(headerEnd + 4, totalLength);
			this.buffer = this.buffer.subarray(totalLength);
			try {
				const msg = JSON.parse(jsonBytes.toString("utf-8"));
				if (msg.method === "textDocument/publishDiagnostics" && msg.params?.uri) {
					const filePath = fileURLToPath(msg.params.uri);
					const key = normalizeFileCompare(filePath);
					const diags: HarnessDiagnostic[] = [];
					for (const d of msg.params.diagnostics ?? []) {
						if (d.severity === 1 || d.severity === 2) {
							diags.push({
								file: filePath,
								line: (d.range?.start?.line ?? 0) + 1,
								column: (d.range?.start?.character ?? 0) + 1,
								severity: d.severity === 1 ? "error" : "warning",
								message: String(d.message ?? "").split("\n")[0],
								code: d.code ? String(d.code) : undefined,
							});
						}
					}
					this.latestDiagnostics.set(key, diags);
					const list = this.waiters.get(key);
					if (list && list.length > 0) {
						this.waiters.delete(key);
						for (const fn of list) fn(diags);
					}
				}
			} catch {
				// Ignore malformed JSON-RPC packets
			}
		}
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

export class CppHipDiagnosticsEngine {
	private nativeAddon: NativeLibclangAddon | null | undefined = undefined;
	private readonly compileCommands = new CompileCommandsResolver();
	private readonly clangdFallback = new StrippedClangdFallback();
	private readonly inflightWarmups = new Map<string, Promise<DiagnosticsResult>>();
	/** Target file -> translation unit its baseline diagnostics were collected from. */
	private readonly baselineTuByFile = new Map<string, string>();
	private readonly stateTracker: FileStateTracker;

	constructor(stateTracker: FileStateTracker) {
		this.stateTracker = stateTracker;
	}

	dispose(): void {
		this.clangdFallback.dispose();
	}

	private getAddon(): NativeLibclangAddon | null {
		if (this.nativeAddon === undefined) {
			this.nativeAddon = tryLoadNativeLibclangAddon();
		}
		return this.nativeAddon;
	}

	/**
	 * Pre-warm the translation unit (and its precompiled preamble in RAM) when a file is read.
	 */
	warmupFile(absolutePath: string, content: string, workspaceCwd: string): Promise<DiagnosticsResult> {
		const key = normalizeFileCompare(absolutePath);
		const existing = this.inflightWarmups.get(key);
		if (existing) return existing;

		const promise = this.checkFileInternal(absolutePath, content, workspaceCwd, true).finally(() => {
			this.inflightWarmups.delete(key);
		});
		this.inflightWarmups.set(key, promise);
		return promise;
	}

	/**
	 * Reparse the file in-memory after an edit/write using the pre-warmed preamble.
	 */
	async checkEditedFile(absolutePath: string, newContent: string, workspaceCwd: string): Promise<DiagnosticsResult> {
		const key = normalizeFileCompare(absolutePath);
		const pendingWarmup = this.inflightWarmups.get(key);
		if (pendingWarmup) {
			try {
				await pendingWarmup;
			} catch {
				// Ignore warmup error and proceed with reparse
			}
		}

		// A header's baseline may come from parsing it standalone while the edit now parses it inside
		// its host TU (or the other way round). Diagnostics from different TUs are not comparable, so
		// re-collect the baseline from the pre-edit text in the TU the edit will use.
		const resolvedTarget = resolve(workspaceCwd, absolutePath);
		const targetKey = normalizeFileCompare(resolvedTarget);
		const tuFilePath = this.resolveTranslationUnit(resolvedTarget, workspaceCwd);
		const tuKey = normalizeFileCompare(tuFilePath);
		const previous = this.stateTracker.getTrackedState(resolvedTarget);
		if (this.baselineTuByFile.get(targetKey) !== tuKey && previous?.contentComplete) {
			const baseline = await this.checkFileInternal(resolvedTarget, previous.content, workspaceCwd, true);
			this.stateTracker.updateBaselineDiagnostics(
				resolvedTarget,
				baseline.diagnostics,
				baseline.complete ? "replace" : "merge",
			);
		}
		return this.checkFileInternal(resolvedTarget, newContent, workspaceCwd, false);
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

	private async checkFileInternal(
		absolutePath: string,
		content: string,
		workspaceCwd: string,
		isWarmup: boolean,
	): Promise<DiagnosticsResult> {
		const resolvedTarget = resolve(workspaceCwd, absolutePath);
		const targetKey = normalizeFileCompare(resolvedTarget);

		// If the file is a header (.h/.hpp/.cuh) included by a known host .hip/.cpp TU, parse the host
		// TU with the header's text injected as a CXUnsavedFile overlay.
		const tuFilePath = this.resolveTranslationUnit(resolvedTarget, workspaceCwd);
		const tuKey = normalizeFileCompare(tuFilePath);
		const unsavedFiles: Array<{ filename: string; content: string }> = [{ filename: resolvedTarget, content }];

		// Also include the other headers the agent modified in this session
		for (const overlay of this.stateTracker.getUnsavedHeaderOverlays(resolvedTarget)) {
			unsavedFiles.push(overlay);
		}

		if (isWarmup) {
			this.baselineTuByFile.set(targetKey, tuKey);
		}

		const addon = this.getAddon();
		if (addon) {
			try {
				// Always the flags (resolved once and cached): the bridge reparses a TU kept with the same flags, and parses
				// it again when they changed (compile_commands.json) or a reparse failed.
				const tuContent = tuKey === targetKey ? content : this.stateTracker.getTrackedState(tuFilePath)?.content;
				const flags = this.compileCommands.getFlagsForFile(tuFilePath, workspaceCwd, tuContent);
				const jsonStr = await addon.checkFileAsync(tuFilePath, flags, unsavedFiles);
				const rawDiags = JSON.parse(jsonStr) as RawClangDiagnostic[];
				return { diagnostics: this.filterRelevantDiagnostics(rawDiags, targetKey), complete: true };
			} catch {
				// Fallback if native call failed
			}
		}

		// clangd parses each open file in its own context, so the baseline TU is the file itself.
		this.baselineTuByFile.set(targetKey, targetKey);
		return this.clangdFallback.updateFile(resolvedTarget, content, workspaceCwd, isWarmup ? 1500 : 350);
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
