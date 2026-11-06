import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BackgroundChecks } from "../src/core/checks/background-checks.ts";
import { CHECKERS, type Checker, type Diagnostic, enabledCheckers, onPath, run } from "../src/core/checks/checkers.ts";
import { cppChecker } from "../src/core/checks/cpp/checker.ts";
import { FileTracker } from "../src/core/file-tracking/file-tracker.ts";

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
				(message, i): Diagnostic => ({
					file: unit.file!,
					line: i + 1,
					column: 1,
					severity: "error",
					message,
				}),
			);
		},
	};
	return checker;
}

describe("background checks", () => {
	it("reports only errors that are new against the baseline taken when the file was read", async () => {
		const errors = new Map([["/p/a.fake", ["old problem"]]]);
		const reports: string[] = [];
		const checks = new BackgroundChecks({
			cwd: "/p",
			report: (t) => reports.push(t),
			checkers: [fakeChecker(errors)],
		});
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

	it("keeps lint findings for when the run would end, against the state before the first edit, and reports each once", async () => {
		const reports: string[] = [];
		const findings = new Map<string, Diagnostic[]>();
		const lint = (message: string): Diagnostic => ({
			file: "/p/a.fake",
			line: 1,
			column: 1,
			severity: "warning",
			message,
		});
		const checker: Checker = {
			name: "linter",
			matches: (path) => path.endsWith(".fake"),
			unit: (path) => ({ key: "lint", checker, cwd: "/p", file: path }),
			run: async () => findings.get("now") ?? [],
		};
		const checks = new BackgroundChecks({ cwd: "/p", report: (t) => reports.push(t), checkers: [checker] });
		findings.set("now", [lint("was there")]);
		checks.onRead("/p/a.fake");
		await new Promise((resolve) => setTimeout(resolve, 20));
		findings.set("now", [lint("was there"), lint("added")]);
		checks.onEdited("/p/a.fake");
		await checks.waitForIdle(2000);
		// Not reported while the work goes on...
		expect(reports).toEqual([]);
		// ...but when the run would end, and still against the state before the first edit after a second check.
		checks.onEdited("/p/a.fake");
		await checks.waitForIdle(2000);
		const report = checks.takeLintReport();
		expect(report).toContain("a.fake:1:1: added");
		expect(report).not.toContain("was there");
		expect(checks.takeLintReport()).toBeUndefined();
		checks.onEdited("/p/a.fake");
		await checks.waitForIdle(2000);
		expect(checks.takeLintReport()).toBeUndefined();
		checks.dispose();
	});

	it("reads PI_CHECKS: all by default, none for off, else the names given", () => {
		expect(enabledCheckers(undefined)).toBe(CHECKERS);
		expect(enabledCheckers("off")).toEqual([]);
		expect(enabledCheckers("rust, python").map((c) => c.name)).toEqual(["rust", "python"]);
	});
});

describe("a checker's run", () => {
	it("fails when it runs out of time, rather than passing its partial output on as findings", async () => {
		await expect(
			run(
				["sh", "-c", "echo 'a.py:1:1: error[x] partial'; sleep 5"],
				tmpdir(),
				new AbortController().signal,
				undefined,
				200,
			),
		).rejects.toThrow(/ran out of time/);
		await expect(run(["sh", "-c", "echo found; exit 1"], tmpdir(), new AbortController().signal)).resolves.toEqual({
			stdout: "found\n",
			stderr: "",
			code: 1,
		});
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

	async function errorsOf(file: string, content: string): Promise<Diagnostic[]> {
		const path = join(dir, file);
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, content);
		const checker = CHECKERS.find((c) => c.matches(path))!;
		const unit = checker.unit(path);
		if (!unit) return [];
		return await checker.run(unit, new AbortController().signal);
	}

	it.skipIf(!existsSync(join(__dirname, "..", "native", "libclang", "prebuilds")))(
		"checks C++ with the fileTracker's libclang engine after the edit, which does not wait for it",
		async () => {
			const fileTracker = new FileTracker();
			const reports: string[] = [];
			const checks = new BackgroundChecks({
				cwd: dir,
				report: (t) => reports.push(t),
				checkers: [cppChecker(fileTracker.cppEngine, dir)!],
			});
			fileTracker.setBackgroundChecks(checks);
			const path = join(dir, "a.cpp");
			const before = "int f() { return 1; }\n";
			writeFileSync(path, before);
			fileTracker.onFileRead(path, before, statSync(path).mtimeMs, dir);
			const after = 'int f() { return 1; }\nint g() { int x = "s"; return x; }\n';
			writeFileSync(path, after);
			fileTracker.onFileModified({ absolutePath: path, newContent: after, newMtimeMs: statSync(path).mtimeMs });
			expect(checks.busy).toBe(true);
			await checks.waitForIdle(20_000);
			expect(reports).toHaveLength(1);
			expect(reports[0]).toMatch(/^New errors after your changes \(cpp check\):\n {2}a\.cpp:2:/);
			checks.dispose();
		},
		30_000,
	);

	it("finds a JSON syntax error in the process", async () => {
		const [d] = await errorsOf("a.json", '{"a": 1,}');
		expect(d?.severity).toBe("error");
		expect(await errorsOf("b.json", '{"a": 1}')).toEqual([]);
	});

	it.skipIf(!onPath("ty"))("finds a Python type error with ty", async () => {
		writeFileSync(join(dir, "pyproject.toml"), '[project]\nname = "t"\nversion = "0"\n');
		const errors = await errorsOf("a.py", 'def f(x: int) -> int:\n    return x\n\nf("a")\n');
		expect(errors).toEqual([
			expect.objectContaining({ file: join(dir, "a.py"), line: 4, code: "invalid-argument-type" }),
		]);
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
		// One finding, not also the line bash quotes after it.
		expect(await errorsOf("c.sh", "if then\n")).toEqual([expect.objectContaining({ line: 1 })]);
		expect(await errorsOf("b.sh", "echo fine\n")).toEqual([]);
	});

	it.skipIf(!onPath("luau-analyze"))(
		"finds Luau syntax errors always and type errors only under --!strict",
		async () => {
			expect(await errorsOf("a.luau", "local x = \n")).toEqual([expect.objectContaining({ code: "SyntaxError" })]);
			expect(await errorsOf("b.luau", "local y = card.title\nreturn y\n")).toEqual([]);
			expect(await errorsOf("c.luau", '--!strict\nlocal x: number = "a"\nreturn x\n')).toEqual([
				expect.objectContaining({ code: "TypeError", line: 2 }),
			]);
		},
	);

	async function lintOf(file: string, content: string, config: Record<string, string>): Promise<Diagnostic[]> {
		for (const [name, text] of Object.entries(config)) {
			mkdirSync(join(dir, name, ".."), { recursive: true });
			writeFileSync(join(dir, name), text);
		}
		const path = join(dir, file);
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, content);
		const out: Diagnostic[] = [];
		for (const checker of CHECKERS.filter((c) => c.matches(path))) {
			const unit = checker.unit(path);
			if (unit) out.push(...(await checker.run(unit, new AbortController().signal)));
		}
		return out.filter((d) => d.severity === "warning");
	}

	it.skipIf(!onPath("ruff"))("lints Python with ruff only where the project configures it", async () => {
		const code = "import os\n";
		expect(await lintOf("a.py", code, {})).toEqual([]);
		const found = await lintOf("b.py", code, {
			"pyproject.toml": '[project]\nname = "t"\nversion = "0"\n\n[tool.ruff]\n',
		});
		expect(found).toEqual([expect.objectContaining({ code: "F401", line: 1 })]);
	});

	it.skipIf(!onPath("biome"))("lints TypeScript with Biome for a biome.json", async () => {
		const found = await lintOf("a.ts", "export const f = (a: number) => a == 2;\n", { "biome.json": "{}" });
		expect(found).toEqual([expect.objectContaining({ code: "lint/suspicious/noDoubleEquals", line: 1 })]);
	});

	it.skipIf(!onPath("oxlint"))("lints JavaScript with oxlint for an ESLint configuration", async () => {
		const found = await lintOf("a.js", "debugger;\n", { "eslint.config.js": "export default [];\n" });
		expect(found).toEqual([expect.objectContaining({ line: 1 })]);
	});

	it.skipIf(!onPath("rumdl"))("lints Markdown with rumdl for a markdownlint configuration", async () => {
		expect(await lintOf("a.md", "# A\n## B\n", {})).toEqual([]);
		const found = await lintOf("b.md", "# A\n## B\n", { ".markdownlint.json": "{}" });
		expect(found).toEqual(expect.arrayContaining([expect.objectContaining({ code: "MD022" })]));
	});

	it.skipIf(!onPath("ryl"))("lints YAML with ryl for a yamllint configuration", async () => {
		const found = await lintOf("a.yaml", "a: [1,2]\n", { ".yamllint": "extends: default\n" });
		expect(found).toEqual(expect.arrayContaining([expect.objectContaining({ code: "commas" })]));
	});

	it.skipIf(!onPath("selene"))("lints Luau with selene for a selene.toml", async () => {
		const found = await lintOf("a.luau", "local x = 1\nreturn 0\n", { "selene.toml": 'std = "luau"\n' });
		expect(found).toEqual([expect.objectContaining({ code: "unused_variable", line: 1 })]);
		if (onPath("luau-analyze")) expect(await lintOf("b.luau", "local x =\n", {})).toEqual([]);
	});

	it.skipIf(!onPath("clangd-tidy"))(
		"lints C with clangd-tidy for a .clang-tidy and compile_commands.json",
		{ timeout: 30_000 },
		async () => {
			const found = await lintOf("a.c", "int f(int x) {\n  if (x) { return 1; } else { return 2; }\n}\n", {
				".clang-tidy": 'Checks: "readability-else-after-return"\n',
				"compile_commands.json": JSON.stringify([{ directory: dir, command: "cc -c a.c", file: "a.c" }]),
			});
			expect(found).toEqual([expect.objectContaining({ code: "readability-else-after-return", line: 2 })]);
		},
	);

	it.skipIf(!onPath("cargo"))(
		"checks Rust with clippy where the project uses it, its warnings as lint",
		{ timeout: 180_000 },
		async () => {
			const found = await lintOf("src/lib.rs", "pub fn f(x: u32) -> u32 {\n    return x;\n}\n", {
				"Cargo.toml": '[package]\nname = "t"\nversion = "0.1.0"\nedition = "2021"\n',
				"clippy.toml": "",
			});
			expect(found).toEqual([expect.objectContaining({ code: "clippy::needless_return", line: 2 })]);
		},
	);

	it.skipIf(!onPath("node"))("finds a JavaScript syntax error with node --check", async () => {
		expect(await errorsOf("a.js", "const a = ;\n")).toEqual([expect.objectContaining({ line: 1 })]);
	});
});
