/**
 * The checks that run in the background after an edit (see background-checks.ts): for each language, which files it
 * takes, the unit it checks (a file, or a project such as a Cargo package or a tsconfig.json), and how its command's
 * output becomes diagnostics. Each runs only when its tool is installed; only errors count, not warnings.
 *
 * The tools are the fastest found for each language (November 2026): ty for Python (24-31 ms a file), TypeScript 7's
 * native `tsc` (about 3-10x the JavaScript one), `cargo check` for Rust (1.4 s warm on Moebius's 440-file workspace,
 * where rust-analyzer gave no answer within 84 s and took 3.2 GB), shuck for shell (2-4 ms), luau-analyze (5 ms), and
 * Bun's own parsers for JSON, TOML and YAML (all three in about 1 ms, in the process). C, C++ and HIP are not here: libclang
 * checks them in the process (cpp/checker.ts, cpp/libclang.ts), with the files the agent read.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";

export type DiagnosticSeverity = "error" | "warning";

/** One finding of a checker: an error, or a warning (a linter's finding). */
export interface Diagnostic {
	file: string;
	line: number;
	column: number;
	severity: DiagnosticSeverity;
	message: string;
	code?: string;
}

export interface CheckUnit {
	/** Which checker, and what it checks: one run at a time per key. */
	key: string;
	checker: Checker;
	/** The folder the command runs in. */
	cwd: string;
	/** The file, for checkers of single files. */
	file?: string;
}

export interface Checker {
	/** As `PI_CHECKS` names it. */
	name: string;
	/** Whether it takes this file. */
	matches(path: string): boolean;
	/** The unit that checks this file, or undefined when its tool is not installed or no project holds the file. */
	unit(path: string): CheckUnit | undefined;
	/** The errors in the unit as it is on disk now. */
	run(unit: CheckUnit, signal: AbortSignal): Promise<Diagnostic[]>;
}

/** How long a check may take before it is given up (a cold `cargo check` of a large workspace takes longer). */
const RUN_TIMEOUT_MS = 300_000;

const pathCache = new Map<string, string | undefined>();

/** The executable `name` on PATH, cached. */
export function onPath(name: string): string | undefined {
	if (!pathCache.has(name)) {
		let found: string | undefined;
		for (const dir of (process.env.PATH ?? "").split(delimiter)) {
			const candidate = join(dir, name);
			try {
				if (dir && statSync(candidate).isFile()) {
					found = candidate;
					break;
				}
			} catch {}
		}
		pathCache.set(name, found);
	}
	return pathCache.get(name);
}

/** The nearest folder at or above `dir` that holds one of `names`, not above `stop` when given. */
function findUp(dir: string, names: string[], stop?: string): string | undefined {
	let current = resolve(dir);
	for (;;) {
		if (names.some((name) => existsSync(join(current, name)))) return current;
		const up = dirname(current);
		if (up === current || (stop && current === stop)) return undefined;
		current = up;
	}
}

interface Ran {
	stdout: string;
	stderr: string;
	code: number | null;
}

/**
 * Runs `argv` without a shell; the output also when it exits with an error, which is how checkers report. Rejects when
 * it was aborted, could not start, or ran out of time: its output is then partial, not its findings.
 */
export function run(
	argv: string[],
	cwd: string,
	signal: AbortSignal,
	env?: NodeJS.ProcessEnv,
	timeoutMs = RUN_TIMEOUT_MS,
): Promise<Ran> {
	return new Promise((resolvePromise, reject) => {
		execFile(
			argv[0]!,
			argv.slice(1),
			{ cwd, signal, env: { ...process.env, ...env }, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 },
			(error, stdout, stderr) => {
				if (error && (error as NodeJS.ErrnoException).code === "ABORT_ERR") return reject(error);
				if (error && typeof (error as { code?: unknown }).code === "string") return reject(error);
				if (error?.killed) return reject(new Error(`${argv[0]} ran out of time after ${timeoutMs} ms`));
				resolvePromise({
					stdout: String(stdout),
					stderr: String(stderr),
					code: error ? Number(error.code ?? 1) : 0,
				});
			},
		);
	});
}

function diag(
	file: string,
	line: number,
	column: number,
	message: string,
	code?: string,
	severity: DiagnosticSeverity = "error",
): Diagnostic {
	return { file, line, column, severity, message: message.trim(), code };
}

/**
 * Lines `file:line:col: error[code] message` (also `warning[code]:`), as ty, shuck and selene print them with paths
 * relative to `cwd`: the errors, and with `lint` the warnings too, as lint findings.
 */
function parseColonFindings(text: string, cwd: string, lint = false): Diagnostic[] {
	const out: Diagnostic[] = [];
	for (const line of text.split("\n")) {
		const m = /^(.+?):(\d+):(\d+): (error|warning)\[([^\]]+)\]:? (.*)$/.exec(line.trim());
		if (!m || (m[4] === "warning" && !lint)) continue;
		out.push(diag(resolve(cwd, m[1]!), Number(m[2]), Number(m[3]), m[6]!, m[5], m[4] as DiagnosticSeverity));
	}
	return out;
}

/** Whether a file at or above `dir` is one of `names`. */
const configured = (dir: string, names: string[]) => findUp(dir, names) !== undefined;

/** Whether `file` (at or above `dir`) holds `text`. */
function mentions(dir: string, file: string, text: RegExp): boolean {
	const found = findUp(dir, [file]);
	if (!found) return false;
	try {
		return text.test(readFileSync(join(found, file), "utf-8"));
	} catch {
		return false;
	}
}

const extension = (path: string) => path.slice(path.lastIndexOf(".") + 1).toLowerCase();

// ------------------------------------------------------------------------------------------ Rust: cargo check, clippy

/** The Cargo package of a file (its nearest Cargo.toml) and the workspace above it, whose root cargo reports paths from. */
function cargoProject(path: string): { manifest: string; root: string } | undefined {
	const pkg = findUp(dirname(path), ["Cargo.toml"]);
	if (!pkg) return undefined;
	let root = pkg;
	for (let dir = dirname(pkg); dir !== dirname(dir); dir = dirname(dir)) {
		const manifest = join(dir, "Cargo.toml");
		if (existsSync(manifest) && /^\s*\[workspace\]/m.test(readFileSync(manifest, "utf-8"))) root = dir;
	}
	return { manifest: join(pkg, "Cargo.toml"), root };
}

const clippyUse = new Map<string, boolean>();

/**
 * Whether the workspace at `root` lints with clippy: a clippy.toml, clippy lints in Cargo.toml, or `cargo clippy` in its
 * CI. Then the background check is `cargo clippy`, which checks too, and its warnings are lint findings (Moebius's CI,
 * for one, fails on them with `-D warnings`).
 */
function usesClippy(root: string): boolean {
	if (!clippyUse.has(root)) {
		let uses = ["clippy.toml", ".clippy.toml"].some((name) => existsSync(join(root, name)));
		if (!uses) {
			try {
				uses = /lints\.clippy/.test(readFileSync(join(root, "Cargo.toml"), "utf-8"));
			} catch {}
		}
		for (const ci of [
			join(root, ".github", "workflows"),
			join(root, ".forgejo", "workflows"),
			join(root, ".gitlab-ci.yml"),
		]) {
			if (uses) break;
			try {
				const files = statSync(ci).isDirectory() ? readdirSync(ci).map((name) => join(ci, name)) : [ci];
				uses = files.some((file) => /cargo\s+clippy/.test(readFileSync(file, "utf-8")));
			} catch {}
		}
		clippyUse.set(root, uses);
	}
	return clippyUse.get(root)!;
}

const rust: Checker = {
	name: "rust",
	matches: (path) => extension(path) === "rs",
	unit(path) {
		if (!onPath("cargo")) return undefined;
		const project = cargoProject(path);
		if (!project) return undefined;
		return { key: `rust:${project.manifest}`, checker: rust, cwd: project.root, file: project.manifest };
	},
	async run(unit, signal) {
		// Its own target folder by default, so that it never waits for the lock of the agent's `cargo build` or
		// `cargo test`; `PI_CHECKS_CARGO_TARGET=shared` uses the project's (where something else warms it, as Moebius's
		// lens does at the end of a run).
		const env =
			process.env.PI_CHECKS_CARGO_TARGET === "shared"
				? {}
				: { CARGO_TARGET_DIR: join(unit.cwd, "target", "pi-check") };
		const clippy = usesClippy(unit.cwd);
		const ran = await run(
			["cargo", clippy ? "clippy" : "check", "--message-format=json", "--quiet", "--manifest-path", unit.file!],
			unit.cwd,
			signal,
			env,
		);
		const out: Diagnostic[] = [];
		for (const line of ran.stdout.split("\n")) {
			if (!line.startsWith("{")) continue;
			let event: {
				reason?: string;
				message?: {
					level?: string;
					message?: string;
					code?: { code?: string } | null;
					spans?: Array<{ file_name: string; line_start: number; column_start: number; is_primary: boolean }>;
				};
			};
			try {
				event = JSON.parse(line);
			} catch {
				continue;
			}
			const message = event.message;
			if (event.reason !== "compiler-message") continue;
			const level =
				message?.level === "error" ? "error" : clippy && message?.level === "warning" ? "warning" : undefined;
			if (!level || !message) continue;
			const span = message.spans?.find((s) => s.is_primary) ?? message.spans?.[0];
			if (!span) continue;
			out.push(
				diag(
					resolve(unit.cwd, span.file_name),
					span.line_start,
					span.column_start,
					message.message ?? "",
					message.code?.code,
					level,
				),
			);
		}
		return out;
	},
};

// ------------------------------------------------------------------------------------------------------- Python: ty

const PYTHON_ROOTS = ["pyproject.toml", "setup.py", "setup.cfg", "ty.toml", ".git"];

/** ruff's findings in the file, as lint, where the project configures ruff (8 ms a file). */
async function ruff(unit: CheckUnit, signal: AbortSignal): Promise<Diagnostic[]> {
	const dir = dirname(unit.file!);
	const uses = configured(dir, ["ruff.toml", ".ruff.toml"]) || mentions(dir, "pyproject.toml", /^\[tool\.ruff/m);
	if (!uses || !onPath("ruff")) return [];
	const ran = await run(
		["ruff", "check", "--output-format", "concise", "--no-cache", "--quiet", unit.file!],
		unit.cwd,
		signal,
	);
	const out: Diagnostic[] = [];
	for (const line of ran.stdout.split("\n")) {
		const m = /^(.+?):(\d+):(\d+): (\S+) (?:\[\*\] )?(.*)$/.exec(line.trim());
		if (m) out.push(diag(resolve(unit.cwd, m[1]!), Number(m[2]), Number(m[3]), m[5]!, m[4], "warning"));
	}
	return out;
}

const python: Checker = {
	name: "python",
	matches: (path) => ["py", "pyi"].includes(extension(path)),
	unit(path) {
		const cwd = findUp(dirname(path), PYTHON_ROOTS) ?? dirname(path);
		return { key: `python:${path}`, checker: python, cwd, file: path };
	},
	async run(unit, signal) {
		if (onPath("ty")) {
			// The file alone, from its project's root, so that its imports resolve: 24-31 ms.
			const ran = await run(
				["ty", "check", "--output-format", "concise", "--no-progress", unit.file!],
				unit.cwd,
				signal,
			);
			const found = parseColonFindings(ran.stdout, unit.cwd).filter((d) => d.file === unit.file);
			return [...found, ...(await ruff(unit, signal))];
		}
		const python3 = onPath("python3");
		if (!python3) return [];
		const ran = await run(
			[
				python3,
				"-c",
				"import ast,sys; ast.parse(open(sys.argv[1], encoding='utf-8').read(), sys.argv[1])",
				unit.file!,
			],
			unit.cwd,
			signal,
		);
		const m = /line (\d+)[\s\S]*?(\w+Error: .*)$/m.exec(ran.stderr);
		return m ? [diag(unit.file!, Number(m[1]), 1, m[2]!)] : [];
	},
};

// ------------------------------------------------------------------------------ TypeScript: tsc; JavaScript: node

/** The `tsc` to use: TypeScript 7's native one on PATH before the project's own, which may be the slower JavaScript one. */
function tscFor(projectDir: string): string | undefined {
	const global = onPath("tsc");
	if (global) return global;
	const local = findUp(projectDir, [join("node_modules", ".bin", "tsc")]);
	return local ? join(local, "node_modules", ".bin", "tsc") : undefined;
}

const typescript: Checker = {
	name: "typescript",
	matches: (path) => ["ts", "tsx", "mts", "cts"].includes(extension(path)) && !path.endsWith(".d.ts"),
	unit(path) {
		const project = findUp(dirname(path), ["tsconfig.json"]);
		if (!project || !tscFor(project)) return undefined;
		return { key: `typescript:${project}`, checker: typescript, cwd: project };
	},
	async run(unit, signal) {
		const buildInfo = join(
			tmpdir(),
			"pi-checks",
			`${createHash("sha1").update(unit.cwd).digest("hex").slice(0, 16)}.tsbuildinfo`,
		);
		const ran = await run(
			[
				tscFor(unit.cwd)!,
				"--noEmit",
				"--pretty",
				"false",
				"--incremental",
				"--tsBuildInfoFile",
				buildInfo,
				"-p",
				join(unit.cwd, "tsconfig.json"),
			],
			unit.cwd,
			signal,
		);
		const out: Diagnostic[] = [];
		for (const line of ran.stdout.split("\n")) {
			const m = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/.exec(line.trim());
			if (m) out.push(diag(resolve(unit.cwd, m[1]!), Number(m[2]), Number(m[3]), m[5]!, m[4]));
		}
		return out;
	},
};

const javascript: Checker = {
	name: "javascript",
	matches: (path) => ["js", "mjs", "cjs"].includes(extension(path)),
	unit(path) {
		if (!onPath("node")) return undefined;
		return { key: `javascript:${path}`, checker: javascript, cwd: dirname(path), file: path };
	},
	async run(unit, signal) {
		const ran = await run(["node", "--check", unit.file!], unit.cwd, signal);
		if (ran.code === 0) return [];
		const line = /:(\d+)\n/.exec(ran.stderr);
		const message = /^(\w*Error: .*)$/m.exec(ran.stderr);
		return message ? [diag(unit.file!, line ? Number(line[1]) : 1, 1, message[1]!)] : [];
	},
};

// ------------------------------------------------------------------------------------------- Shell: bash -n, shuck

const shell: Checker = {
	name: "shell",
	matches: (path) => ["sh", "bash"].includes(extension(path)),
	unit(path) {
		if (!onPath("bash") && !onPath("shuck")) return undefined;
		return { key: `shell:${path}`, checker: shell, cwd: dirname(path), file: path };
	},
	async run(unit, signal) {
		const out: Diagnostic[] = [];
		if (onPath("bash")) {
			const ran = await run(["bash", "-n", unit.file!], unit.cwd, signal, { LC_ALL: "C" });
			for (const line of ran.stderr.split("\n")) {
				const m = /: line (\d+): (.*)$/.exec(line);
				// Not the line bash quotes after the message (`if then').
				if (m && !/^`.*'$/.test(m[2]!)) out.push(diag(unit.file!, Number(m[1]), 1, m[2]!));
			}
		}
		// shuck's errors once the syntax is right, and its warnings where the project configures ShellCheck or shuck.
		if (out.length === 0 && onPath("shuck")) {
			const lint = configured(unit.cwd, [".shellcheckrc", "shuck.toml", ".shuck.toml"]);
			const ran = await run(["shuck", "check", "--output-format", "concise", unit.file!], unit.cwd, signal);
			out.push(...parseColonFindings(ran.stdout, unit.cwd, lint));
		}
		return out;
	},
};

// ------------------------------------------------------------------------------------------------ Luau: luau-analyze

const luau: Checker = {
	name: "luau",
	matches: (path) => ["luau"].includes(extension(path)),
	unit(path) {
		if (!onPath("luau-analyze")) return undefined;
		return { key: `luau:${path}`, checker: luau, cwd: dirname(path), file: path };
	},
	async run(unit, signal) {
		const ran = await run(["luau-analyze", unit.file!], unit.cwd, signal);
		// A script that runs inside a host (Moebius's column scripts) uses globals the analyzer does not know: its type
		// errors count only in a file that asks for them with `--!strict`; syntax errors always do.
		const strict = /^--!strict/m.test(readFileSync(unit.file!, "utf-8"));
		const out: Diagnostic[] = [];
		for (const line of (ran.stdout + ran.stderr).split("\n")) {
			const m = /^(.+?)\((\d+),(\d+)\): (\w+): (.*)$/.exec(line.trim());
			if (!m || !(m[4] === "SyntaxError" || (strict && m[4] === "TypeError"))) continue;
			out.push(diag(unit.file!, Number(m[2]), Number(m[3]), m[5]!, m[4]));
		}
		return out;
	},
};

// ------------------------------------------------------------------------------ JSON, TOML, YAML: parsed in the process

type Parse = (text: string) => unknown;

function bunParser(kind: "TOML" | "YAML"): Parse | undefined {
	const bun = (globalThis as { Bun?: Record<string, { parse?: Parse }> }).Bun;
	return bun?.[kind]?.parse?.bind(bun[kind]);
}

function dataChecker(name: string, extensions: string[], parser: () => Parse | undefined): Checker {
	const checker: Checker = {
		name,
		matches: (path) => extensions.includes(extension(path)) && !path.endsWith("tsconfig.json"),
		unit(path) {
			if (!parser()) return undefined;
			return { key: `${name}:${path}`, checker, cwd: dirname(path), file: path };
		},
		async run(unit) {
			try {
				parser()!(readFileSync(unit.file!, "utf-8"));
				return [];
			} catch (error) {
				const message = String(error instanceof Error ? error.message : error);
				const line = /line (\d+)/i.exec(message);
				return [diag(unit.file!, line ? Number(line[1]) : 1, 1, message)];
			}
		},
	};
	return checker;
}

const json = dataChecker("json", ["json"], () => JSON.parse);
const toml = dataChecker("toml", ["toml"], () => bunParser("TOML"));
const yaml = dataChecker("yaml", ["yaml", "yml"], () => bunParser("YAML"));

// ------------------------------------------------------------------- Linters, each where the project configures it

/** The file's linter in a unit of its own, run from the folder its configuration is in; lint findings only. */
function linter(
	name: string,
	extensions: string[],
	setup: (path: string) => { cwd: string; argv: (file: string) => string[] } | undefined,
	parse: (output: string, cwd: string) => Diagnostic[],
): Checker {
	const checker: Checker = {
		name,
		matches: (path) => extensions.includes(extension(path)),
		unit(path) {
			const found = setup(path);
			if (!found) return undefined;
			return { key: `${name}:${path}`, checker, cwd: found.cwd, file: path };
		},
		async run(unit, signal) {
			const found = setup(unit.file!);
			if (!found) return [];
			const ran = await run(found.argv(unit.file!), unit.cwd, signal);
			return parse(`${ran.stdout}\n${ran.stderr}`, unit.cwd).map((d) => ({ ...d, severity: "warning" as const }));
		},
	};
	return checker;
}

/** The `tool` a project installed itself (node_modules/.bin) before the one on PATH. */
function nodeTool(dir: string, tool: string): string | undefined {
	const local = findUp(dir, [join("node_modules", ".bin", tool)]);
	return local ? join(local, "node_modules", ".bin", tool) : onPath(tool);
}

const BIOME = ["biome.json", "biome.jsonc"];
const OXLINT = [".oxlintrc.json", "oxlintrc.json"];
const ESLINT = [
	"eslint.config.js",
	"eslint.config.mjs",
	"eslint.config.cjs",
	"eslint.config.ts",
	".eslintrc",
	".eslintrc.json",
	".eslintrc.js",
	".eslintrc.cjs",
	".eslintrc.yml",
	".eslintrc.yaml",
];

/**
 * JavaScript and TypeScript: Biome where the project configures it (Moebius's web app does), else oxlint for an oxlint
 * or ESLint configuration (31 ms a file; about 2-3x Biome and 50-100x ESLint).
 */
const jsLint = linter(
	"js-lint",
	["js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts"],
	(path) => {
		const dir = dirname(path);
		const biomeDir = findUp(dir, BIOME);
		const biome = biomeDir && nodeTool(biomeDir, "biome");
		if (biomeDir && biome) {
			return { cwd: biomeDir, argv: (file) => [biome, "lint", "--reporter=github", "--max-diagnostics=50", file] };
		}
		const oxDir = findUp(dir, [...OXLINT, ...ESLINT]);
		const oxlint = oxDir && nodeTool(oxDir, "oxlint");
		if (oxDir && oxlint) return { cwd: oxDir, argv: (file) => [oxlint, "--format=unix", file] };
		return undefined;
	},
	(output, cwd) => {
		const out: Diagnostic[] = [];
		for (const line of output.split("\n")) {
			const github =
				/^::(error|warning|notice) title=([^,]+),file=([^,]+),line=(\d+),(?:endLine=\d+,)?col=(\d+)[^:]*::(.*)$/.exec(
					line.trim(),
				);
			if (github) {
				out.push(diag(resolve(cwd, github[3]!), Number(github[4]), Number(github[5]), github[6]!, github[2]));
				continue;
			}
			const unix = /^(.+?):(\d+):(\d+): (.*) \[(?:Warning|Error)\/([^\]]+)\]$/.exec(line.trim());
			if (unix) out.push(diag(resolve(cwd, unix[1]!), Number(unix[2]), Number(unix[3]), unix[4]!, unix[5]));
		}
		return out;
	},
);

/** Markdown: rumdl (about 10x markdownlint-cli2) for a markdownlint or rumdl configuration. */
const markdown = linter(
	"markdown",
	["md", "markdown"],
	(path) => {
		const names = [
			".markdownlint.json",
			".markdownlint.jsonc",
			".markdownlint.yaml",
			".markdownlint.yml",
			".markdownlint-cli2.jsonc",
			".markdownlint-cli2.yaml",
			".rumdl.toml",
			"rumdl.toml",
		];
		const cwd =
			findUp(dirname(path), names) ??
			(mentions(dirname(path), "pyproject.toml", /^\[tool\.rumdl/m)
				? findUp(dirname(path), ["pyproject.toml"])
				: undefined);
		if (!cwd || !onPath("rumdl")) return undefined;
		return { cwd, argv: (file) => ["rumdl", "check", file] };
	},
	(output, cwd) => {
		const out: Diagnostic[] = [];
		for (const line of output.split("\n")) {
			const m = /^(.+?):(\d+):(\d+): \[(\w+)\] (.*?)(?: \[\*\])?$/.exec(line.trim());
			if (m) out.push(diag(resolve(cwd, m[1]!), Number(m[2]), Number(m[3]), m[5]!, m[4]));
		}
		return out;
	},
);

/** YAML: ryl (a Rust yamllint) for a yamllint or ryl configuration. */
const yamlLint = linter(
	"yaml-lint",
	["yaml", "yml"],
	(path) => {
		const cwd = findUp(dirname(path), [".yamllint", ".yamllint.yaml", ".yamllint.yml", ".ryl.toml"]);
		if (!cwd || !onPath("ryl")) return undefined;
		return { cwd, argv: (file) => ["ryl", "check", "--format", "parsable", file] };
	},
	(output, cwd) => {
		const out: Diagnostic[] = [];
		for (const line of output.split("\n")) {
			const m = /^(.+?):(\d+):(\d+): \[(?:error|warning)\] (.*?)(?: \(([\w-]+)\))?$/.exec(line.trim());
			if (m) out.push(diag(resolve(cwd, m[1]!), Number(m[2]), Number(m[3]), m[4]!, m[5]));
		}
		return out;
	},
);

/** Luau: selene (3 ms a file) for a selene.toml. */
const luauLint = linter(
	"luau-lint",
	["luau", "lua"],
	(path) => {
		const cwd = findUp(dirname(path), ["selene.toml"]);
		if (!cwd || !onPath("selene")) return undefined;
		return { cwd, argv: (file) => ["selene", "--display-style", "quiet", file] };
	},
	// A .luau file's syntax errors come from luau-analyze already.
	(output, cwd) =>
		parseColonFindings(output, cwd, true).filter(
			(d) => !(d.code === "parse_error" && extension(d.file) === "luau" && onPath("luau-analyze")),
		),
);

/** C and C++: clangd-tidy (clang-tidy's checks through clangd, about 10x clang-tidy) for a .clang-tidy and compile_commands.json. */
const cppLint = linter(
	"cpp-lint",
	["c", "cc", "cpp", "cxx", "h", "hh", "hpp", "hip", "cu"],
	(path) => {
		const cwd = findUp(dirname(path), [".clang-tidy"]);
		const db = findUp(dirname(path), ["compile_commands.json", join("build", "compile_commands.json")]);
		if (!cwd || !db || !onPath("clangd-tidy")) return undefined;
		const dbDir = existsSync(join(db, "compile_commands.json")) ? db : join(db, "build");
		return { cwd, argv: (file) => ["clangd-tidy", "-p", dbDir, file] };
	},
	(output, cwd) => {
		const out: Diagnostic[] = [];
		for (const line of output.split("\n")) {
			const m = /^(.+?):(\d+):(\d+): (?:Warning|Error|Information|Hint): (.*?)(?: \[([\w.,-]+)\])?$/.exec(
				line.trim(),
			);
			if (m) out.push(diag(resolve(cwd, m[1]!), Number(m[2]), Number(m[3]), m[4]!, m[5]));
		}
		return out;
	},
);

export const CHECKERS: Checker[] = [
	rust,
	python,
	typescript,
	javascript,
	shell,
	luau,
	json,
	toml,
	yaml,
	jsLint,
	markdown,
	yamlLint,
	luauLint,
	cppLint,
];

/** The checkers of `all` that `PI_CHECKS` allows: all by default, none for `off`, else the comma-separated names. */
export function enabledCheckers(setting = process.env.PI_CHECKS, all = CHECKERS): Checker[] {
	if (setting === undefined || setting.trim() === "" || setting === "on") return all;
	if (setting === "off" || setting === "0" || setting === "false") return [];
	const names = new Set(setting.split(",").map((s) => s.trim()));
	return all.filter((c) => names.has(c.name));
}

/** `path` relative to `cwd` when it is under it. */
export function shown(path: string, cwd: string): string {
	const rel = relative(cwd, path);
	return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : path;
}
