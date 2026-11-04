import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CppHipDiagnosticsEngine, FileStateTracker } from "../src/core/harness/index.ts";

interface Addon {
	initLibclang(customPath?: string): boolean;
	checkFileAsync(
		filename: string,
		args: string[],
		unsaved: Array<{ filename: string; content: string }>,
	): Promise<string>;
}

const addonPath = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"native",
	"libclang",
	"prebuilds",
	`${process.platform}-${process.arch}`,
	"libclang-bridge.node",
);
const addon: Addon | undefined = (() => {
	if (!existsSync(addonPath)) return undefined;
	try {
		const loaded = createRequire(import.meta.url)(addonPath) as Addon;
		return loaded.initLibclang() ? loaded : undefined;
	} catch {
		return undefined;
	}
})();

const messages = async (file: string, args: string[], content: string) =>
	(JSON.parse(await addon!.checkFileAsync(file, args, [{ filename: file, content }])) as Array<{ message: string }>)
		.map((d) => d.message)
		.filter((m) => m.includes("value is not 2"))
		.map(() => "value is not 2");

describe.skipIf(!addon)("libclang bridge and C++ engine (real libclang)", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-libclang-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("parses a kept TU again when its flags change, and reparses with the kept flags when none are given", async () => {
		const file = join(dir, "flags.cpp");
		const content = '#if VALUE != 2\n#error "value is not 2"\n#endif\nint main() { return 0; }\n';
		writeFileSync(file, content);
		expect(await messages(file, ["-x", "c++", "-DVALUE=1"], content)).toEqual(["value is not 2"]);
		// The same TU, new flags: a reparse would keep VALUE=1.
		expect(await messages(file, ["-x", "c++", "-DVALUE=2"], content)).toEqual([]);
		expect(await messages(file, [], content)).toEqual([]);
	});

	it("keeps the TUs used last and parses an evicted one again", async () => {
		const content = '#if VALUE != 2\n#error "value is not 2"\n#endif\n';
		const files = Array.from({ length: 10 }, (_, i) => join(dir, `f${i}.cpp`));
		for (const file of files) {
			writeFileSync(file, content);
			expect(await messages(file, ["-x", "c++", "-DVALUE=2"], content)).toEqual([]);
		}
		// f0 was evicted (8 are kept): parsed again with the flags given.
		expect(await messages(files[0], ["-x", "c++", "-DVALUE=2"], content)).toEqual([]);
		expect(await messages(files[9], [], content)).toEqual([]);
	});

	it("checks a header inside the source that includes it through an -I folder, not the last source read", async () => {
		mkdirSync(join(dir, "src"));
		mkdirSync(join(dir, "include", "kernels"), { recursive: true });
		mkdirSync(join(dir, "other"));
		const header = join(dir, "include", "kernels", "gemm.h");
		const source = join(dir, "src", "gemm.cpp");
		const unrelated = join(dir, "other", "unrelated.cpp");
		// The header relies on a type its includer declares first: on its own it does not compile.
		writeFileSync(header, "inline Scalar twice(Scalar x) { return x + x; }\n");
		writeFileSync(
			source,
			'#include <cstddef>\nusing Scalar = float;\n#include "kernels/gemm.h"\nint main() { return 0; }\n',
		);
		writeFileSync(unrelated, "int other() { return 1; }\n");
		writeFileSync(
			join(dir, "compile_commands.json"),
			JSON.stringify([
				{ directory: dir, file: source, arguments: ["clang++", "-std=c++17", "-Iinclude", "-c", source] },
				{ directory: dir, file: unrelated, arguments: ["clang++", "-std=c++17", "-c", unrelated] },
			]),
		);
		const tracker = new FileStateTracker();
		const engine = new CppHipDiagnosticsEngine(tracker);
		try {
			for (const file of [source, header, unrelated]) {
				const text = (await import("node:fs")).readFileSync(file, "utf-8");
				tracker.recordFileRead(file, text, Date.now());
				await engine.warmupFile(file, text, dir);
			}
			const edited = 'inline Scalar twice(Scalar x) { return x + x; }\nint broken = "text";\n';
			const result = await engine.checkEditedFile(header, edited, dir);
			const errors = result.diagnostics.map((d) => d.message);
			expect(errors.some((m) => m.includes("cannot initialize a variable of type 'int'"))).toBe(true);
			// Inside its includer `Scalar` is known: no error for it.
			expect(errors.some((m) => m.includes("Scalar"))).toBe(false);
		} finally {
			engine.dispose();
		}
	});
});
