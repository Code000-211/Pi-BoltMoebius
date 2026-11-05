import { fauxAssistantMessage, fauxThinking } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { CUT_OFF_MESSAGE_TYPE } from "../../src/core/agent-session.ts";
import { createHarness, type Harness } from "./harness.ts";

function cutOff() {
	return fauxAssistantMessage([fauxThinking("Let me consider every case before acting...")], { stopReason: "length" });
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
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([cutOff(), fauxAssistantMessage("Done.")]);
		await harness.session.prompt("solve it");
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(notices(harness)).toBe(1);
		expect(harness.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
	});

	it("ends the run after three such responses in a row", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([cutOff(), cutOff(), cutOff(), cutOff(), fauxAssistantMessage("never reached")]);
		await harness.session.prompt("solve it");
		expect(notices(harness)).toBe(3);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("leaves a response that ends normally alone", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("Done.")]);
		await harness.session.prompt("solve it");
		expect(notices(harness)).toBe(0);
	});
});
