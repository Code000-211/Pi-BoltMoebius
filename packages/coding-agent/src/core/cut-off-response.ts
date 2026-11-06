/**
 * A response cut off at the output limit with no tool call did nothing, and would end the run: the model is told and
 * goes on, up to {@link MAX_CUT_OFF_NOTICES} times in a row, each time thinking one level less. In Terminal-Bench 2.1,
 * glm-5.3-flash ended 2 of its first 14 runs this way, after 65,536 tokens of thinking, with most of the time left.
 */

import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { isRecoverableLength } from "@earendil-works/pi-ai/compat";
import type { CustomMessage } from "./messages.ts";

/** `customType` of the notice after a response cut off at the output limit with nothing done. */
export const CUT_OFF_MESSAGE_TYPE = "cut-off-response";
/** Such notices in a row before the run ends as before. */
const MAX_CUT_OFF_NOTICES = 3;
/** The thinking levels a cut-off response steps down through ("off" is never chosen for the model). */
const CUT_OFF_THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

export class CutOffResponses {
	/** Responses in a row cut off at the output limit with nothing done. */
	private inARow = 0;

	/** A new prompt: a run that ended cut off must not leave it thinking less. */
	reset(): void {
		this.inARow = 0;
	}

	/** `level`, one level less for each response in a row cut off at the output limit (not below minimal). */
	thinkingLevel(level: ThinkingLevel): ThinkingLevel {
		const at = (CUT_OFF_THINKING_LEVELS as readonly string[]).indexOf(level);
		if (this.inARow === 0 || at <= 0) return level;
		return CUT_OFF_THINKING_LEVELS[Math.max(0, at - this.inARow)];
	}

	/**
	 * The notice to put ahead of the next request when `message` was cut off at the output limit (`maxTokens`, the
	 * model's) with nothing done, or undefined: the run goes on with it, thinking a level less.
	 */
	answer(message: AgentMessage, maxTokens: number | undefined): CustomMessage | undefined {
		if (message.role !== "assistant") return undefined;
		if (message.stopReason !== "length") {
			this.inARow = 0;
			return undefined;
		}
		// Only a response that did nothing but think: one cut off in its answer text ends as before (Pi's behaviour).
		if (message.content.some((c) => c.type === "toolCall" || (c.type === "text" && c.text.trim()))) return undefined;
		// Cut off below the output limit: the context ran out, which compact-and-retry handles.
		if (maxTokens !== undefined && isRecoverableLength(message, maxTokens)) return undefined;
		if (this.inARow >= MAX_CUT_OFF_NOTICES) return undefined;
		this.inARow++;
		return {
			role: "custom",
			customType: CUT_OFF_MESSAGE_TYPE,
			content:
				"Your last response reached the output limit while you were still working it out, so nothing was done. Think in shorter steps: take the next concrete step now (a tool call, or write the result), and decide the rest from what it shows.",
			display: true,
			timestamp: Date.now(),
		};
	}
}
