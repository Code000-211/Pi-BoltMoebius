import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getAssistantTexts, getMessageText, type Harness } from "./harness.ts";

describe("AgentSession bash background jobs", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("wakes the idle agent with the report of a command its timeout moved to the background", async () => {
		const harness = await createHarness({ initialActiveToolNames: ["bash"] });
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 0.4; echo build-done", timeout: 0.1 })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("It runs in the background."),
			fauxAssistantMessage("The build is done."),
		]);
		await harness.session.prompt("build it");
		expect(getAssistantTexts(harness)).toContain("It runs in the background.");

		const deadline = Date.now() + 10_000;
		while (!getAssistantTexts(harness).includes("The build is done.") && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		const report = harness.session.messages.find(
			(message) => message.role === "custom" && message.customType === "bash-background-job",
		);
		expect(report && getMessageText(report)).toMatch(/ended with exit code 0[\s\S]*build-done/);
		expect(getAssistantTexts(harness)).toContain("The build is done.");
	});
});
