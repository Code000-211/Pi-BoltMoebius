import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { CompactionEntry } from "../../src/core/session-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

type Internals = {
	_checkCompaction: (assistantMessage: AssistantMessage, skipAbortedCheck?: boolean) => Promise<boolean>;
	_compactionAhead: { result: Promise<unknown> } | undefined;
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

interface Setup {
	harness: Harness;
	internals: Internals;
	/** The summaries requested, in order. */
	summaries: string[];
	/** Holds the summary answers until `release`. */
	hold: () => void;
	release: () => void;
}

/**
 * Window 100k, threshold 99k: the summary starts ahead above 84,150 tokens, and the threshold is the limit. With
 * `thresholdPercent: 50`, the threshold is 50k, the summary starts above 42,500 and the agent goes on to 74,500.
 */
async function setup(compaction: Record<string, number> = {}): Promise<Setup> {
	const harness = await createHarness({
		settings: { compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 1, ...compaction } },
		models: [{ id: "faux-1", contextWindow: 100_000 }],
	});
	const summaries: string[] = [];
	let gate: Promise<void> = Promise.resolve();
	let release = () => {};
	harness.session.agent.streamFunction = (model) => {
		const summary = `summary ${summaries.length + 1}`;
		summaries.push(summary);
		const stream = createAssistantMessageEventStream();
		void gate.then(() => {
			const message: AssistantMessage = {
				...fauxAssistantMessage(summary),
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: usage(10),
			};
			stream.push({ type: "done", reason: "stop", message });
		});
		return stream;
	};
	return {
		harness,
		internals: harness.session as unknown as Internals,
		summaries,
		hold: () => {
			gate = new Promise((resolve) => {
				release = resolve;
			});
		},
		release: () => release(),
	};
}

function turn(harness: Harness, text: string, totalTokens: number): AssistantMessage {
	const model = harness.getModel();
	const now = Date.now();
	harness.sessionManager.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: now });
	const assistant: AssistantMessage = {
		...fauxAssistantMessage(`answer to ${text.slice(0, 10)}`, { stopReason: "stop", timestamp: now + 1 }),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: usage(totalTokens),
	};
	harness.sessionManager.appendMessage(assistant);
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
	return assistant;
}

/** One step of a single long turn: a read and its result. */
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

function compactions(harness: Harness): CompactionEntry[] {
	return harness.sessionManager.getBranch().filter((entry): entry is CompactionEntry => entry.type === "compaction");
}

describe("AgentSession compaction ahead", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		delete process.env.PI_COMPACTION_AHEAD;
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("makes the summary near the threshold and compacts with it at the threshold, without a second request", async () => {
		const { harness, internals, summaries } = await setup();
		harnesses.push(harness);
		const long = "x".repeat(40_000);

		await internals._checkCompaction(turn(harness, `one ${long}`, 50_000));
		expect(internals._compactionAhead).toBeUndefined();

		await internals._checkCompaction(turn(harness, `two ${long}`, 90_000));
		expect(internals._compactionAhead).toBeDefined();
		await internals._compactionAhead?.result;
		expect(summaries).toEqual(["summary 1"]);
		const keptFrom = harness.sessionManager.getBranch().at(-1)?.id;

		// Work goes on after the summary started; it stays after the compaction.
		await internals._checkCompaction(turn(harness, "three", 99_500));
		expect(summaries).toEqual(["summary 1"]);
		const [entry] = compactions(harness);
		expect(entry?.summary).toContain("summary 1");
		const branch = harness.sessionManager.getBranch();
		const kept = branch.findIndex((e) => e.id === entry?.firstKeptEntryId);
		expect(kept).toBeGreaterThan(0);
		expect(kept).toBeLessThanOrEqual(branch.findIndex((e) => e.id === keptFrom));
		expect(internals._compactionAhead).toBeUndefined();
	});

	it("waits for a summary still being made instead of starting another", async () => {
		const { harness, internals, summaries, hold, release } = await setup();
		harnesses.push(harness);
		const long = "x".repeat(40_000);
		await internals._checkCompaction(turn(harness, `one ${long}`, 50_000));
		hold();
		await internals._checkCompaction(turn(harness, `two ${long}`, 90_000));

		const compacting = internals._checkCompaction(turn(harness, "three", 99_500));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(compactions(harness)).toHaveLength(0);
		release();
		await compacting;
		expect(summaries).toEqual(["summary 1"]);
		expect(compactions(harness)[0]?.summary).toContain("summary 1");
	});

	it("goes on above the threshold while the summary is made, and compacts once it is ready", async () => {
		const { harness, internals, summaries, hold, release } = await setup({ thresholdPercent: 50 });
		harnesses.push(harness);
		const long = "x".repeat(40_000);
		await internals._checkCompaction(turn(harness, `one ${long}`, 30_000));
		hold();
		await internals._checkCompaction(turn(harness, `two ${long}`, 45_000));
		expect(internals._compactionAhead).toBeDefined();

		await expect(internals._checkCompaction(turn(harness, "three", 55_000))).resolves.toBe(false);
		expect(compactions(harness)).toHaveLength(0);
		release();
		await internals._compactionAhead?.result;
		await internals._checkCompaction(turn(harness, "four", 60_000));
		expect(summaries).toEqual(["summary 1"]);
		expect(compactions(harness)[0]?.summary).toContain("summary 1");
	});

	it("waits for the summary when the context gets too far above the threshold", async () => {
		const { harness, internals, summaries, hold, release } = await setup({ thresholdPercent: 50 });
		harnesses.push(harness);
		const long = "x".repeat(40_000);
		await internals._checkCompaction(turn(harness, `one ${long}`, 30_000));
		hold();
		await internals._checkCompaction(turn(harness, `two ${long}`, 45_000));
		const compacting = internals._checkCompaction(turn(harness, "three", 80_000));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(compactions(harness)).toHaveLength(0);
		release();
		await compacting;
		expect(summaries).toEqual(["summary 1"]);
		expect(compactions(harness)[0]?.summary).toContain("summary 1");
	});

	it("makes the summary within one long turn, whose start the compaction cuts", async () => {
		const { harness, internals, summaries } = await setup({ thresholdPercent: 50 });
		harnesses.push(harness);
		harness.sessionManager.appendMessage({ role: "user", content: "read them all", timestamp: Date.now() });
		for (let n = 1; n <= 8; n++) await internals._checkCompaction(step(harness, n, n * 5_500));
		expect(internals._compactionAhead).toBeDefined();
		await internals._compactionAhead?.result;
		await internals._checkCompaction(step(harness, 9, 60_000));
		expect(summaries).toEqual(["summary 1"]);
		expect(compactions(harness)[0]?.summary).toContain("summary 1");
	});

	it("in a run, the agent works on while the summary is made and does not stop at the threshold", async () => {
		const harness = await createHarness({
			settings: { compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 1, thresholdPercent: 50 } },
			models: [{ id: "faux-1", contextWindow: 100_000 }],
			initialActiveToolNames: ["read"],
		});
		harnesses.push(harness);
		for (let n = 1; n <= 12; n++) writeFileSync(join(harness.tempDir, `f${n}.txt`), "y".repeat(20_000));
		let release = () => {};
		const summaryGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const requests: string[] = [];
		let reads = 0;
		const respond: FauxResponseStep = async (context) => {
			const last = JSON.stringify(context.messages.at(-1));
			if (last.includes("being compacted") || last.includes("summar")) {
				requests.push("summary");
				await summaryGate;
				return fauxAssistantMessage("the summary");
			}
			reads++;
			requests.push(`turn ${reads}`);
			// The summary is ready from the 11th turn on.
			if (reads === 11) release();
			const message =
				reads <= 11
					? fauxAssistantMessage([fauxToolCall("read", { path: `f${reads}.txt` })], { stopReason: "toolUse" })
					: fauxAssistantMessage("done");
			return { ...message, usage: usage(reads * 5_500) };
		};
		harness.setResponses(Array.from({ length: 20 }, () => respond));
		await harness.session.prompt("read f1.txt to f11.txt, one at a time");

		const summary = requests.indexOf("summary");
		expect(summary).toBeGreaterThan(0);
		// Turn 11 lets the summary finish: had the agent stopped for it above the threshold of 50k (from turn 10 on),
		// turn 11 would never have come.
		expect(requests.filter((r) => r === "summary")).toHaveLength(1);
		expect(requests.slice(summary + 1)).toContain("turn 11");
		expect(compactions(harness)).toHaveLength(1);
		expect(compactions(harness)[0]?.summary).toContain("the summary");
		expect(harness.session.getLastAssistantText()).toBe("done");
	});

	it("drops the summary made ahead when the session was compacted since", async () => {
		const { harness, internals, summaries } = await setup();
		harnesses.push(harness);
		const long = "x".repeat(40_000);
		await internals._checkCompaction(turn(harness, `one ${long}`, 50_000));
		await internals._checkCompaction(turn(harness, `two ${long}`, 90_000));
		await internals._compactionAhead?.result;
		await harness.session.compact();
		expect(summaries).toEqual(["summary 1", "summary 2"]);

		await internals._checkCompaction(turn(harness, `three ${long}`, 99_500));
		expect(summaries).toEqual(["summary 1", "summary 2", "summary 3"]);
		expect(compactions(harness).at(-1)?.summary).toContain("summary 3");
	});

	it("does not make one when turned off", async () => {
		process.env.PI_COMPACTION_AHEAD = "off";
		const { harness, internals, summaries } = await setup();
		harnesses.push(harness);
		const long = "x".repeat(40_000);
		await internals._checkCompaction(turn(harness, `one ${long}`, 50_000));
		await internals._checkCompaction(turn(harness, `two ${long}`, 90_000));
		expect(internals._compactionAhead).toBeUndefined();
		expect(summaries).toEqual([]);
	});
});
