import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BackgroundChecks } from "../src/core/checks/background-checks.ts";
import { CHECKERS, type Checker, enabledCheckers, onPath } from "../src/core/checks/checkers.ts";
import type { HarnessDiagnostic } from "../src/core/harness/file-state-tracker.ts";

/** A checker over `*.fake` files whose errors are what `errors` holds when it runs, after `delayMs`. */
function fakeChecker(errors: Map<string, string[]>, delayMs = 0, runs: string[] = []): Checker {
	const checker: Checker = {
		name: "fake",
		matches: (path) => path.endsWith(".fake"),
		unit: (path) => ({ key: `fake:${path}`, checker, cwd: "/p", file: path }),
		async run(unit) {
			runs.push(unit.file!);
			await new Promise((resolve) => setTimeout(resolve, delayMs));
			return (errors.get(unit.file!) ?? []).map(
				(message, i): HarnessDiagnostic => ({ file: unit.file!, line: i + 1, column: 1, severity: "error", message }),
			);
		},
	};
	return checker;
}

describe("background checks", () => {
	it("reports only errors that are new against the baseline taken when the file was read", async () => {
		const errors = new Map([["/p/a.fake", ["old problem"]]]);
		const reports: string[] = [];
		const checks = new BackgroundChecks({ cwd: "/p", report: (t) => reports.push(t), checkers: [fakeChecker(errors)] });
		checks.onRead("/p/a.fake");
		await new Promise((resolve) => setTimeout(resolve, 20));
		errors.set("/p/a.fake", ["old problem", "new problem"]);
		checks.onEdited("/p/a.fake");
		expect(checks.busy).toBe(true);
		await checks.waitForIdle(2000);
		expect(reports).toHaveLength(1);
		expect(reports[0]).toContain("a.fake:2:1: new problem");
		expect(reports[0]).not.toContain("old problem");
		// The same error again is not new; a clean file reports nothing.
		checks.onEdited("/p/a.fake");
		await checks.waitForIdle(2000);
		errors.set("/p/a.fake", []);
		checks.onEdited("/p/a.fake");
		await checks.waitForIdle(2000);
		expect(reports).toHaveLength(1);
		checks.dispose();
	});

	it("without a baseline counts only errors in the files edited", async () => {
		const reports: string[] = [];
		const checker: Checker = {
			name: "project",
			matches: (path) => path.endsWith(".fake"),
			unit: () => ({ key: "project", checker, cwd: "/p" }),
			run: async () => [
				{ file: "/p/edited.fake", line: 3, column: 2, severity: "error", message: "broken here" },
				{ file: "/p/other.fake", line: 1, column: 1, severity: "error", message: "maybe old" },
			],
		};
		const checks = new BackgroundChecks({ cwd: "/p", report: (t) => reports.push(t), checkers: [checker] });
		checks.onEdited("/p/edited.fake");
		await checks.waitForIdle(2000);
		expect(reports).toEqual([expect.stringContaining("edited.fake:3:2: broken here")]);
		expect(reports[0]).not.toContain("other.fake");
		checks.dispose();
	});

	it("runs again instead of reporting when an edit overtook the running check, and settles quick edits into one run", async () => {
		const errors = new Map<string, string[]>();
		const runs: string[] = [];
		const reports: string[] = [];
		const checks = new BackgroundChecks({
			cwd: "/p",
			report: (t) => reports.push(t),
			checkers: [fakeChecker(errors, 80, runs)],
		});
		errors.set("/p/a.fake", ["first state"]);
		checks.onEdited("/p/a.fake");
		checks.onEdited("/p/a.fake");
		await new Promise((resolve) => setTimeout(resolve, 200));
		errors.set("/p/a.fake", ["second state"]);
		checks.onEdited("/p/a.fake");
		await checks.waitForIdle(3000);
		expect(runs).toHaveLength(2);
		expect(reports.join("\n")).toContain("second state");
		expect(reports.join("\n")).not.toContain("first state");
		checks.dispose();
	});

	it("does not wait for a check that only takes the baseline", async () => {
		const checks = new BackgroundChecks({
			cwd: "/p",
			report: () => {},
			checkers: [fakeChecker(new Map(), 500)],
		});
		checks.onRead("/p/a.fake");
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(checks.busy).toBe(false);
		checks.dispose();
	});

	it("reads PI_CHECKS: all by default, none for off, else the names given", () => {
		expect(enabledCheckers(undefined)).toBe(CHECKERS);
		expect(enabledCheckers("off")).toEqual([]);
		expect(enabledCheckers("rust, python").map((c) => c.name)).toEqual(["rust", "python"]);
	});
});

describe("the checkers, with their tools where installed", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-checks-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	async function errorsOf(file: string, content: string): Promise<HarnessDiagnostic[]> {
		const path = join(dir, file);
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, content);
		const checker = CHECKERS.find((c) => c.matches(path))!;
		const unit = checker.unit(path);
		if (!unit) return [];
		return await checker.run(unit, new AbortController().signal);
	}

	it("finds a JSON syntax error in the process", async () => {
		const [d] = await errorsOf("a.json", '{"a": 1,}');
		expect(d?.severity).toBe("error");
		expect(await errorsOf("b.json", '{"a": 1}')).toEqual([]);
	});

	it.skipIf(!onPath("ty"))("finds a Python type error with ty", async () => {
		writeFileSync(join(dir, "pyproject.toml"), '[project]\nname = "t"\nversion = "0"\n');
		const errors = await errorsOf("a.py", 'def f(x: int) -> int:\n    return x\n\nf("a")\n');
		expect(errors).toEqual([expect.objectContaining({ file: join(dir, "a.py"), line: 4, code: "invalid-argument-type" })]);
	});

	it.skipIf(!onPath("tsc"))("finds a TypeScript type error with tsc", async () => {
		writeFileSync(join(dir, "tsconfig.json"), '{"compilerOptions":{"strict":true,"noEmit":true}}');
		const errors = await errorsOf("a.ts", 'export const n: number = "x";\n');
		expect(errors).toEqual([expect.objectContaining({ file: join(dir, "a.ts"), line: 1, code: "TS2322" })]);
	});

	it.skipIf(!onPath("cargo"))("finds a Rust type error with cargo check", { timeout: 120_000 }, async () => {
		writeFileSync(join(dir, "Cargo.toml"), '[package]\nname = "t"\nversion = "0.1.0"\nedition = "2021"\n');
		const errors = await errorsOf("src/lib.rs", "pub fn f() -> u32 { String::new() }\n");
		expect(errors).toEqual([expect.objectContaining({ file: join(dir, "src", "lib.rs"), line: 1, code: "E0308" })]);
	});

	it.skipIf(!onPath("bash"))("finds a shell syntax error with bash -n", async () => {
		const [d] = await errorsOf("a.sh", 'echo "unterminated\n');
		expect(d?.line).toBeGreaterThan(0);
		expect(await errorsOf("b.sh", "echo fine\n")).toEqual([]);
	});

	it.skipIf(!onPath("luau-analyze"))("finds Luau syntax errors always and type errors only under --!strict", async () => {
		expect(await errorsOf("a.luau", "local x = \n")).toEqual([expect.objectContaining({ code: "SyntaxError" })]);
		expect(await errorsOf("b.luau", "local y = card.title\nreturn y\n")).toEqual([]);
		expect(await errorsOf("c.luau", '--!strict\nlocal x: number = "a"\nreturn x\n')).toEqual([
			expect.objectContaining({ code: "TypeError", line: 2 }),
		]);
	});

	it.skipIf(!onPath("node"))("finds a JavaScript syntax error with node --check", async () => {
		expect(await errorsOf("a.js", "const a = ;\n")).toEqual([expect.objectContaining({ line: 1 })]);
	});
});
