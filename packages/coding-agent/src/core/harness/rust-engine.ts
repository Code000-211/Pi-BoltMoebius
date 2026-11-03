import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { normalize, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { diagnosticFingerprint, type FileStateTracker, type HarnessDiagnostic } from "./file-state-tracker.ts";

const RUST_EDIT_WAIT_BUDGET_MS = 400;

function normalizeFileKey(p: string): string {
	const norm = normalize(resolve(p));
	return process.platform === "win32" ? norm.toLowerCase() : norm;
}

interface PendingWaiter {
	resolve: (diags: HarnessDiagnostic[]) => void;
	timer: ReturnType<typeof setTimeout>;
	receivedInitialPush: boolean;
}

export interface LateRustDiagnosticBatch {
	filePath: string;
	diagnostics: HarnessDiagnostic[];
}

export class RustDiagnosticsEngine {
	private proc: ChildProcessWithoutNullStreams | null = null;
	private failedToStart = false;
	private nextId = 1;
	private buffer: Buffer = Buffer.alloc(0);
	private docVersions = new Map<string, number>();
	private latestDiagnostics = new Map<string, HarnessDiagnostic[]>();
	private waiters = new Map<string, PendingWaiter[]>();
	private awaitingLateFlycheck = new Set<string>();
	private lateDiagnosticsQueue: LateRustDiagnosticBatch[] = [];
	private serverQuiescent = false;
	private inflightWarmups = new Map<string, Promise<HarnessDiagnostic[]>>();
	private readonly stateTracker: FileStateTracker;

	constructor(stateTracker: FileStateTracker) {
		this.stateTracker = stateTracker;
	}

	/**
	 * Pre-warm rust-analyzer when a .rs file is read (sends textDocument/didOpen).
	 */
	warmupFile(absolutePath: string, content: string, workspaceCwd: string): Promise<HarnessDiagnostic[]> {
		const key = normalizeFileKey(resolve(workspaceCwd, absolutePath));
		const existing = this.inflightWarmups.get(key);
		if (existing) return existing;

		const promise = this.updateDocument(absolutePath, content, workspaceCwd, false, 800).finally(() => {
			this.inflightWarmups.delete(key);
		});
		this.inflightWarmups.set(key, promise);
		return promise;
	}

	/**
	 * Two-tier check on edit/write:
	 * Sends didChange + didSave (triggers flycheck/borrow-checker), returns immediately if
	 * quiescent within 400ms, or returns fast in-memory diagnostics at 400ms and queues late
	 * borrow-checker diagnostics for the next turn's <system-reminder>.
	 */
	async checkEditedFile(
		absolutePath: string,
		newContent: string,
		workspaceCwd: string,
		budgetMs = RUST_EDIT_WAIT_BUDGET_MS,
	): Promise<HarnessDiagnostic[]> {
		const key = normalizeFileKey(resolve(workspaceCwd, absolutePath));
		const pendingWarmup = this.inflightWarmups.get(key);
		if (pendingWarmup) {
			try {
				await pendingWarmup;
			} catch {
				// Ignore warmup errors
			}
		}
		return this.updateDocument(absolutePath, newContent, workspaceCwd, true, budgetMs);
	}

	dispose(): void {
		for (const waiters of this.waiters.values()) {
			for (const w of waiters) clearTimeout(w.timer);
		}
		this.waiters.clear();
		if (this.proc) {
			try {
				this.proc.kill();
			} catch {}
			this.proc = null;
		}
	}

	/**
	 * Drain any late borrow-checker diagnostics that arrived after the 400ms edit budget.
	 */
	drainLateDiagnostics(): LateRustDiagnosticBatch[] {
		if (this.lateDiagnosticsQueue.length === 0) return [];
		return this.lateDiagnosticsQueue.splice(0, this.lateDiagnosticsQueue.length);
	}

	private updateDocument(
		absolutePath: string,
		content: string,
		workspaceCwd: string,
		triggerSave: boolean,
		timeoutMs: number,
	): Promise<HarnessDiagnostic[]> {
		if (this.failedToStart) return Promise.resolve([]);
		if (!this.proc) {
			this.start(workspaceCwd);
			if (this.failedToStart || !this.proc) return Promise.resolve([]);
		}

		const resolved = resolve(workspaceCwd, absolutePath);
		const uri = pathToFileURL(resolved).href;
		const key = normalizeFileKey(resolved);
		const prevVersion = this.docVersions.get(key);
		this.serverQuiescent = false;
		this.latestDiagnostics.delete(key);

		const promise = new Promise<HarnessDiagnostic[]>((resolveWait) => {
			const waiter: PendingWaiter = {
				receivedInitialPush: false,
				resolve: (diags) => {
					clearTimeout(waiter.timer);
					resolveWait(diags);
				},
				timer: setTimeout(() => {
					const list = this.waiters.get(key);
					if (list) {
						const idx = list.indexOf(waiter);
						if (idx !== -1) list.splice(idx, 1);
					}
					if (triggerSave) {
						// Timed out before diagnostics + quiescence completed; queue late diagnostics for next <system-reminder>
						this.awaitingLateFlycheck.add(key);
					}
					resolveWait(this.latestDiagnostics.get(key) ?? []);
				}, timeoutMs),
			};

			const list = this.waiters.get(key) ?? [];
			list.push(waiter);
			this.waiters.set(key, list);
		});

		if (prevVersion === undefined) {
			this.docVersions.set(key, 1);
			this.sendNotification("textDocument/didOpen", {
				textDocument: {
					uri,
					languageId: "rust",
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

		if (triggerSave) {
			this.sendNotification("textDocument/didSave", {
				textDocument: { uri },
				text: content,
			});
		}

		return promise;
	}

	private start(workspaceCwd: string): void {
		const bin = process.env.RUST_ANALYZER_PATH || "rust-analyzer";
		const isScript = bin.endsWith(".js") || bin.endsWith(".mjs");
		try {
			this.proc = isScript
				? spawn(process.execPath, [bin], { cwd: workspaceCwd, stdio: "pipe" })
				: spawn(bin, [], { cwd: workspaceCwd, stdio: "pipe" });
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
					synchronization: { didSave: true },
				},
				experimental: {
					serverStatusNotification: true,
				},
			},
			initializationOptions: {
				checkOnSave: true,
				check: {
					command: "check",
				},
				cargo: {
					buildScripts: { enable: false },
				},
				procMacro: { enable: true },
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
				if (msg.method === "experimental/serverStatus") {
					this.serverQuiescent = Boolean(msg.params?.quiescent);
					if (this.serverQuiescent) {
						this.flushAllWaiters();
					}
				} else if (msg.method === "textDocument/publishDiagnostics" && msg.params?.uri) {
					const filePath = fileURLToPath(msg.params.uri);
					const key = normalizeFileKey(filePath);
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

					const waiters = this.waiters.get(key);
					if (waiters && waiters.length > 0) {
						for (const w of waiters) w.receivedInitialPush = true;
						if (this.serverQuiescent || diags.some((d) => d.severity === "error")) {
							this.waiters.delete(key);
							for (const w of waiters) w.resolve(diags);
						}
					} else if (this.awaitingLateFlycheck.has(key)) {
						this.awaitingLateFlycheck.delete(key);
						const diffed = this.stateTracker.diffAgainstBaseline(filePath, diags);
						if (diffed.length > 0) {
							const state = this.stateTracker.getTrackedState(filePath);
							if (state) {
								for (const d of diffed) state.baselineFingerprints.add(diagnosticFingerprint(d));
							}
							this.lateDiagnosticsQueue.push({ filePath, diagnostics: diffed });
						}
					}
				}
			} catch {
				// Ignore malformed packets
			}
		}
	}

	private flushAllWaiters(): void {
		for (const [key, waiters] of this.waiters.entries()) {
			const ready = waiters.filter((w) => w.receivedInitialPush);
			if (ready.length === 0) continue;
			const diags = this.latestDiagnostics.get(key) ?? [];
			const remaining = waiters.filter((w) => !w.receivedInitialPush);
			if (remaining.length === 0) {
				this.waiters.delete(key);
			} else {
				this.waiters.set(key, remaining);
			}
			for (const w of ready) {
				w.resolve(diags);
			}
		}
	}
}
