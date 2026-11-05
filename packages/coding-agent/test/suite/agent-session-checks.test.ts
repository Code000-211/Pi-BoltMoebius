import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { CHECK_REPORT_MESSAGE_TYPE } from "../../src/core/agent-session.ts";
import { createHarness, type Harness } from "./harness.ts";

function reports(harness: Harness): string[] {
	return harness.session.messages
		.filter((m) => m.role === "custom" && m.customType === CHECK_REPORT_MESSAGE_TYPE)
		.map((m) => (m.role === "custom" && typeof m.content === "string" ? m.content : ""));
}

describe("AgentSession background checks", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("waits for the check of an edit before the run ends, and goes on with its report", async () => {
		const harness = await createHarness({ initialActiveToolNames: ["write"] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: "config.json", content: '{"a": 1,}' })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Done."),
			fauxAssistantMessage([fauxToolCall("write", { path: "config.json", content: '{"a": 1}' })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Fixed."),
		]);
		await harness.session.prompt("write the config");
		expect(harness.getPendingResponseCount()).toBe(0);
		const found = reports(harness);
		expect(found).toHaveLength(1);
		expect(found[0]).toMatch(/config\.json:1:\d+: .*\(json check|json check/);
		expect(harness.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
	});

	it("ends the run as before when the edits check clean", async () => {
		const harness = await createHarness({ initialActiveToolNames: ["write"] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: "ok.json", content: '{"a": 1}' })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Done."),
			fauxAssistantMessage("never reached"),
		]);
		await harness.session.prompt("write it");
		expect(reports(harness)).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(1);
	});
});
