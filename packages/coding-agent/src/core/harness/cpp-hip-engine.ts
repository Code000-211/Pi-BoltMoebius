import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
	): Promise<HarnessDiagnostic[]> {
		if (this.failedToStart) return [];
		if (!this.proc) {
			this.start(workspaceCwd);
			if (this.failedToStart || !this.proc) return [];
		}

		const uri = pathToFileURL(resolve(absolutePath)).href;
		const key = normalizeFileCompare(absolutePath);
		const prevVersion = this.docVersions.get(key);

		const diagPromise = new Promise<HarnessDiagnostic[]>((resolveWait) => {
			const timer = setTimeout(() => {
				const list = this.waiters.get(key);
				if (list) {
					const idx = list.indexOf(onDiags);
					if (idx !== -1) list.splice(idx, 1);
				}
				resolveWait(this.latestDiagnostics.get(key) ?? []);
			}, timeoutMs);

			const onDiags = (diags: HarnessDiagnostic[]) => {
				clearTimeout(timer);
				resolveWait(diags);
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

		this.proc.on("error", () => {
			this.failedToStart = true;
			this.proc = null;
		});
		this.proc.on("exit", () => {
			this.proc = null;
		});
		this.proc.stdout.on("data", (chunk: Buffer) => this.onData(chunk));

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

const EMPTY_FLAGS: string[] = [];

export class CppHipDiagnosticsEngine {
	private nativeAddon: NativeLibclangAddon | null | undefined = undefined;
	private readonly compileCommands = new CompileCommandsResolver();
	private readonly clangdFallback = new StrippedClangdFallback();
	private readonly inflightWarmups = new Map<string, Promise<HarnessDiagnostic[]>>();
	private readonly warmedUpTuKeys = new Set<string>();
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
	warmupFile(absolutePath: string, content: string, workspaceCwd: string): Promise<HarnessDiagnostic[]> {
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
	async checkEditedFile(absolutePath: string, newContent: string, workspaceCwd: string): Promise<HarnessDiagnostic[]> {
		const key = normalizeFileCompare(absolutePath);
		const pendingWarmup = this.inflightWarmups.get(key);
		if (pendingWarmup) {
			try {
				await pendingWarmup;
			} catch {
				// Ignore warmup error and proceed with reparse
			}
		}
		return this.checkFileInternal(absolutePath, newContent, workspaceCwd, false);
	}

	private async checkFileInternal(
		absolutePath: string,
		content: string,
		workspaceCwd: string,
		isWarmup: boolean,
	): Promise<HarnessDiagnostic[]> {
		const resolvedTarget = resolve(workspaceCwd, absolutePath);
		const targetKey = normalizeFileCompare(resolvedTarget);

		// If editing a header (.h/.hpp/.cuh) and we have an active host .hip/.cpp TU that includes it,
		// reparse the host TU with the modified header injected as a CXUnsavedFile overlay!
		let tuFilePath = resolvedTarget;
		const unsavedFiles: Array<{ filename: string; content: string }> = [{ filename: resolvedTarget, content }];

		if (!isWarmup && isCppOrHipHeader(resolvedTarget)) {
			const hostSource = this.stateTracker.findHostSourceForHeader(resolvedTarget);
			if (hostSource) {
				const hostState = this.stateTracker.getTrackedState(hostSource);
				if (hostState) {
					tuFilePath = hostSource;
					unsavedFiles.push({ filename: hostSource, content: hostState.content });
				}
			}
		}

		// Also include any other modified headers tracked in the session
		for (const overlay of this.stateTracker.getUnsavedHeaderOverlays(resolvedTarget)) {
			unsavedFiles.push(overlay);
		}

		const addon = this.getAddon();
		if (addon) {
			try {
				const tuKey = normalizeFileCompare(tuFilePath);
				// When TU is already warm in libclang's hash table, clang_reparseTranslationUnit ignores argv,
				// so skip resolving & marshaling compiler flags across the N-API boundary!
				const flags = this.warmedUpTuKeys.has(tuKey)
					? EMPTY_FLAGS
					: this.compileCommands.getFlagsForFile(tuFilePath, workspaceCwd, content);
				const jsonStr = await addon.checkFileAsync(tuFilePath, flags, unsavedFiles);
				this.warmedUpTuKeys.add(tuKey);
				const rawDiags = JSON.parse(jsonStr) as RawClangDiagnostic[];
				return this.filterRelevantDiagnostics(rawDiags, targetKey, tuKey);
			} catch {
				// Fallback if native call failed
			}
		}

		return this.clangdFallback.updateFile(resolvedTarget, content, workspaceCwd, isWarmup ? 1500 : 350);
	}

	private filterRelevantDiagnostics(
		rawDiags: RawClangDiagnostic[],
		targetKey: string,
		tuKey: string,
	): HarnessDiagnostic[] {
		const results: HarnessDiagnostic[] = [];
		for (const d of rawDiags) {
			const diagFileKey = d.file ? normalizeFileCompare(d.file) : targetKey;
			if (diagFileKey !== targetKey && diagFileKey !== tuKey) {
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
