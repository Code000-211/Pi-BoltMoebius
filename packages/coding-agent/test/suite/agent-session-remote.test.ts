import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFakeSsh } from "../fake-ssh.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

describe("AgentSession on a remote machine", () => {
	let remoteDir: string;
	let sshDir: string;
	let savedSsh: string | undefined;
	const harnesses: Harness[] = [];
	beforeEach(() => {
		remoteDir = mkdtempSync(join(tmpdir(), "pi-remote-dir-"));
		sshDir = mkdtempSync(join(tmpdir(), "pi-fake-ssh-"));
		savedSsh = process.env.PI_SSH_COMMAND;
		process.env.PI_SSH_COMMAND = writeFakeSsh(sshDir);
	});
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		if (savedSsh === undefined) delete process.env.PI_SSH_COMMAND;
		else process.env.PI_SSH_COMMAND = savedSsh;
		rmSync(remoteDir, { recursive: true, force: true });
		rmSync(sshDir, { recursive: true, force: true });
	});

	const toolResults = (harness: Harness) =>
		harness.session.messages
			.filter((m) => m.role === "toolResult")
			.map((m) => ({ text: getMessageText(m), error: m.isError }));

	it("lets go of the connections it no longer uses, also when a folder there cannot be reached", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.setSecretPrompt(async () => undefined);
		// The askpass bridges' folders go here, away from those of other tests.
		const savedTmp = process.env.TMPDIR;
		process.env.TMPDIR = mkdtempSync(join(tmpdir(), "pi-bridges-"));
		const bridgesDir = process.env.TMPDIR;
		try {
			await harness.session.setRemote({ host: "fake", dir: remoteDir });
			await harness.session.setRemote({ host: "fake", dir: sshDir });
			await expect(harness.session.setRemote({ host: "fake", dir: join(remoteDir, "missing") })).rejects.toThrow();
			await harness.session.setRemote(undefined);
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect(readdirSync(bridgesDir)).toEqual([]);
		} finally {
			process.env.TMPDIR = savedTmp;
			if (savedTmp === undefined) delete process.env.TMPDIR;
			rmSync(bridgesDir, { recursive: true, force: true });
		}
	});

	it("runs read, edit, write and bash there, with their checks, and turns the local search tools off meanwhile", async () => {
		const harness = await createHarness({
			initialActiveToolNames: ["read", "edit", "write", "bash", "grep", "find", "ls"],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		writeFileSync(join(remoteDir, "a.txt"), "one\ntwo\n");
		writeFileSync(join(remoteDir, "c.txt"), "alpha\n");

		await harness.session.setRemote({ host: "fake", dir: remoteDir });
		expect(harness.session.getActiveToolNames()).toEqual(["read", "edit", "write", "bash"]);
		expect(harness.session.remote).toMatchObject({ host: "fake", resolvedDir: remoteDir });

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "a.txt" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("edit", { path: "a.txt", edits: [{ oldText: "one", newText: "ONE" }] })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("bash", { command: "pwd; cat a.txt" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("bash", { command: "sed -i s/two/TWO/ a.txt" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(
				[fauxToolCall("edit", { path: "c.txt", edits: [{ oldText: "alpha  ", newText: "beta" }] })],
				{
					stopReason: "toolUse",
				},
			),
			fauxAssistantMessage([fauxToolCall("write", { path: "new/b.txt", content: "made there\n" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Done."),
		]);
		await harness.session.prompt("work there");

		const results = toolResults(harness);
		expect(results[0]?.text).toContain("one");
		expect(results[1]).toMatchObject({ error: false });
		expect(results[2]?.text).toContain(remoteDir);
		expect(results[2]?.text).toContain("ONE\ntwo");
		expect(results[3]).toMatchObject({ error: true });
		expect(results[3]?.text).toMatch(/^Not run: the command changes a\.txt \(sed -i\)/);
		// Not read, and not an exact match: refused, as on this machine.
		expect(results[4]).toMatchObject({ error: true });
		expect(results[4]?.text).toContain("File has not been read yet");
		expect(readFileSync(join(remoteDir, "a.txt"), "utf-8")).toBe("ONE\ntwo\n");
		expect(readFileSync(join(remoteDir, "new", "b.txt"), "utf-8")).toBe("made there\n");
		expect(existsSync(join(harness.tempDir, "new", "b.txt"))).toBe(false);

		const prompt = harness.session.systemPrompt;
		expect(prompt).toContain("<remote>");
		expect(prompt).toContain(`${remoteDir} on fake (over ssh)`);
		expect(
			harness.sessionManager.getEntries().filter((e) => e.type === "custom" && e.customType === "remote"),
		).toHaveLength(1);

		await harness.session.setRemote(undefined);
		expect(harness.session.getActiveToolNames()).toEqual(["read", "edit", "write", "bash", "grep", "find", "ls"]);
		expect(harness.session.systemPrompt).not.toContain("<remote>");
	});

	it("refuses a folder it cannot reach and stays on this machine", async () => {
		const harness = await createHarness({ initialActiveToolNames: ["read", "bash", "grep"] });
		harnesses.push(harness);
		await expect(harness.session.setRemote({ host: "fake", dir: join(remoteDir, "missing") })).rejects.toThrow(
			/^Folder .*missing on fake:/,
		);
		expect(harness.session.remote).toBeUndefined();
		expect(harness.session.getActiveToolNames()).toEqual(["read", "bash", "grep"]);
	});
});
