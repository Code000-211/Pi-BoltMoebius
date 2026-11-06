/**
 * Near the compaction threshold, the summary of what the compaction would cut is made in the background, and the
 * threshold compaction takes it ({@link CompactionAhead.take}) instead of stopping the agent for the summary request.
 * Before, the agent stood still for each summary: 14, 56, 60 and 95 s in four real sessions.
 *
 * The threshold is not the context's limit: while the summary is still being made, the agent goes on above it, and
 * stops to wait for it only some way above (see {@link COMPACTION_AHEAD_OVERRUN}). The entries the summary covers stay
 * as they are: later ones are appended, and kept by the compaction.
 */

import type { SessionEntry, SessionManager } from "../session-manager.ts";
import {
	type CompactionPreparation,
	type CompactionResult,
	type CompactionSettings,
	getCompactionThreshold,
	prepareCompaction,
} from "./compaction.ts";

/**
 * How far below the compaction threshold the summary starts in the background: a share of the threshold, up to a
 * number of tokens. Started closer, the agent works on above the threshold for longer (a summary takes 15 to 90
 * seconds); started earlier, more of the context stays after the compaction, and a session that ends below the
 * threshold paid for a summary it never used.
 */
const COMPACTION_AHEAD_SHARE = 0.15;
const COMPACTION_AHEAD_MAX_TOKENS = 40_000;
/**
 * How far above the threshold the agent goes on while the summary made ahead is not ready yet, as a share of the
 * threshold: at most halfway to the context's limit (the window less `reserveTokens`).
 */
const COMPACTION_AHEAD_OVERRUN = 0.5;

/** A compaction summary made in the background before the threshold was reached. */
interface PendingSummary {
	sessionManager: SessionManager;
	/** The branch's last entry when it started: the summary covers the entries before the cut point up to it. */
	leafId: string;
	firstKeptEntryId: string;
	keepRecentTokens: number;
	controller: AbortController;
	/** Undefined when it failed or was cancelled. */
	result: Promise<CompactionResult | undefined>;
	done: boolean;
}

export class CompactionAhead {
	/** The summary being made or made, until a compaction takes it or it no longer fits. */
	pending: PendingSummary | undefined;

	/**
	 * After a response with `contextTokens` in the session's current branch: starts the summary when the context is near
	 * the threshold (with `summarize`, Pi's own summary request), or keeps the one being made while it still fits. Not
	 * for a context so small that the kept part alone would be near the threshold again.
	 *
	 * Returns whether the compaction is to wait: a summary is being made, and the context is below where it stops.
	 */
	update(options: {
		contextTokens: number;
		contextWindow: number;
		sessionManager: SessionManager;
		settings: CompactionSettings;
		summarize: (preparation: CompactionPreparation, signal: AbortSignal) => Promise<CompactionResult>;
	}): boolean {
		const { contextTokens, contextWindow, sessionManager, settings } = options;
		const threshold = getCompactionThreshold(contextWindow, settings);
		const start = threshold - Math.min(threshold * COMPACTION_AHEAD_SHARE, COMPACTION_AHEAD_MAX_TOKENS);
		if (contextTokens <= start || start < 2 * settings.keepRecentTokens) return false;
		const limit = contextWindow - settings.reserveTokens;
		const goesOn =
			contextTokens <= threshold + Math.min((limit - threshold) / 2, threshold * COMPACTION_AHEAD_OVERRUN);
		const branch = sessionManager.getBranch();
		const current = this.pending;
		if (current) {
			if (fits(current, sessionManager, branch, settings)) return goesOn && !current.done;
			current.controller.abort();
			this.pending = undefined;
		}
		const leafId = branch.at(-1)?.id;
		const preparation = prepareCompaction(branch, settings);
		if (
			!leafId ||
			!preparation ||
			(preparation.messagesToSummarize.length === 0 && preparation.turnPrefixMessages.length === 0)
		) {
			return false;
		}
		const controller = new AbortController();
		const pending: PendingSummary = {
			sessionManager,
			leafId,
			firstKeptEntryId: preparation.firstKeptEntryId,
			keepRecentTokens: settings.keepRecentTokens,
			controller,
			done: false,
			result: options
				.summarize(preparation, controller.signal)
				.catch(() => undefined)
				.finally(() => {
					pending.done = true;
				}),
		};
		this.pending = pending;
		return goesOn;
	}

	/**
	 * The summary made ahead for a threshold compaction of `branch`, waited for when it is still being made (the wait
	 * ends with `signal`); undefined when there is none, it does not fit, or it failed. Taken once.
	 */
	async take(
		sessionManager: SessionManager,
		branch: SessionEntry[],
		settings: CompactionSettings,
		signal: AbortSignal,
	): Promise<CompactionResult | undefined> {
		const pending = this.pending;
		if (!pending) return undefined;
		this.pending = undefined;
		if (!fits(pending, sessionManager, branch, settings)) {
			pending.controller.abort();
			return undefined;
		}
		const cancel = () => pending.controller.abort();
		signal.addEventListener("abort", cancel, { once: true });
		try {
			return await pending.result;
		} finally {
			signal.removeEventListener("abort", cancel);
		}
	}

	/** Stops the summary being made. */
	cancel(): void {
		this.pending?.controller.abort();
	}
}

/** Whether a summary made ahead still fits `branch`: nothing it covers was compacted, edited or left since. */
function fits(
	pending: PendingSummary,
	sessionManager: SessionManager,
	branch: SessionEntry[],
	settings: CompactionSettings,
): boolean {
	if (pending.sessionManager !== sessionManager || pending.keepRecentTokens !== settings.keepRecentTokens) {
		return false;
	}
	if (pending.controller.signal.aborted) return false;
	const leafIndex = branch.findIndex((entry) => entry.id === pending.leafId);
	const keptIndex = branch.findIndex((entry) => entry.id === pending.firstKeptEntryId);
	if (leafIndex < 0 || keptIndex < 0) return false;
	return branch.slice(leafIndex + 1).every((entry) => {
		if (entry.type === "compaction") return false;
		if (entry.type !== "context_edit") return true;
		const target = branch.findIndex((other) => other.id === entry.targetId);
		return target >= keptIndex;
	});
}
