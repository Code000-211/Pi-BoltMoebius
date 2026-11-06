import { type AssistantMessage, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { compactionFeatures } from "../../src/core/compaction/features.ts";
import { createHarness, type Harness } from "./harness.ts";

type Internals = {
	_checkCompaction: (assistantMessage: AssistantMessage, skipAbortedCheck?: boolean) => Promise<boolean>;
	_runAutoCompaction: (...args: unknown[]) => Promise<boolean>;
};

function usage(totalTokens: number) {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** A read of 20,000 characters (about 5,000 tokens) and the response that asked for it, with `totalTokens` of usage. */
function step(harness: Harness, n: number, totalTokens: number): AssistantMessage {
	const model = harness.getModel();
	const now = Date.now();
	const id = `read-${n}`;
	const assistant: AssistantMessage = {
		...fauxAssistantMessage(fauxToolCall("read", { path: `f${n}` }, { id }), {
			stopReason: "toolUse",
			timestamp: now,
		}),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: usage(totalTokens),
	};
	harness.sessionManager.appendMessage(assistant);
	harness.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: id,
		toolName: "read",
		content: [{ type: "text", text: "y".repeat(20_000) }],
		isError: false,
		timestamp: now + 1,
	});
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
	return assistant;
}

/**
 * Threshold 50k. Pruning keeps the latest 4 tool results and clears in steps of 4 once there are 8: the request after
 * the eighth result clears four, about 20k tokens, which the size of the request before it (52k) does not show.
 */
async function eightReads(pruning: boolean): Promise<{ harness: Harness; compacted: boolean }> {
	const harness = await createHarness({
		settings: {
			compaction: { enabled: true, reserveTokens: 1000, thresholdPercent: 50 },
			toolResultPruning: { enabled: pruning, triggerTokens: 10_000, keepRecent: 4, minChars: 2000 },
		},
		models: [{ id: "faux-1", contextWindow: 100_000 }],
	});
	const internals = harness.session as unknown as Internals;
	let compacted = false;
	internals._runAutoCompaction = async () => {
		compacted = true;
		return false;
	};
	harness.sessionManager.appendMessage({ role: "user", content: "read them all", timestamp: Date.now() });
	let last: AssistantMessage | undefined;
	for (let n = 1; n <= 8; n++) last = step(harness, n, n === 8 ? 52_000 : n * 5_000);
	await internals._checkCompaction(last!);
	return { harness, compacted };
}

describe("compaction threshold after tool-result pruning", () => {
	const harnesses: Harness[] = [];
	beforeAll(() => {
		compactionFeatures.ahead = false;
	});
	afterAll(() => {
		compactionFeatures.ahead = true;
	});
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("does not compact when the next request's pruning takes the context below the threshold", async () => {
		const { harness, compacted } = await eightReads(true);
		harnesses.push(harness);
		expect(compacted).toBe(false);
	});

	it("compacts the same context without pruning", async () => {
		const { harness, compacted } = await eightReads(false);
		harnesses.push(harness);
		expect(compacted).toBe(true);
	});
});
