import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBashTool } from "../src/core/tools/bash.ts";

function getText(result: { content?: Array<{ type: string; text?: string }> }): string {
	return (result.content ?? []).map((part) => part.text ?? "").join("");
}

function script(path: string, output: string): void {
	writeFileSync(path, `#!/bin/sh\necho ${output}\n`);
	chmodSync(path, 0o755);
}

describe.skipIf(process.platform === "win32")("a simple command started without a shell", () => {
	let dir: string;
	let path: string | undefined;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-direct-"));
		path = process.env.PATH;
	});
	afterEach(() => {
		process.env.PATH = path;
		rmSync(dir, { recursive: true, force: true });
	});

	it("runs a command in the warm shell with the environment as it is now, not as it was when the shell started", async () => {
		// First in this file: the warm shell waits for its own folder, and a later test's folder would leave it unused.
		const bash = createBashTool(dir);
		process.env.PI_TEST_WARM_VARIABLE = "then";
		try {
			await bash.execute("w1", { command: 'echo "[$PI_TEST_WARM_VARIABLE]"' });
			// The next warm shell starts after the call, with the variable.
			await new Promise((resolve) => setTimeout(resolve, 50));
		} finally {
			delete process.env.PI_TEST_WARM_VARIABLE;
		}
		expect(getText(await bash.execute("w2", { command: 'echo "[$PI_TEST_WARM_VARIABLE]"' }))).toBe("[]\n");
	});

	it("runs a program named by a path from the working directory, not one under a PATH folder", async () => {
		mkdirSync(join(dir, "work", "bin"), { recursive: true });
		mkdirSync(join(dir, "prefix", "bin"), { recursive: true });
		script(join(dir, "work", "bin", "tool"), "local");
		script(join(dir, "prefix", "bin", "tool"), "from-path");
		process.env.PATH = `${join(dir, "prefix")}:${path}`;
		const bash = createBashTool(join(dir, "work"));
		expect(getText(await bash.execute("d1", { command: "bin/tool" }))).toBe("local\n");
	});

	it("reports a program removed after it ran as the shell does", async () => {
		mkdirSync(join(dir, "bin"));
		script(join(dir, "bin", "gone-tool"), "here");
		process.env.PATH = `${join(dir, "bin")}:${path}`;
		const bash = createBashTool(dir);
		expect(getText(await bash.execute("d2", { command: "gone-tool" }))).toBe("here\n");
		rmSync(join(dir, "bin", "gone-tool"));
		const missing = await bash.execute("d3", { command: "gone-tool" });
		expect(missing.isError).toBe(true);
		expect(getText(missing)).toMatch(/Command exited with code 127$/);
	});
});
