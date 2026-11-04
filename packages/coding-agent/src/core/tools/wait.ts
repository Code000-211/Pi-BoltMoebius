import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import { type BackgroundJobs, describeRunningJobs, formatJobReport } from "../background-jobs.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { waitRenderers } from "./renderers/wait.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const waitSchema = Type.Object({});

export type WaitToolInput = Static<typeof waitSchema>;

export interface WaitToolOptions {
	/** The session's jobs. Without them, there is never anything to wait for. */
	backgroundJobs?: BackgroundJobs;
}

/**
 * How long one wait blocks with nothing ending; each wait right after an empty one blocks longer, so a wait loop backs
 * off. oh-my-pi starts at 5 s to give the agent its turn back early, but an agent calls wait when it has nothing else to
 * do: short waits only cost turns.
 */
export const WAIT_LADDER_MS = [120_000, 300_000, 600_000] as const;
/** A wait this long after the last empty one starts again at the bottom of the ladder: the agent worked in between. */
const WAIT_LADDER_RESET_MS = 60_000;

export const waitToolSystemPromptContribution = {
	snippet: "Wait for a background job to end",
	guidelines: [],
} as const;

const DESCRIPTION =
	"Wait for one of your background jobs to end and get its report. Only when nothing else is left to do.";

export function createWaitToolDefinition(
	options?: WaitToolOptions,
): ToolDefinition<typeof waitSchema, { jobs: string[] } | undefined> {
	const jobs = options?.backgroundJobs;
	// Back-to-back waits with nothing ending: how far up the ladder, and when the last one returned.
	let idle: { rung: number; endedAt: number; waitedMs: number } | undefined;
	return {
		name: "wait",
		label: "wait",
		description: DESCRIPTION,
		promptSnippet: waitToolSystemPromptContribution.snippet,
		parameters: waitSchema,
		async execute(_toolCallId, _params, signal) {
			const streak = idle && Date.now() - idle.endedAt < WAIT_LADDER_RESET_MS ? idle : undefined;
			idle = undefined;
			const report = () => {
				const ended = jobs?.takeUnreported() ?? [];
				return ended.length > 0
					? {
							content: [{ type: "text" as const, text: formatJobReport(ended) }],
							details: { jobs: ended.map((job) => job.id) },
						}
					: undefined;
			};
			const before = report();
			if (before) return before;
			if (!jobs || jobs.running().length === 0) {
				return {
					content: [{ type: "text", text: "Nothing to wait for: no background job is running." }],
					details: { jobs: [] },
				};
			}
			const rung = streak ? Math.min(streak.rung + 1, WAIT_LADDER_MS.length - 1) : 0;
			const outcome = await jobs.waitForEnd(WAIT_LADDER_MS[rung], signal);
			const after = report();
			if (after) return after;
			if (outcome === "aborted") throw new Error("Wait aborted");
			if (outcome === "woken") {
				return {
					content: [{ type: "text", text: "Wait ended for a message from the user." }],
					details: { jobs: [] },
				};
			}
			const waitedMs = (streak?.waitedMs ?? 0) + WAIT_LADDER_MS[rung];
			idle = { rung, endedAt: Date.now(), waitedMs };
			let text = `No background job ended within ${WAIT_LADDER_MS[rung] / 1000} s. Running: ${describeRunningJobs(jobs.running())}.`;
			if (rung >= 1) {
				text += `\n\nNothing ended after ${Math.round(waitedMs / 1000)} s of back-to-back waits. Waiting is not progress: go on with everything that does not need these jobs, and call wait again only when nothing else is left. Their reports come on their own.`;
			}
			return { content: [{ type: "text", text }], details: { jobs: [] } };
		},
		...waitRenderers,
	};
}

export function createWaitTool(options?: WaitToolOptions): AgentTool<typeof waitSchema> {
	return wrapToolDefinition(createWaitToolDefinition(options));
}
