import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { normalize, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DiagnosticsResult, FileStateTracker, HarnessDiagnostic } from "./file-state-tracker.ts";

const RUST_EDIT_WAIT_BUDGET_MS = 400;
const RUST_WARMUP_WAIT_BUDGET_MS = 800;
/**
 * After the server reports quiescence (or diagnostics stop arriving) wait this long before treating
 * a file's late diagnostics as settled, so a cargo flycheck that starts right after still counts.
 */
const LATE_SETTLE_GRACE_MS = 300;
/** Idle fallback when neither quiescence nor flycheck progress is reported by the server. */
const LATE_IDLE_FALLBACK_MS = 2000;

function normalizeFileKey(p: string): string {
	const norm = normalize(resolve(p));
	return process.platform === "win32" ? norm.toLowerCase() : norm;
}

interface PendingWaiter {
	resolve: (result: DiagnosticsResult) => void;
	timer: ReturnType<typeof setTimeout>;
	receivedInitialPush: boolean;
}

interface LateFlycheckState {
	filePath: string;
	receivedPush: boolean;
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
	/** Files edited by the agent whose post-save (cargo check) diagnostics have not settled yet. */
	private awaitingLateFlycheck = new Map<string, LateFlycheckState>();
	/** Files read but not yet edited: diagnostics pushed for them keep refreshing their baseline. */
	private baselinePending = new Set<string>();
	private activeFlycheckTokens = new Set<string>();
	private lateSettleTimer: ReturnType<typeof setTimeout> | undefined;
	private lateDiagnosticsQueue: LateRustDiagnosticBatch[] = [];
	private serverQuiescent = false;
	private flycheckPrimed = false;
	private inflightWarmups = new Map<string, Promise<DiagnosticsResult>>();
	private readonly stateTracker: FileStateTracker;

	constructor(stateTracker: FileStateTracker) {
		this.stateTracker = stateTracker;
	}

	/**
	 * Pre-warm rust-analyzer when a .rs file is read (sends textDocument/didOpen). The first warmup
	 * also saves once so cargo check runs and the baseline includes borrow-checker diagnostics.
	 */
	warmupFile(absolutePath: string, content: string, workspaceCwd: string): Promise<DiagnosticsResult> {
		const key = normalizeFileKey(resolve(workspaceCwd, absolutePath));
		const existing = this.inflightWarmups.get(key);
		if (existing) return existing;

		this.baselinePending.add(key);
		const triggerSave = !this.flycheckPrimed;
		this.flycheckPrimed = true;
		const promise = this.updateDocument(
			absolutePath,
			content,
			workspaceCwd,
			triggerSave,
			RUST_WARMUP_WAIT_BUDGET_MS,
		).finally(() => {
			this.inflightWarmups.delete(key);
		});
		this.inflightWarmups.set(key, promise);
		return promise;
	}

	/**
	 * Two-tier check on edit/write:
	 * Sends didChange + didSave (triggers flycheck/borrow-checker) and returns what arrives within
	 * the budget. The result is never marked complete because cargo check finishes later; once it
	 * settles, the diagnostics not yet reported are queued for the next `<system-reminder>`.
	 */
	async checkEditedFile(
		absolutePath: string,
		newContent: string,
		workspaceCwd: string,
		budgetMs = RUST_EDIT_WAIT_BUDGET_MS,
	): Promise<DiagnosticsResult> {
		const resolved = resolve(workspaceCwd, absolutePath);
		const key = normalizeFileKey(resolved);
		const pendingWarmup = this.inflightWarmups.get(key);
		if (pendingWarmup) {
			try {
				await pendingWarmup;
			} catch {
				// Ignore warmup errors
			}
		}
		this.baselinePending.delete(key);
		this.awaitingLateFlycheck.set(key, { filePath: resolved, receivedPush: false });
		const result = await this.updateDocument(absolutePath, newContent, workspaceCwd, true, budgetMs);
		return { diagnostics: result.diagnostics, complete: false };
	}

	dispose(): void {
		for (const waiters of this.waiters.values()) {
			for (const w of waiters) clearTimeout(w.timer);
		}
		this.waiters.clear();
		if (this.lateSettleTimer) clearTimeout(this.lateSettleTimer);
		this.lateSettleTimer = undefined;
		this.awaitingLateFlycheck.clear();
		this.baselinePending.clear();
		this.activeFlycheckTokens.clear();
		if (this.proc) {
			try {
				this.proc.kill();
			} catch {}
			this.proc = null;
		}
		this.docVersions.clear();
		this.flycheckPrimed = false;
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
	): Promise<DiagnosticsResult> {
		if (this.failedToStart) return Promise.resolve({ diagnostics: [], complete: false });
		if (!this.proc) {
			this.start(workspaceCwd);
			if (this.failedToStart || !this.proc) return Promise.resolve({ diagnostics: [], complete: false });
		}

		const resolved = resolve(workspaceCwd, absolutePath);
		const uri = pathToFileURL(resolved).href;
		const key = normalizeFileKey(resolved);
		const prevVersion = this.docVersions.get(key);
		this.serverQuiescent = false;
		this.latestDiagnostics.delete(key);

		const promise = new Promise<DiagnosticsResult>((resolveWait) => {
			const waiter: PendingWaiter = {
				receivedInitialPush: false,
				resolve: (result) => {
					clearTimeout(waiter.timer);
					resolveWait(result);
				},
				timer: setTimeout(() => {
					const list = this.waiters.get(key);
					if (list) {
						const idx = list.indexOf(waiter);
						if (idx !== -1) list.splice(idx, 1);
						if (list.length === 0) this.waiters.delete(key);
					}
					resolveWait({ diagnostics: this.latestDiagnostics.get(key) ?? [], complete: false });
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
				window: { workDoneProgress: true },
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
				this.handleMessage(JSON.parse(jsonBytes.toString("utf-8")));
			} catch {
				// Ignore malformed packets
			}
		}
	}

	private handleMessage(msg: {
		id?: number | string;
		method?: string;
		params?: {
			quiescent?: boolean;
			token?: number | string;
			value?: { kind?: string };
			uri?: string;
			diagnostics?: Array<{
				severity?: number;
				range?: { start?: { line?: number; character?: number } };
				message?: unknown;
				code?: unknown;
			}>;
		};
	}): void {
		// Server-to-client requests (e.g. window/workDoneProgress/create) expect a reply.
		if (msg.method && msg.id !== undefined) {
			this.writeMessage({ jsonrpc: "2.0", id: msg.id, result: null });
			return;
		}

		if (msg.method === "experimental/serverStatus") {
			this.serverQuiescent = Boolean(msg.params?.quiescent);
			if (this.serverQuiescent) {
				this.flushAllWaiters();
				this.scheduleLateSettle(LATE_SETTLE_GRACE_MS);
			}
			return;
		}

		if (msg.method === "$/progress" && msg.params?.token !== undefined) {
			const token = String(msg.params.token);
			if (!token.includes("flycheck")) return;
			const kind = msg.params.value?.kind;
			if (kind === "begin") {
				this.activeFlycheckTokens.add(token);
				if (this.lateSettleTimer) clearTimeout(this.lateSettleTimer);
				this.lateSettleTimer = undefined;
			} else if (kind === "end") {
				this.activeFlycheckTokens.delete(token);
				this.scheduleLateSettle(LATE_SETTLE_GRACE_MS);
			}
			return;
		}

		if (msg.method !== "textDocument/publishDiagnostics" || !msg.params?.uri) return;

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
				for (const w of waiters) w.resolve({ diagnostics: diags, complete: this.serverQuiescent });
			}
		}

		const late = this.awaitingLateFlycheck.get(key);
		if (late) {
			late.receivedPush = true;
			// Keep waiting while a flycheck runs; otherwise settle once pushes go quiet.
			this.scheduleLateSettle(this.serverQuiescent ? LATE_SETTLE_GRACE_MS : LATE_IDLE_FALLBACK_MS);
		} else if (this.baselinePending.has(key) && !(waiters && waiters.length > 0)) {
			// Diagnostics arriving after the warmup budget still describe the pre-edit file.
			this.stateTracker.setBaselineDiagnostics(filePath, diags);
		}
	}

	private scheduleLateSettle(delayMs: number): void {
		if (this.awaitingLateFlycheck.size === 0) return;
		if (this.lateSettleTimer) clearTimeout(this.lateSettleTimer);
		this.lateSettleTimer = setTimeout(() => {
			this.lateSettleTimer = undefined;
			if (this.activeFlycheckTokens.size > 0) return;
			this.settleLateDiagnostics();
		}, delayMs);
	}

	/**
	 * Report the diagnostics that appeared after an edit's budget and make the settled set the new
	 * baseline. Files whose diagnostics were never pushed again keep waiting.
	 */
	private settleLateDiagnostics(): void {
		for (const [key, late] of this.awaitingLateFlycheck) {
			if (!late.receivedPush) continue;
			this.awaitingLateFlycheck.delete(key);
			const diags = this.latestDiagnostics.get(key) ?? [];
			const diffed = this.stateTracker.diffAgainstBaseline(late.filePath, diags);
			this.stateTracker.setBaselineDiagnostics(late.filePath, diags);
			if (diffed.length > 0) {
				this.lateDiagnosticsQueue.push({ filePath: late.filePath, diagnostics: diffed });
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
				w.resolve({ diagnostics: diags, complete: true });
			}
		}
	}
}
