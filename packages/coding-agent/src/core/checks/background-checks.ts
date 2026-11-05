/**
 * Checks that run in the background after an edit, so that no tool call waits for them: `edit` and `write` return at
 * once, the file's checker (checkers.ts) runs, and only errors that are new against the unit's errors before are
 * reported, as a message the model gets before its next request. When the model would end its run while checks still
 * run, the agent session waits for them, up to a limit ({@link BackgroundChecks.waitForIdle}), so that a run does not
 * end on an error a check was about to report.
 *
 * Edits in quick succession make one run (they settle for {@link SETTLE_MS} first); one unit (a file, a Cargo
 * package, a tsconfig.json project) runs one check at a time, and a check that an edit overtook is run again rather
 * than reported. A unit's first check, started when one of its files is read, is its baseline; without one, only
 * errors in the files edited since count as new.
 */

import type { HarnessDiagnostic } from "../harness/file-state-tracker.ts";
import { type Checker, type CheckUnit, enabledCheckers, shown } from "./checkers.ts";

/** How long edits settle before their check starts. */
const SETTLE_MS = 150;
/** Errors listed in one report. */
const MAX_REPORTED = 15;

interface UnitState {
	unit: CheckUnit;
	/** Fingerprint -> count of the errors last seen; undefined until the first check ends. */
	baseline?: Map<string, number>;
	/** Files edited since the last check ended. */
	edited: Set<string>;
	/** An edit came after the running check read the files, or no check ran since. */
	dirty: boolean;
	running?: Promise<void>;
	/** The running check was started for edits (not only as a baseline): its result is waited for. */
	runningForEdits: boolean;
	timer?: ReturnType<typeof setTimeout>;
}

export interface BackgroundChecksOptions {
	/** The working folder, which reported paths are shown relative to. */
	cwd: string;
	/** Called with a report of new errors. */
	report: (text: string) => void;
	checkers?: Checker[];
}

function fingerprint(d: HarnessDiagnostic): string {
	// Not the line: an edit above an old error moves it, and it is still the same error.
	return `${d.file}\0${d.code ?? ""}\0${d.message}`;
}

function counts(diagnostics: HarnessDiagnostic[]): Map<string, number> {
	const map = new Map<string, number>();
	for (const d of diagnostics) map.set(fingerprint(d), (map.get(fingerprint(d)) ?? 0) + 1);
	return map;
}

export class BackgroundChecks {
	private readonly units = new Map<string, UnitState>();
	private readonly checkers: Checker[];
	private readonly abort = new AbortController();
	private idleWaiters: Array<() => void> = [];
	private readonly options: BackgroundChecksOptions;

	constructor(options: BackgroundChecksOptions) {
		this.options = options;
		this.checkers = options.checkers ?? enabledCheckers();
	}

	/** Whether any checker is on. */
	get enabled(): boolean {
		return this.checkers.length > 0;
	}

	private unitFor(path: string): UnitState | undefined {
		const checker = this.checkers.find((c) => c.matches(path));
		if (!checker) return undefined;
		let unit: CheckUnit | undefined;
		try {
			unit = checker.unit(path);
		} catch {
			return undefined;
		}
		if (!unit) return undefined;
		let state = this.units.get(unit.key);
		if (!state) {
			state = { unit, edited: new Set(), dirty: true, runningForEdits: false };
			this.units.set(unit.key, state);
		}
		return state;
	}

	/** A file was read: its unit's first check runs now, as the baseline its edits are compared with. */
	onRead(path: string): void {
		const state = this.unitFor(path);
		if (state && !state.baseline && !state.running && !state.timer) this.schedule(state, 0);
	}

	/** A file was changed by the agent (edit, write, or a bash command it ran). */
	onEdited(path: string): void {
		const state = this.unitFor(path);
		if (!state) return;
		state.edited.add(path);
		state.dirty = true;
		this.schedule(state, SETTLE_MS);
	}

	private schedule(state: UnitState, delayMs: number): void {
		if (this.abort.signal.aborted) return;
		if (state.timer) clearTimeout(state.timer);
		state.timer = setTimeout(() => {
			state.timer = undefined;
			// A running check starts the next one when it ends.
			if (!state.running) this.start(state);
		}, delayMs);
		state.timer.unref?.();
	}

	private start(state: UnitState): void {
		state.dirty = false;
		const edited = new Set(state.edited);
		state.runningForEdits = edited.size > 0;
		state.running = this.check(state, edited).finally(() => {
			state.running = undefined;
			state.runningForEdits = false;
			if (state.dirty && !this.abort.signal.aborted) this.start(state);
			else this.notifyIfIdle();
		});
	}

	private async check(state: UnitState, edited: Set<string>): Promise<void> {
		let diagnostics: HarnessDiagnostic[];
		try {
			diagnostics = await state.unit.checker.run(state.unit, this.abort.signal);
		} catch {
			// A checker that fails (killed, gone) leaves the baseline as it was, and is not waited for again.
			for (const file of edited) state.edited.delete(file);
			return;
		}
		// An edit came while it ran: the next check reports, on the newer files.
		if (state.dirty) return;
		const before = state.baseline;
		const now = counts(diagnostics);
		state.baseline = now;
		for (const file of edited) state.edited.delete(file);
		if (edited.size === 0) return;
		const fresh: HarnessDiagnostic[] = [];
		const remaining = new Map(before ?? []);
		for (const d of diagnostics) {
			const key = fingerprint(d);
			const seen = remaining.get(key) ?? 0;
			if (seen > 0) {
				remaining.set(key, seen - 1);
				continue;
			}
			// Without a baseline, an error elsewhere may well have been there before.
			if (!before && !edited.has(d.file)) continue;
			fresh.push(d);
		}
		if (fresh.length > 0) this.options.report(this.format(state.unit.checker.name, fresh));
	}

	private format(checker: string, diagnostics: HarnessDiagnostic[]): string {
		const lines = diagnostics
			.slice(0, MAX_REPORTED)
			.map(
				(d) =>
					`  ${shown(d.file, this.options.cwd)}:${d.line}:${d.column}${d.code ? ` ${d.code}` : ""}: ${d.message}`,
			);
		if (diagnostics.length > MAX_REPORTED) lines.push(`  ... and ${diagnostics.length - MAX_REPORTED} more`);
		return `New errors after your changes (${checker} check, in the background):\n${lines.join("\n")}`;
	}

	/** Whether a check for edits runs or is about to (a baseline check alone is not waited for). */
	get busy(): boolean {
		for (const state of this.units.values()) {
			if (state.runningForEdits || state.edited.size > 0) return true;
		}
		return false;
	}

	private notifyIfIdle(): void {
		if (this.busy) return;
		const waiters = this.idleWaiters;
		this.idleWaiters = [];
		for (const resolve of waiters) resolve();
	}

	/** Resolves when no check for edits runs or is about to, or after `timeoutMs`. */
	async waitForIdle(timeoutMs: number): Promise<void> {
		if (!this.busy) return;
		await new Promise<void>((resolve) => {
			const timer = setTimeout(done, timeoutMs);
			timer.unref?.();
			function done() {
				clearTimeout(timer);
				resolve();
			}
			this.idleWaiters.push(done);
		});
	}

	/** Stops the running checks; none start after. */
	dispose(): void {
		this.abort.abort();
		for (const state of this.units.values()) if (state.timer) clearTimeout(state.timer);
		this.notifyIfIdle();
		for (const resolve of this.idleWaiters) resolve();
		this.idleWaiters = [];
	}
}
