/**
 * A time limit for a run (`PI_TIME_LIMIT`, in seconds): the model is told it in the system prompt, and how much is left
 * at half, three quarters and nine tenths of it, so that it saves a complete result before the run is stopped. In
 * Terminal-Bench 2.1 every task has one (mostly 15 minutes), and in 15 runs of glm-5.3-flash all 3 failures were runs
 * stopped at the limit while still refining, with no result saved. Without a limit nothing changes.
 */

/** `customType` of the message that tells how much time is left. */
export const TIME_LIMIT_MESSAGE_TYPE = "time-limit";

/**
 * With a limit, a response stops at this many output tokens (or the model's own, if lower). glm-5.3-flash streams about
 * 128 a second: its 65,536 took 8.5 minutes of thinking in one response, over half of a 15-minute task, before the run
 * went on. This is still room for writing a large file in one call.
 */
export const TIME_LIMIT_MAX_OUTPUT_TOKENS = 32_768;

/**
 * The output limit a response gets: the model's (`modelMax`), and with `PI_TIME_LIMIT` at most
 * {@link TIME_LIMIT_MAX_OUTPUT_TOKENS}. A response cut off below it ran out of context (compact-and-retry); one that
 * reached it was cut off by this limit (the agent session's notice).
 */
export function maxOutputTokens(modelMax: number): number {
	if (parseTimeLimit(process.env.PI_TIME_LIMIT) === undefined) return modelMax;
	return Math.min(modelMax || TIME_LIMIT_MAX_OUTPUT_TOKENS, TIME_LIMIT_MAX_OUTPUT_TOKENS);
}

/** When the model is told, as a share of the limit. */
const NOTICE_AT = [0.5, 0.75, 0.9] as const;

/** The limit in ms from `PI_TIME_LIMIT` (seconds), or undefined when it is not a positive number. */
export function parseTimeLimit(value: string | undefined): number | undefined {
	const seconds = Number(value);
	return value && Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

function minutes(ms: number): string {
	const m = ms / 60_000;
	return m >= 10 ? `${Math.round(m)} min` : `${Math.max(0, Math.round(m * 10) / 10)} min`;
}

/** The system prompt's section for a run with this limit. */
export function timeLimitSection(limitMs: number): string {
	return `This task has a time limit of ${minutes(limitMs)}, counted from its first message; commands count against it. When it runs out the run is stopped, and only what is saved by then counts. Save a complete result early, then improve it while time is left; you are told how much is left as it runs out.`;
}

/** What the model is told when `share` of the limit has passed. */
export function timeNotice(share: number, limitMs: number): string {
	const left = minutes(limitMs * (1 - share));
	if (share < 0.75) {
		return `Time: ${left} of ${minutes(limitMs)} left. If the required result is not saved yet in complete form, save it now, then improve it.`;
	}
	if (share < 0.9) {
		return `Time: ${left} left. Make sure the required result is complete and saved; from here, only small changes you check right away.`;
	}
	return `Time: ${left} left. Finish now: save the result as it is and stop.`;
}

/** Calls `notify` with each notice as its time comes, from {@link start} on, until {@link stop}. */
export class TimeLimitClock {
	readonly limitMs: number;
	private readonly notify: (text: string) => void;
	private timers: ReturnType<typeof setTimeout>[] = [];
	private started = false;

	constructor(limitMs: number, notify: (text: string) => void) {
		this.limitMs = limitMs;
		this.notify = notify;
	}

	/** Starts the clock; later calls do nothing. */
	start(): void {
		if (this.started) return;
		this.started = true;
		for (const share of NOTICE_AT) {
			const timer = setTimeout(() => this.notify(timeNotice(share, this.limitMs)), this.limitMs * share);
			timer.unref?.();
			this.timers.push(timer);
		}
	}

	stop(): void {
		for (const timer of this.timers) clearTimeout(timer);
		this.timers = [];
	}
}
