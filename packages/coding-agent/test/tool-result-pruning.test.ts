import type { Message, ToolResultMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { pruneToolResults, type ToolResultPruningSettings } from "../src/core/tool-result-pruning.ts";

const settings: ToolResultPruningSettings = { enabled: true, triggerTokens: 1000, keepRecent: 2, minChars: 100 };

function call(id: number): Message {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: `call-${id}`, name: "read", arguments: { path: `f${id}` } }],
		api: "openai-completions",
		provider: "test",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 0,
	};
}

function result(id: number, chars: number): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: `call-${id}`,
		toolName: "read",
		content: [{ type: "text", text: "x".repeat(chars) }],
		isError: false,
		timestamp: 0,
	};
}

/** A conversation of `n` tool calls; result `small` is short, the others 1000 characters. */
function conversation(n: number, small = -1): Message[] {
	const messages: Message[] = [{ role: "user", content: "go", timestamp: 0 }];
	for (let i = 0; i < n; i++) messages.push(call(i), result(i, i === small ? 50 : 1000));
	return messages;
}

const text = (message: Message) =>
	message.role === "toolResult" && message.content[0]?.type === "text" ? message.content[0].text : "";

describe("pruneToolResults", () => {
	it("leaves the context alone below the trigger, with too few results, or when disabled", () => {
		const few = conversation(3);
		expect(pruneToolResults(few, settings)).toBe(few);
		const small = conversation(8);
		expect(pruneToolResults(small, { ...settings, triggerTokens: 100_000 })).toBe(small);
		expect(pruneToolResults(small, { ...settings, enabled: false })).toBe(small);
	});

	it("clears old large results, keeps small ones and the recent ones", () => {
		const messages = conversation(6, 1);
		const pruned = pruneToolResults(messages, settings);
		const results = pruned.filter((m) => m.role === "toolResult");
		// 6 results, keepRecent 2: the first 4 are old; result 1 is small.
		expect(text(results[0])).toBe(
			"[Old read result cleared from the context to save space (1000 characters). Run the tool again if you need it.]",
		);
		expect(results[1]).toBe(messages[4]);
		expect(text(results[2])).toMatch(/^\[Old read result cleared/);
		expect(text(results[3])).toMatch(/^\[Old read result cleared/);
		expect(results[4]).toBe(messages[10]);
		expect(results[5]).toBe(messages[12]);
		// Tool calls and their ids stay, so the provider still pairs them.
		expect(pruned[1]).toBe(messages[1]);
		expect((results[0] as ToolResultMessage).toolCallId).toBe("call-0");
		// The session's messages are not changed.
		expect(text(messages[2])).toHaveLength(1000);
	});

	it("moves the boundary in steps, so the cleared prefix stays the same objects", () => {
		const messages = conversation(9);
		const first = pruneToolResults(messages.slice(0, 1 + 2 * 6), settings);
		const second = pruneToolResults(messages.slice(0, 1 + 2 * 7), settings);
		const third = pruneToolResults(messages, settings);
		const cleared = (list: Message[]) =>
			list.filter((m) => m.role === "toolResult" && text(m).startsWith("[Old")).length;
		// 6 and 7 results clear 4; 9 clear 6.
		expect(cleared(first)).toBe(4);
		expect(cleared(second)).toBe(4);
		expect(cleared(third)).toBe(6);
		for (let i = 0; i < first.length; i++) expect(second[i]).toBe(first[i]);
		for (let i = 0; i < 9; i++) expect(third[i]).toBe(first[i]);
	});

	it("clears images whatever their size", () => {
		const messages = conversation(4);
		const image: ToolResultMessage = {
			...result(0, 0),
			content: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
		};
		messages[2] = image;
		const pruned = pruneToolResults(messages, { ...settings, triggerTokens: 0 });
		expect(text(pruned[2])).toContain("(1 image(s))");
	});

	it("reads its settings with defaults", () => {
		expect(SettingsManager.inMemory({}).getToolResultPruningSettings()).toEqual({
			enabled: true,
			triggerTokens: 40000,
			keepRecent: 8,
			minChars: 2000,
		});
		expect(
			SettingsManager.inMemory({
				toolResultPruning: { enabled: false, keepRecent: 0, minChars: 500 },
			}).getToolResultPruningSettings(),
		).toEqual({ enabled: false, triggerTokens: 40000, keepRecent: 8, minChars: 500 });
	});
});
