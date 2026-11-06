/**
 * Clears the content of old, large tool results from what is sent to the model.
 *
 * A file read or a test run fifty tool calls ago is resent with every request and rarely read again. Once the context
 * is past `triggerTokens`, every tool result older than the most recent `keepRecent` whose content is at least
 * `minChars` long (or holds an image) is sent as a one-line note instead. The session keeps the full results:
 * compaction summarizes them, and the agent can run the tool again.
 *
 * Prompt caches end at the first message that changed, so the boundary moves in steps of `keepRecent` tool results
 * rather than with every call: between steps the cleared prefix is the same bytes as before (and the same objects, for
 * the providers' conversion cache). Between `keepRecent` and `2 * keepRecent - 1` recent results stay complete.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, Message, TextContent, ToolResultMessage } from "@earendil-works/pi-ai";
import { estimateTokens } from "./compaction/compaction.ts";
import { convertToLlm } from "./messages.ts";

export interface ToolResultPruningSettings {
	enabled: boolean;
	/** Clear only while the context sent without clearing is at least this many tokens (estimated). */
	triggerTokens: number;
	/** The most recent tool results that are never cleared; the boundary moves in steps of this many. */
	keepRecent: number;
	/** Clear only results whose text is at least this long, or that hold an image. */
	minChars: number;
}

const tokenEstimates = new WeakMap<object, number>();
const clearedResults = new WeakMap<object, ToolResultMessage>();

function estimate(message: Message): number {
	let tokens = tokenEstimates.get(message);
	if (tokens === undefined) {
		tokens = estimateTokens(message);
		tokenEstimates.set(message, tokens);
	}
	return tokens;
}

function isLarge(content: (TextContent | ImageContent)[], minChars: number): boolean {
	let chars = 0;
	for (const block of content) {
		if (block.type === "image") return true;
		chars += block.text.length;
	}
	return chars >= minChars;
}

function cleared(message: ToolResultMessage): ToolResultMessage {
	let result = clearedResults.get(message);
	if (!result) {
		let chars = 0;
		let images = 0;
		for (const block of message.content) {
			if (block.type === "text") chars += block.text.length;
			else images++;
		}
		const size = [chars > 0 ? `${chars} characters` : "", images > 0 ? `${images} image(s)` : ""]
			.filter(Boolean)
			.join(", ");
		result = {
			...message,
			content: [
				{
					type: "text",
					text: `[Old ${message.toolName} result cleared from the context to save space (${size}). Run the tool again if you need it.]`,
				},
			],
		};
		clearedResults.set(message, result);
	}
	return result;
}

/** Returns `messages` itself when nothing is cleared. */
export function pruneToolResults(messages: Message[], settings: ToolResultPruningSettings): Message[] {
	const keepRecent = Math.max(1, settings.keepRecent);
	if (!settings.enabled) return messages;
	let toolResults = 0;
	let tokens = 0;
	for (const message of messages) {
		if (message.role === "toolResult") toolResults++;
		tokens += estimate(message);
	}
	if (tokens < settings.triggerTokens || toolResults < 2 * keepRecent) return messages;
	const clearBefore = Math.floor((toolResults - keepRecent) / keepRecent) * keepRecent;
	let index = 0;
	let changed = false;
	const result = messages.map((message) => {
		if (message.role !== "toolResult" || index++ >= clearBefore) return message;
		if (!isLarge(message.content, settings.minChars)) return message;
		changed = true;
		return cleared(message);
	});
	return changed ? result : messages;
}

/** The estimated tokens `pruneToolResults` clears from `messages`. */
export function prunedTokens(messages: Message[], settings: ToolResultPruningSettings): number {
	const pruned = pruneToolResults(messages, settings);
	if (pruned === messages) return 0;
	let tokens = 0;
	for (let i = 0; i < messages.length; i++) {
		if (pruned[i] !== messages[i]) tokens += estimate(messages[i]) - estimate(pruned[i]);
	}
	return tokens;
}

/**
 * `tokens` of `messages` as the next request sends them: less what pruning clears in it beyond what it cleared in the
 * request whose usage `tokens` counts (the one before the response at `usageIndex`; without one, `tokens` is the
 * estimate of all of `messages`). Pruning clears in steps, so a step can take a context back below the compaction
 * threshold that the size of the last request was above.
 */
export function tokensAfterPruning(
	tokens: number,
	messages: AgentMessage[],
	usageIndex: number | null,
	settings: ToolResultPruningSettings,
): number {
	if (!settings.enabled) return tokens;
	const cleared =
		prunedTokens(convertToLlm(messages), settings) -
		(usageIndex === null ? 0 : prunedTokens(convertToLlm(messages.slice(0, usageIndex)), settings));
	return Math.max(0, tokens - Math.max(0, cleared));
}
