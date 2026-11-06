import { fauxAssistantMessage, fauxThinking } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { CUT_OFF_MESSAGE_TYPE } from "../../src/core/cut-off-response.ts";
import { createHarness, type Harness } from "./harness.ts";

/** The faux model's output limit: the faux provider counts about four characters a token. */
const MAX_TOKENS = 100;

/** A response of thinking only, cut off at the output limit (or, `short`, below it: the context ran out). */
function cutOff(short = false) {
	const thinking = short ? "Let me think." : "Let me consider every case before acting. ".repeat(12);
	return fauxAssistantMessage([fauxThinking(thinking)], { stopReason: "length" });
}

function notices(harness: Harness): number {
	return harness.session.messages.filter((m) => m.role === "custom" && m.customType === CUT_OFF_MESSAGE_TYPE).length;
}

describe("AgentSession responses cut off at the output limit", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("tells the model and goes on instead of ending the run", async () => {
		const harness = await createHarness({ models: [{ id: "faux-1", maxTokens: MAX_TOKENS }] });
		harnesses.push(harness);
		harness.setResponses([cutOff(), fauxAssistantMessage("Done.")]);
		await harness.session.prompt("solve it");
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(notices(harness)).toBe(1);
		expect(harness.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
	});

	it("ends the run after three such responses in a row", async () => {
		const harness = await createHarness({ models: [{ id: "faux-1", maxTokens: MAX_TOKENS }] });
		harnesses.push(harness);
		harness.setResponses([cutOff(), cutOff(), cutOff(), cutOff(), fauxAssistantMessage("never reached")]);
		await harness.session.prompt("solve it");
		expect(notices(harness)).toBe(3);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("thinks one level less after each cut-off response, and as before once one ends normally", async () => {
		const harness = await createHarness({ models: [{ id: "faux-1", reasoning: true, maxTokens: MAX_TOKENS }] });
		harnesses.push(harness);
		harness.session.setThinkingLevel("medium");
		const levels: Array<string | undefined> = [];
		const recorded =
			(message: ReturnType<typeof cutOff>) => (_context: unknown, options: { reasoning?: string } | undefined) => {
				levels.push(options?.reasoning);
				return message;
			};
		harness.setResponses([recorded(cutOff()), recorded(cutOff()), recorded(fauxAssistantMessage("Done."))] as never);
		await harness.session.prompt("solve it");
		harness.appendResponses([recorded(fauxAssistantMessage("Again."))] as never);
		await harness.session.prompt("once more");
		expect(levels).toEqual(["medium", "low", "minimal", "medium"]);
	});

	it("starts the next prompt at the session's thinking level after a run that ended cut off", async () => {
		const harness = await createHarness({ models: [{ id: "faux-1", reasoning: true, maxTokens: MAX_TOKENS }] });
		harnesses.push(harness);
		harness.session.setThinkingLevel("high");
		const levels: Array<string | undefined> = [];
		const recorded =
			(message: ReturnType<typeof cutOff>) => (_context: unknown, options: { reasoning?: string } | undefined) => {
				levels.push(options?.reasoning);
				return message;
			};
		harness.setResponses([cutOff(), cutOff(), cutOff(), cutOff()].map(recorded) as never);
		await harness.session.prompt("solve it");
		harness.appendResponses([recorded(cutOff()), recorded(fauxAssistantMessage("Done."))] as never);
		await harness.session.prompt("once more");
		expect(levels).toEqual(["high", "medium", "low", "minimal", "high", "medium"]);
		expect(notices(harness)).toBe(4);
	});

	it("asks the summary on the cached prefix at the thinking level the requests before it used", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", reasoning: true, maxTokens: MAX_TOKENS }],
			settings: { compaction: { keepRecentTokens: 1 } },
		});
		harnesses.push(harness);
		harness.session.setThinkingLevel("medium");
		const levels: Array<string | undefined> = [];
		const stream = harness.session.agent.streamFunction;
		harness.session.agent.streamFunction = (model, context, options) => {
			levels.push(options?.reasoning);
			return stream(model, context, options);
		};
		harness.setResponses([cutOff(), cutOff(), cutOff(), cutOff(), fauxAssistantMessage("## Goal\nSummary.")]);
		await harness.session.prompt("solve it");
		await harness.session.compact();
		expect(levels).toEqual(["medium", "low", "minimal", "minimal", "minimal"]);
	});

	it("puts the notice ahead of a message already queued, such as a job report", async () => {
		const harness = await createHarness({ models: [{ id: "faux-1", reasoning: true, maxTokens: MAX_TOKENS }] });
		harnesses.push(harness);
		harness.session.setThinkingLevel("medium");
		const seen: string[] = [];
		const levels: Array<string | undefined> = [];
		const step =
			(message: ReturnType<typeof cutOff>, queueJobReport = false) =>
			(
				context: { messages: Array<{ role: string; customType?: string }> },
				options: { reasoning?: string } | undefined,
			) => {
				levels.push(options?.reasoning);
				seen.push(context.messages.at(-1)?.role ?? "");
				if (queueJobReport) {
					void harness.session.sendCustomMessage(
						{ customType: "background-job", content: "Background job bg1 ended.", display: true },
						{ deliverAs: "steer" },
					);
				}
				return message;
			};
		harness.setResponses([
			step(cutOff(), true),
			step(fauxAssistantMessage("x")),
			step(fauxAssistantMessage("Done.")),
		] as never);
		await harness.session.prompt("solve it");
		const customs = harness.session.messages.filter((m) => m.role === "custom").map((m) => m.customType);
		expect(customs).toEqual([CUT_OFF_MESSAGE_TYPE, "background-job"]);
		expect(levels).toEqual(["medium", "low", "medium"]);
	});

	it("leaves a response cut off below the output limit to compact-and-retry", async () => {
		const harness = await createHarness({ models: [{ id: "faux-1", maxTokens: MAX_TOKENS }] });
		harnesses.push(harness);
		harness.setResponses([cutOff(true), fauxAssistantMessage("Done.")]);
		await harness.session.prompt("solve it");
		expect(notices(harness)).toBe(0);
	});

	it("leaves a response that ends normally alone", async () => {
		const harness = await createHarness({ models: [{ id: "faux-1", maxTokens: MAX_TOKENS }] });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("Done.")]);
		await harness.session.prompt("solve it");
		expect(notices(harness)).toBe(0);
	});
});
