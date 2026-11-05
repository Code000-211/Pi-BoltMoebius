import type { AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { estimateTokens } from "../src/core/compaction/index.ts";
import { type CompactionSummaryMessage, convertToLlm } from "../src/core/messages.ts";
import { SessionManager } from "../src/core/session-manager.ts";

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "faux",
		provider: "faux",
		model: "faux",
		usage: {
			input: 10,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 11,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

const TICKET = "Rename foo to bar in src/a.ts. Do not touch tests/. Keep the public API.";

/** A ticket, its work, a follow-up from the user, a harness message, then a compaction that keeps only the last reply. */
function compactedSession(): SessionManager {
	const session = SessionManager.inMemory();
	session.appendMessage({ role: "user", content: [{ type: "text", text: TICKET }], timestamp: Date.now() });
	session.appendMessage(assistant("working"));
	session.appendMessage({ role: "user", content: "also update NOTES.md", timestamp: Date.now() });
	session.appendCustomMessageEntry("check-report", "src/a.ts:3 error", false);
	const keptId = session.appendMessage(assistant("done"));
	session.appendCompaction("The user asked for a rename.", keptId, 5000);
	return session;
}

function summary(session: SessionManager): CompactionSummaryMessage {
	const message = session.buildSessionProjection().messages.find((m) => m.role === "compactionSummary");
	return message as CompactionSummaryMessage;
}

describe("the user's messages beside a compaction summary", () => {
	afterEach(() => {
		delete process.env.PI_COMPACTION_USER_MESSAGES;
	});

	it("keeps the user's own compacted messages verbatim, oldest first, and not the harness's", () => {
		const message = summary(compactedSession());
		expect(message.userRequests).toEqual([TICKET, "also update NOTES.md"]);
		const llm = convertToLlm([message])[0]!;
		const text = (llm.content as Array<{ type: string; text: string }>)[0]!.text;
		expect(text).toContain("<summary>\nThe user asked for a rename.");
		expect(text).toContain(`<user-message>\n${TICKET}\n</user-message>`);
		expect(text).not.toContain("src/a.ts:3 error");
		expect(estimateTokens(message)).toBe(Math.ceil(text.length / 4));
	});

	it("keeps them through a second compaction", () => {
		const session = compactedSession();
		session.appendMessage({ role: "user", content: "and run the tests", timestamp: Date.now() });
		const keptId = session.appendMessage(assistant("tests pass"));
		session.appendCompaction("Rename done, tests run.", keptId, 6000);
		expect(summary(session).userRequests).toEqual([TICKET, "also update NOTES.md", "and run the tests"]);
	});

	it("leaves out user messages the compaction kept", () => {
		const session = SessionManager.inMemory();
		session.appendMessage({ role: "user", content: TICKET, timestamp: Date.now() });
		session.appendMessage(assistant("working"));
		const keptId = session.appendMessage({ role: "user", content: "kept request", timestamp: Date.now() });
		session.appendMessage(assistant("ok"));
		session.appendCompaction("summary", keptId, 5000);
		expect(summary(session).userRequests).toEqual([TICKET]);
	});

	it("cuts what goes beyond the limit and says so", () => {
		const session = SessionManager.inMemory();
		session.appendMessage({ role: "user", content: "x".repeat(20_000), timestamp: Date.now() });
		session.appendMessage({ role: "user", content: "later", timestamp: Date.now() });
		const keptId = session.appendMessage(assistant("ok"));
		session.appendCompaction("summary", keptId, 5000);
		const requests = summary(session).userRequests!;
		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatch(/^x{16000}\n\[cut here: the rest is in the summary\]$/);
	});

	it("leaves an extension's own compaction as the extension wrote it", () => {
		const session = SessionManager.inMemory();
		session.appendMessage({ role: "user", content: TICKET, timestamp: Date.now() });
		const keptId = session.appendMessage(assistant("ok"));
		session.appendCompaction("exact handoff", keptId, 5000, undefined, true);
		expect(summary(session).userRequests).toBeUndefined();
	});

	it("is off with PI_COMPACTION_USER_MESSAGES=off", () => {
		process.env.PI_COMPACTION_USER_MESSAGES = "off";
		expect(summary(compactedSession()).userRequests).toBeUndefined();
	});
});
