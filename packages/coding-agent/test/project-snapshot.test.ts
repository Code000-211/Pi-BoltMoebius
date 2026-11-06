import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { takeProjectSnapshot } from "../src/core/project-snapshot.ts";

describe("project snapshot", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-snapshot-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("lists a small project's files", () => {
		writeFileSync(join(dir, "a.py"), "print('a')\n");
		mkdirSync(join(dir, "src"));
		writeFileSync(join(dir, "src", "b.ts"), "export const b = 1;");
		expect(takeProjectSnapshot(dir)).toBe(
			"The files of the working folder when the session started:\na.py\nsrc/b.ts",
		);
	});

	it("summarizes a large project by folders", () => {
		for (let i = 0; i < 200; i++) {
			mkdirSync(join(dir, "svc", `s${i % 4}`), { recursive: true });
			writeFileSync(join(dir, "svc", `s${i % 4}`, `f${i}.py`), "x = 1\n");
		}
		writeFileSync(join(dir, "README.md"), "hi\n");
		const snapshot = takeProjectSnapshot(dir)!;
		expect(snapshot).toContain("201 files; the folders, with how many files each holds:");
		expect(snapshot).toContain("README.md\nsvc/ (200 files)\nsvc/s0/ (50 files)");
	});

	it("skips build folders, and takes no snapshot of the home folder or an empty one", () => {
		mkdirSync(join(dir, "node_modules", "x"), { recursive: true });
		writeFileSync(join(dir, "node_modules", "x", "i.js"), "1");
		expect(takeProjectSnapshot(dir)).toBeUndefined();
		expect(takeProjectSnapshot(homedir())).toBeUndefined();
	});
});
