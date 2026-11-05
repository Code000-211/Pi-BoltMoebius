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

	it("lists a small project's files with the contents of the small ones, and names those left out", () => {
		writeFileSync(join(dir, "a.py"), "print('a')\n");
		mkdirSync(join(dir, "src"));
		writeFileSync(join(dir, "src", "b.ts"), "export const b = 1;");
		writeFileSync(join(dir, "big.c"), "x".repeat(10_000));
		const snapshot = takeProjectSnapshot(dir)!;
		expect(snapshot.text).toContain("a.py\nbig.c\nsrc/b.ts\n");
		expect(snapshot.text).toContain("--- a.py\nprint('a')\n");
		expect(snapshot.text).toContain("--- src/b.ts\nexport const b = 1;\n");
		expect(snapshot.text).toContain("Not included (read them when needed): big.c");
		expect([...snapshot.inlined.keys()].sort()).toEqual([join(dir, "a.py"), join(dir, "src", "b.ts")]);
	});

	it("summarizes a large project by folders, without contents", () => {
		for (let i = 0; i < 200; i++) {
			mkdirSync(join(dir, "svc", `s${i % 4}`), { recursive: true });
			writeFileSync(join(dir, "svc", `s${i % 4}`, `f${i}.py`), "x = 1\n");
		}
		writeFileSync(join(dir, "README.md"), "hi\n");
		const snapshot = takeProjectSnapshot(dir)!;
		expect(snapshot.text).toContain("201 files; the folders, with how many files each holds:");
		expect(snapshot.text).toContain("README.md\nsvc/ (200 files)\nsvc/s0/ (50 files)");
		expect(snapshot.inlined.size).toBe(0);
	});

	it("skips build folders, and takes no snapshot of the home folder or an empty one", () => {
		mkdirSync(join(dir, "node_modules", "x"), { recursive: true });
		writeFileSync(join(dir, "node_modules", "x", "i.js"), "1");
		expect(takeProjectSnapshot(dir)).toBeUndefined();
		expect(takeProjectSnapshot(homedir())).toBeUndefined();
	});
});
