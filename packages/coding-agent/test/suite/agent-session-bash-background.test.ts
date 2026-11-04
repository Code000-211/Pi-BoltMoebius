import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_JOB_MESSAGE_TYPE } from "../../src/core/background-jobs.ts";
import { createHarness, getAssistantTexts, getMessageText, type Harness } from "./harness.ts";

async function until(condition: () => boolean, ms = 10_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
}

function reports(harness: Harness): string[] {
	return harness.session.messages
		.filter((message) => message.role === "custom" && message.customType === BACKGROUND_JOB_MESSAGE_TYPE)
		.map((message) => getMessageText(message));
}

describe("AgentSession bash background jobs", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function harnessWithBash(tools = ["bash", "wait"]): Promise<Harness> {
		const harness = await createHarness({ initialActiveToolNames: tools });
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		return harness;
	}

	it("wakes the idle agent with the report of a job that ended", async () => {
		const harness = await harnessWithBash();
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 0.3; echo build-done", background: true })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("It runs in the background."),
			fauxAssistantMessage("The build is done."),
		]);
		await harness.session.prompt("build it");
		expect(getAssistantTexts(harness)).toContain("It runs in the background.");

		await until(() => getAssistantTexts(harness).includes("The build is done."));
		expect(reports(harness)).toEqual([
			expect.stringMatching(/^Background job bg1 .* ended with exit code 0[\s\S]*build-done/),
		]);
		expect(getAssistantTexts(harness)).toContain("The build is done.");
	});

	it("puts the report of a job that ends during a run into that run, before its next request", async () => {
		const harness = await harnessWithBash();
		let sawReport = false;
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 0.1; echo job-out", background: true })], {
				stopReason: "toolUse",
			}),
			// Busy while the job ends and its report waits out the settle window.
			fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 2.2" })], { stopReason: "toolUse" }),
			(context) => {
				sawReport = context.messages.some(
					(message) => message.role === "user" && getMessageText(message).includes("Background job bg1"),
				);
				return fauxAssistantMessage("Saw it.");
			},
		]);
		await harness.session.prompt("go");
		expect(sawReport).toBe(true);
		expect(getAssistantTexts(harness)).toEqual(["", "", "Saw it."]);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("reports a job through a blocked wait, and then not again as a message", async () => {
		const harness = await harnessWithBash();
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 0.2; echo waited-for", background: true })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("Done."),
		]);
		await harness.session.prompt("go");
		const waitResult = harness.session.messages.find(
			(message) => message.role === "toolResult" && message.toolName === "wait",
		);
		expect(waitResult && getMessageText(waitResult)).toMatch(
			/^Background job bg1 .* ended with exit code 0[\s\S]*waited-for/,
		);
		await new Promise((resolve) => setTimeout(resolve, 2_000));
		expect(reports(harness)).toEqual([]);
		expect(getAssistantTexts(harness)).toEqual(["", "", "Done."]);
	});

	it("lets print mode wait until the report of a running job had its turn", async () => {
		const harness = await harnessWithBash();
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 0.3", background: true })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Started."),
			fauxAssistantMessage("Finished."),
		]);
		await harness.session.prompt("go");
		await harness.session.waitForBackgroundJobs();
		expect(getAssistantTexts(harness)).toEqual(["", "Started.", "Finished."]);
		expect(harness.session.backgroundJobs.running()).toEqual([]);
	});

	it("stops running jobs when the session is disposed", async () => {
		const harness = await harnessWithBash();
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 30", background: true })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Started."),
		]);
		await harness.session.prompt("go");
		const job = harness.session.backgroundJobs.list()[0]!;
		harness.session.dispose();
		await until(() => job.status !== "running");
		expect(job.status).toBe("killed");
	});
});
