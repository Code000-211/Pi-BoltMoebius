import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	type Message,
	type Model,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

/**
 * Every request a session sends must start with the previous one, byte for byte, or the provider's prompt cache is
 * read only up to where they part (deepseek-harness checks the same). Checked on the session's messages and on the
 * payloads two providers build from them, without sending anything.
 */

const anthropic: Model<"anthropic-messages"> = {
	id: "claude-test",
	name: "Claude Test",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "http://127.0.0.1:9",
	reasoning: false,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 8192,
};

const completions: Model<"openai-completions"> = {
	id: "test-model",
	name: "Test",
	api: "openai-completions",
	provider: "test-completions",
	baseUrl: "http://127.0.0.1:9/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
};

class Captured extends Error {}

/** The payload `model`'s provider would send for `context`, as if the session ran on it. */
async function payloadOf(model: Model<any>, context: TranscriptContext): Promise<Record<string, unknown>> {
	let payload: Record<string, unknown> | undefined;
	const messages = context.messages.map((message) =>
		message.role === "assistant"
			? { ...message, api: model.api, provider: model.provider, model: model.id }
			: message,
	) as Message[];
	const stream = streamSimple(
		model,
		{ ...context, messages },
		{
			apiKey: "fake-key",
			sessionId: "prefix-test",
			onPayload: (value) => {
				payload = value as Record<string, unknown>;
				throw new Captured();
			},
		},
	);
	await stream.result();
	if (!payload) throw new Error("no payload captured");
	// Cache markers move to the latest messages on every request: they are not part of the cached text.
	return JSON.parse(JSON.stringify(payload, (key, value) => (key === "cache_control" ? undefined : value)));
}

/** A payload's messages as (role, content block) pairs: providers merge a turn's parts into one message. */
function blocks(messages: unknown): string[] {
	return (messages as Array<{ role: string; content?: unknown }>).flatMap((message) => {
		const content = message.content;
		const parts = Array.isArray(content) ? content : [content ?? { ...message, role: undefined }];
		return parts.map((part) => JSON.stringify([message.role, part]));
	});
}

describe("requests of a session", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function run(): Promise<{ harness: Harness; contexts: TranscriptContext[] }> {
		const harness = await createHarness({
			initialActiveToolNames: ["read", "bash", "edit"],
			settings: { toolResultPruning: { enabled: false } },
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		writeFileSync(join(harness.tempDir, "notes.txt"), "hello\n");
		const contexts: TranscriptContext[] = [];
		const stream = harness.session.agent.streamFunction;
		harness.session.agent.streamFunction = (model, context, options) => {
			contexts.push(structuredClone(context));
			return stream(model, context, options);
		};
		harness.setResponses([
			fauxAssistantMessage([fauxText("Reading."), fauxToolCall("read", { path: "notes.txt" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(
				[fauxToolCall("bash", { command: "echo one" }), fauxToolCall("bash", { command: "echo two" })],
				{
					stopReason: "toolUse",
				},
			),
			fauxAssistantMessage("Done with the first."),
			fauxAssistantMessage([fauxToolCall("bash", { command: "cat notes.txt | wc -l" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Done with the second."),
		]);
		await harness.session.prompt("first task");
		await harness.session.prompt("second task");
		return { harness, contexts };
	}

	it("each start with the previous request", async () => {
		const { contexts } = await run();
		expect(contexts).toHaveLength(5);
		for (let i = 1; i < contexts.length; i++) {
			const previous = contexts[i - 1].messages;
			expect(contexts[i].messages.slice(0, previous.length), `request ${i + 1}`).toEqual(previous);
		}
	});

	it("each start with the previous request in the payloads providers build", async () => {
		const { contexts } = await run();
		for (const model of [anthropic, completions]) {
			const payloads = await Promise.all(contexts.map((context) => payloadOf(model, context)));
			for (let i = 1; i < payloads.length; i++) {
				const [previous, next] = [payloads[i - 1], payloads[i]];
				const label = `${model.api}, request ${i + 1}`;
				expect(next.system, label).toEqual(previous.system);
				expect(next.tools, label).toEqual(previous.tools);
				const before = blocks(previous.messages);
				expect(blocks(next.messages).slice(0, before.length), label).toEqual(before);
			}
		}
	});

	it("declare the built-in tools as snapshotted", async () => {
		const { harness } = await run();
		const schemas = harness.session.agent.state.tools.map(({ name, description, parameters }) => ({
			name,
			description,
			parameters,
		}));
		await expect(`${JSON.stringify(schemas, null, 2)}\n`).toMatchFileSnapshot("__snapshots__/tool-schemas.json");
	});
});
