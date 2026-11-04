import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

describe("AgentSession: a response's calls run in order when one changes files", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("runs an edit and the command after it in order, even when the command started early", async () => {
		// Streamed slowly, so that `cat` (a read-only command) starts while the message streams, before the edit.
		const harness = await createHarness({ initialActiveToolNames: ["read", "edit", "bash"], tokensPerSecond: 200 });
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const file = join(harness.tempDir, "a.txt");
		writeFileSync(file, "old\n");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "a.txt" })], { stopReason: "toolUse" }),
			fauxAssistantMessage(
				[
					fauxToolCall("edit", { path: "a.txt", edits: [{ oldText: "old", newText: "new" }] }),
					fauxToolCall("bash", { command: "cat a.txt" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Done."),
		]);
		await harness.session.prompt("change it and show it");
		expect(readFileSync(file, "utf-8")).toBe("new\n");
		const bash = harness.session.messages.find((m) => m.role === "toolResult" && m.toolName === "bash");
		expect(bash && getMessageText(bash)).toBe("new\n");
	});
});
