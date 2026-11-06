/**
 * Background jobs: commands the bash tool let run on after its call returned (after a while, or right away when asked).
 *
 * The session owns one {@link BackgroundJobs}. A job that ends is reported to the agent once: through a `wait` call
 * that is blocked on it, or else as a message (see AgentSession). The job hub in the interactive mode lists them.
 */

export type BackgroundJobStatus = "running" | "done" | "failed" | "killed" | "timed out";

export interface BackgroundJob {
	/** `bg1`, `bg2`, … in the order the jobs started. */
	readonly id: string;
	readonly command: string;
	readonly cwd: string;
	readonly pid: number | undefined;
	/** When the command started (it may have run in the foreground first), in ms since the epoch. */
	readonly startedAt: number;
	/** When the command went to the background. */
	readonly backgroundedAt: number;
	/** The file its full output goes into. */
	readonly outputFile: string | undefined;
	status: BackgroundJobStatus;
	exitCode: number | null | undefined;
	endedAt: number | undefined;
	/** The end of its output when it ended, for the report. */
	tail: string;
	/** Whether the agent got its report. */
	reported: boolean;
}

export interface BackgroundJobSpec {
	command: string;
	cwd: string;
	pid: number | undefined;
	startedAt: number;
	outputFile: string | undefined;
	/** Its output so far (cleaned, at most the bash tool's limit: first lines and the end). */
	output: () => string;
	/** Stops it; its end is then reported through {@link BackgroundJobHandle.end} with status `killed`. */
	kill: () => void;
}

export interface BackgroundJobHandle {
	readonly job: BackgroundJob;
	end(status: Exclude<BackgroundJobStatus, "running">, exitCode: number | null, tail: string): void;
}

export interface BackgroundJobEvent {
	type: "start" | "end";
	job: BackgroundJob;
}

/** `customType` of the message that reports ended jobs. */
export const BACKGROUND_JOB_MESSAGE_TYPE = "background-job";

/** How long a waiter keeps collecting after one job ended, so jobs that end together come in one report. */
export const JOB_SETTLE_WINDOW_MS = 1500;
/** Ended jobs the hub keeps listing. */
const MAX_ENDED_JOBS = 50;

export class BackgroundJobs {
	private readonly jobs: BackgroundJob[] = [];
	private readonly specs = new Map<string, BackgroundJobSpec>();
	private readonly listeners = new Set<(event: BackgroundJobEvent) => void>();
	/** Blocked `wait` calls, called when a job ends. */
	private readonly waiters = new Set<() => void>();
	/** The same calls, called to end them early. */
	private readonly wakers = new Set<() => void>();
	/** Jobs being stopped through {@link kill}: they end as `killed`, whatever their exit code. */
	private readonly killing = new Set<string>();
	private count = 0;

	/** Registers a command that went to the background. */
	add(spec: BackgroundJobSpec, backgroundedAt = Date.now()): BackgroundJobHandle {
		const job: BackgroundJob = {
			id: `bg${++this.count}`,
			command: spec.command,
			cwd: spec.cwd,
			pid: spec.pid,
			startedAt: spec.startedAt,
			backgroundedAt,
			outputFile: spec.outputFile,
			status: "running",
			exitCode: undefined,
			endedAt: undefined,
			tail: "",
			reported: false,
		};
		this.jobs.push(job);
		this.specs.set(job.id, spec);
		this.emit({ type: "start", job });
		return {
			job,
			end: (status, exitCode, tail) => {
				if (job.status !== "running") return;
				job.status = this.killing.delete(job.id) ? "killed" : status;
				job.exitCode = exitCode;
				job.endedAt = Date.now();
				job.tail = tail;
				this.specs.delete(job.id);
				this.prune();
				this.emit({ type: "end", job });
				for (const wake of [...this.waiters]) wake();
			},
		};
	}

	/** Every job the hub lists, oldest first. */
	list(): readonly BackgroundJob[] {
		return this.jobs;
	}

	get(id: string): BackgroundJob | undefined {
		return this.jobs.find((job) => job.id === id);
	}

	running(): BackgroundJob[] {
		return this.jobs.filter((job) => job.status === "running");
	}

	/** Its output so far: live while it runs, its end once it ended. */
	output(id: string): string {
		const spec = this.specs.get(id);
		if (spec) return spec.output();
		return this.get(id)?.tail ?? "";
	}

	/** Stops a running job. */
	kill(id: string): boolean {
		const spec = this.specs.get(id);
		if (!spec) return false;
		this.killing.add(id);
		spec.kill();
		return true;
	}

	/** Ended jobs whose report the agent has not had, now marked reported. */
	takeUnreported(): BackgroundJob[] {
		const ended = this.jobs.filter((job) => job.status !== "running" && !job.reported);
		for (const job of ended) job.reported = true;
		return ended;
	}

	hasUnreported(): boolean {
		return this.jobs.some((job) => job.status !== "running" && !job.reported);
	}

	/** Whether a `wait` call is blocked on these jobs: it, not a message, reports the next ends. */
	hasWaiters(): boolean {
		return this.waiters.size > 0;
	}

	/**
	 * Resolves once a job ended (after {@link JOB_SETTLE_WINDOW_MS} more, or when no job runs any more), after `ms`,
	 * on {@link wake}, or when `signal` aborts. Says why.
	 */
	async waitForEnd(ms: number, signal?: AbortSignal): Promise<"ended" | "timeout" | "woken" | "aborted"> {
		if (signal?.aborted) return "aborted";
		if (this.hasUnreported()) return "ended";
		const outcome = await new Promise<"ended" | "timeout" | "woken" | "aborted">((resolve) => {
			const timer = setTimeout(() => finish("timeout"), ms);
			const onAbort = () => finish("aborted");
			const onEnd = () => finish("ended");
			const finish = (why: "ended" | "timeout" | "woken" | "aborted") => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				this.waiters.delete(onEnd);
				this.wakers.delete(onWake);
				resolve(why);
			};
			const onWake = () => finish("woken");
			this.waiters.add(onEnd);
			this.wakers.add(onWake);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
		if (outcome !== "ended" || this.running().length === 0) return outcome;
		// More jobs may end in a moment: they go into the same report.
		await new Promise<void>((resolve) => {
			const finish = () => {
				clearTimeout(timer);
				this.waiters.delete(onEnd);
				resolve();
			};
			const onEnd = () => {
				if (this.running().length === 0) finish();
			};
			const timer = setTimeout(finish, JOB_SETTLE_WINDOW_MS);
			this.waiters.add(onEnd);
		});
		return outcome;
	}

	/** Ends every blocked `wait` early: the user sent a message the agent should see now. */
	wake(): void {
		for (const wake of [...this.wakers]) wake();
	}

	subscribe(listener: (event: BackgroundJobEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Stops every running job (the session ends). */
	killAll(): void {
		for (const job of this.running()) this.kill(job.id);
	}

	private emit(event: BackgroundJobEvent): void {
		for (const listener of [...this.listeners]) listener(event);
	}

	private prune(): void {
		let ended = this.jobs.filter((job) => job.status !== "running").length;
		for (let i = 0; i < this.jobs.length && ended > MAX_ENDED_JOBS; ) {
			const job = this.jobs[i]!;
			if (job.status !== "running" && job.reported) {
				this.jobs.splice(i, 1);
				ended--;
			} else i++;
		}
	}
}

function seconds(ms: number): string {
	const s = Math.round(ms / 100) / 10;
	if (s < 60) return `${s} s`;
	const m = Math.floor(s / 60);
	return `${m} min ${Math.round(s - m * 60)} s`;
}

function describeEnd(job: BackgroundJob): string {
	const after = seconds((job.endedAt ?? Date.now()) - job.startedAt);
	switch (job.status) {
		case "killed":
			return `was stopped after ${after}`;
		case "timed out":
			return `was stopped by its timeout after ${after}`;
		default:
			return `ended ${job.exitCode === null || job.exitCode === undefined ? "without an exit code" : `with exit code ${job.exitCode}`} after ${after}`;
	}
}

/** The report of ended jobs the agent gets: what ended how, and the end of each one's output. */
/**
 * Tells the agent which jobs ended, through `send`: jobs that end together in one report, a moment after the first;
 * not while a `wait` call is blocked on them, which reports them itself. `send` delivers it in the running turn before
 * its next request, or as a new turn when the agent is idle.
 */
export class JobReporter {
	private readonly jobs: BackgroundJobs;
	private readonly send: (ended: BackgroundJob[]) => Promise<void>;
	private timer: ReturnType<typeof setTimeout> | undefined;
	/** The last report being handed over (with an idle agent: the run it starts). */
	private sending: Promise<void> = Promise.resolve();
	private readonly unsubscribe: () => void;

	constructor(jobs: BackgroundJobs, send: (ended: BackgroundJob[]) => Promise<void>) {
		this.jobs = jobs;
		this.send = send;
		this.unsubscribe = jobs.subscribe((event) => {
			if (event.type === "end") this.schedule();
		});
	}

	/** Resolves once the report being handed over is in: whether another one is still to come. */
	async settle(): Promise<boolean> {
		await this.sending;
		return this.timer !== undefined;
	}

	dispose(): void {
		clearTimeout(this.timer);
		this.unsubscribe();
	}

	private schedule(): void {
		this.timer ??= setTimeout(() => {
			this.timer = undefined;
			this.report();
		}, JOB_SETTLE_WINDOW_MS);
	}

	private report(): void {
		if (this.jobs.hasWaiters()) {
			// Should the wait end without them (aborted), they still come as a message.
			this.schedule();
			return;
		}
		const ended = this.jobs.takeUnreported();
		if (ended.length > 0) this.sending = this.send(ended).catch(() => {});
	}
}

export function formatJobReport(jobs: readonly BackgroundJob[]): string {
	const one = (job: BackgroundJob) =>
		`Background job ${job.id} (\`${job.command}\`) ${describeEnd(job)}.` +
		`${job.tail ? `\n\nEnd of its output:\n${job.tail}` : ""}` +
		`${job.outputFile ? `\n\n[Full output: ${job.outputFile}]` : ""}`;
	if (jobs.length === 1) return one(jobs[0]!);
	return `${jobs.length} background jobs ended.\n\n${jobs.map((job) => `── ${job.id} ──\n${one(job)}`).join("\n\n")}`;
}

/** One line per running job: id, command, how long it runs. */
export function describeRunningJobs(jobs: readonly BackgroundJob[], now = Date.now()): string {
	return jobs.map((job) => `${job.id} (\`${job.command}\`, running ${seconds(now - job.startedAt)})`).join(", ");
}
