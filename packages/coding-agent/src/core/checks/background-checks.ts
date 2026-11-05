/**
 * Checks that run in the background after an edit, so that no tool call waits for them: `edit` and `write` return at
 * once, the file's checkers (checkers.ts) run, and what is new against the state before is reported as a message the
 * model gets before its next request. When the model would end its run while checks still run, the agent session
 * waits for them, up to a limit ({@link BackgroundChecks.waitForIdle}), so that a run does not end on an error a check
 * was about to report.
 *
 * Errors (severity `error`) are reported as soon as a check finds them, against the unit's errors at its check before.
 * Lint findings (severity `warning`, from the linters a project configures) would interrupt work in progress: they
 * are collected against the unit's findings before the agent first changed it and reported once, when the model would
 * end its run ({@link BackgroundChecks.takeLintReport}), as they are then.
 *
 * Edits in quick succession make one run (they settle for {@link SETTLE_MS} first); one unit (a file, a Cargo
 * package, a tsconfig.json project) runs one check at a time, and a check that an edit overtook is run again rather
 * than reported. A unit's first check, started when one of its files is read, is its baseline; without one, only
 * findings in the files edited count as new.
 */

import type { HarnessDiagnostic } from "../harness/file-state-tracker.ts";
import { type Checker, type CheckUnit, enabledCheckers, shown } from "./checkers.ts";

/** How long edits settle before their check starts. */
const SETTLE_MS = 150;
/** Findings listed in one report. */
const MAX_REPORTED = 15;

type Counts = Map<string, number>;

interface UnitState {
	unit: CheckUnit;
	/** The errors at the last check; undefined until the first check ends. */
	errors?: Counts;
	/** The lint findings before the agent first changed the unit (or at the last lint report). */
	lintBaseline?: Counts;
	/** Lint findings new against `lintBaseline` at the last check, to report when the run would end. */
	lint: HarnessDiagnostic[];
	/** Files edited since the last check ended. */
	edited: Set<string>;
	/** Every file of the unit the agent edited. */
	editedEver: Set<string>;
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
	// Not the line: an edit above an old finding moves it, and it is still the same finding.
	return `${d.file}\0${d.severity}\0${d.code ?? ""}\0${d.message}`;
}

function counts(diagnostics: HarnessDiagnostic[]): Counts {
	const map: Counts = new Map();
	for (const d of diagnostics) map.set(fingerprint(d), (map.get(fingerprint(d)) ?? 0) + 1);
	return map;
}

/** The findings not in `before`; without `before`, those in `files` only (one elsewhere may well have been there). */
function newAgainst(
	diagnostics: HarnessDiagnostic[],
	before: Counts | undefined,
	files: Set<string>,
): HarnessDiagnostic[] {
	const remaining = new Map(before ?? []);
	const fresh: HarnessDiagnostic[] = [];
	for (const d of diagnostics) {
		const key = fingerprint(d);
		const seen = remaining.get(key) ?? 0;
		if (seen > 0) {
			remaining.set(key, seen - 1);
			continue;
		}
		if (!before && !files.has(d.file)) continue;
		fresh.push(d);
	}
	return fresh;
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

	/** The units of every checker that takes `path` (a TypeScript file: its project's tsc, and its linter). */
	private unitsFor(path: string): UnitState[] {
		const states: UnitState[] = [];
		for (const checker of this.checkers) {
			if (!checker.matches(path)) continue;
			let unit: CheckUnit | undefined;
			try {
				unit = checker.unit(path);
			} catch {
				continue;
			}
			if (!unit) continue;
			let state = this.units.get(unit.key);
			if (!state) {
				state = { unit, lint: [], edited: new Set(), editedEver: new Set(), dirty: true, runningForEdits: false };
				this.units.set(unit.key, state);
			}
			states.push(state);
		}
		return states;
	}

	/** A file was read: its units' first checks run now, as the baselines its edits are compared with. */
	onRead(path: string): void {
		for (const state of this.unitsFor(path)) {
			if (!state.errors && !state.running && !state.timer) this.schedule(state, 0);
		}
	}

	/** A file was changed by the agent (edit, write, or a bash command it ran). */
	onEdited(path: string): void {
		for (const state of this.unitsFor(path)) {
			state.edited.add(path);
			state.editedEver.add(path);
			state.dirty = true;
			this.schedule(state, SETTLE_MS);
		}
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
			// A checker that fails (killed, gone) leaves the baselines as they were, and is not waited for again.
			for (const file of edited) state.edited.delete(file);
			return;
		}
		// An edit came while it ran: the next check reports, on the newer files.
		if (state.dirty) return;
		for (const file of edited) state.edited.delete(file);
		const errors = diagnostics.filter((d) => d.severity === "error");
		const lint = diagnostics.filter((d) => d.severity !== "error");
		const errorsBefore = state.errors;
		state.errors = counts(errors);
		// The check before any edit is the lint baseline.
		if (state.editedEver.size === 0) {
			state.lintBaseline = counts(lint);
			return;
		}
		state.lint = newAgainst(lint, state.lintBaseline, state.editedEver);
		if (edited.size === 0) return;
		const fresh = newAgainst(errors, errorsBefore, edited);
		if (fresh.length > 0) {
			this.options.report(this.format(`New errors after your changes (${state.unit.checker.name} check):`, fresh));
		}
	}

	private format(title: string, diagnostics: HarnessDiagnostic[]): string {
		const lines = diagnostics
			.slice(0, MAX_REPORTED)
			.map(
				(d) =>
					`  ${shown(d.file, this.options.cwd)}:${d.line}:${d.column}${d.code ? ` ${d.code}` : ""}: ${d.message}`,
			);
		if (diagnostics.length > MAX_REPORTED) lines.push(`  ... and ${diagnostics.length - MAX_REPORTED} more`);
		return `${title}\n${lines.join("\n")}`;
	}

	/**
	 * The lint findings the agent's changes brought, as they are now, for when the run would end; undefined when there
	 * are none. What it reports becomes the baseline: the same finding is not reported again.
	 */
	takeLintReport(): string | undefined {
		const findings: HarnessDiagnostic[] = [];
		const linters = new Set<string>();
		for (const state of this.units.values()) {
			if (state.lint.length === 0) continue;
			findings.push(...state.lint);
			linters.add(state.unit.checker.name);
			state.lintBaseline = new Map([...(state.lintBaseline ?? []), ...counts(state.lint)]);
			state.lint = [];
		}
		if (findings.length === 0) return undefined;
		return this.format(
			`Lint findings in what you changed (${[...linters].join(", ")}, as this project configures them); fix them, or say why they stay:`,
			findings,
		);
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
		for (const resolve of this.idleWaiters) resolve();
		this.idleWaiters = [];
	}
}
