import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionFactory } from "../../src/core/extensions/types.ts";
import { createHarness, getToolResult, type Harness, type HarnessOptions } from "./harness.ts";

/**
 * The model calls read, then streams more text. While the text streams, an extension changes the file: a read that
 * started when its call ended sees the old content, one that starts after the message sees the new content.
 */
function changeFileDuringText(): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		let changed = false;
		pi.on("message_update", async (event, ctx) => {
			if (changed || event.assistantMessageEvent.type !== "text_delta") return;
			changed = true;
			await new Promise((resolve) => setTimeout(resolve, 100));
			writeFileSync(join(ctx.cwd, "notes.txt"), "new content\n");
		});
	};
}

function readThenText() {
	return [
		fauxAssistantMessage(
			[fauxToolCall("read", { path: "notes.txt" }, { id: "call-read" }), fauxText("Reading the notes file now.")],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("Done."),
	];
}

async function readResult(
	harnesses: Harness[],
	extensions: HarnessOptions["extensionFactories"],
	configure?: (harness: Harness) => void,
): Promise<string> {
	const harness = await createHarness({ initialActiveToolNames: ["read", "ls"], extensionFactories: extensions });
	harnesses.push(harness);
	const file = join(harness.tempDir, "notes.txt");
	writeFileSync(file, "old content\n");
	await harness.session.bindExtensions({});
	configure?.(harness);
	harness.setResponses(readThenText());
	await harness.session.prompt("read the notes");
	return (getToolResult(harness, "read").content[0] as { text: string }).text;
}

describe("AgentSession early tool execution", () => {
	const harnesses: Harness[] = [];

	/** The model runs `command` with bash, then streams text while an extension changes notes.txt. */
	async function bashResult(command: string): Promise<string> {
		const harness = await createHarness({
			initialActiveToolNames: ["read", "bash"],
			extensionFactories: [changeFileDuringText()],
		});
		harnesses.push(harness);
		writeFileSync(join(harness.tempDir, "notes.txt"), "old content\n");
		await harness.session.bindExtensions({});
		harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("bash", { command }, { id: "call-bash" }), fauxText("Reading the notes file now.")],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Done."),
		]);
		await harness.session.prompt("read the notes");
		return (getToolResult(harness, "bash").content[0] as { text: string }).text;
	}

	it("starts a bash call that only reads while the rest of the message streams", async () => {
		expect(await bashResult("cat notes.txt")).toBe("old content\n");
	});

	it("starts other bash calls after the message", async () => {
		expect(await bashResult("cat notes.txt | tee copy.txt")).toBe("new content\n");
	});

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("starts a built-in read call while the rest of the message streams", async () => {
		expect(await readResult(harnesses, [changeFileDuringText()])).toBe("old content\n");
	});

	it("starts read after the message without the early hook", async () => {
		const result = await readResult(harnesses, [changeFileDuringText()], (harness) => {
			harness.session.agent.earlyToolExecution = undefined;
		});
		expect(result).toBe("new content\n");
	});

	it("does not start calls early while an extension handles tool_call", async () => {
		const result = await readResult(harnesses, [
			changeFileDuringText(),
			(pi) => {
				pi.on("tool_call", () => undefined);
			},
		]);
		expect(result).toBe("new content\n");
	});

	it("still starts calls early when only the built-in MCP extension handles tool_call", async () => {
		const result = await readResult(harnesses, [
			changeFileDuringText(),
			{
				path: "builtin:mcp",
				factory: (pi) => {
					pi.on("tool_call", () => undefined);
				},
			},
		]);
		expect(result).toBe("old content\n");
	});

	it("does not start an extension's tool that replaces read early", async () => {
		const result = await readResult(harnesses, [
			changeFileDuringText(),
			(pi) => {
				pi.registerTool({
					name: "read",
					label: "read",
					description: "Read a file.",
					parameters: Type.Object({ path: Type.String() }),
					execute: async (_id, { path }, _signal, _onUpdate, ctx) => {
						return { content: [{ type: "text", text: readFileSync(join(ctx.cwd, path), "utf-8") }], details: {} };
					},
				});
			},
		]);
		expect(result).toBe("new content\n");
	});

	it("writes the same session with and without early execution", async () => {
		const entries: unknown[][] = [];
		for (const early of [true, false]) {
			const harness = await createHarness({ initialActiveToolNames: ["read", "ls"] });
			harnesses.push(harness);
			writeFileSync(join(harness.tempDir, "notes.txt"), "some notes\n");
			if (!early) harness.session.agent.earlyToolExecution = undefined;
			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("read", { path: "notes.txt" }, { id: "call-read" }),
						fauxToolCall("ls", { path: "." }, { id: "call-ls" }),
						fauxToolCall("read", { path: "missing.txt" }, { id: "call-missing" }),
						fauxText("Looking at the files."),
					],
					{ stopReason: "toolUse", timestamp: 1 },
				),
				fauxAssistantMessage("Done.", { timestamp: 2 }),
			]);
			await harness.session.prompt("look around");
			// Without what differs between two runs: ids, times, the faux provider's API name and the temporary folder.
			const json = JSON.stringify(harness.sessionManager.getEntries())
				.replaceAll(harness.faux.api, "<api>")
				.replaceAll(harness.tempDir, "<cwd>");
			const normalized = JSON.parse(json, (key, value) =>
				key === "id" || key === "parentId" || key === "timestamp" || key === "durationMs" ? undefined : value,
			);
			entries.push(normalized);
		}
		expect(entries[0]).toEqual(entries[1]);
		expect(JSON.stringify(entries[0])).toContain("some notes");
	});
});
