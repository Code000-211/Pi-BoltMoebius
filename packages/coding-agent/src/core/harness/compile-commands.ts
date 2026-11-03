import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { isCppOrHipHeader } from "./file-state-tracker.ts";

export interface CompileCommandEntry {
	directory: string;
	file: string;
	arguments?: string[];
	command?: string;
}

interface CachedCompileDb {
	dbPath: string;
	mtimeMs: number;
	lastStatCheckMs: number;
	entriesByFile: Map<string, CompileCommandEntry>;
	entriesByDir: Map<string, CompileCommandEntry>;
	sanitizedFlagsByFile: Map<string, string[]>;
	firstHipEntry?: CompileCommandEntry;
	firstCppEntry?: CompileCommandEntry;
}

interface CachedDirLookup {
	dbPath: string | null;
	expiresAtMs: number;
}

const DB_LOOKUP_CACHE_TTL_MS = 5000;

const GCC_ONLY_FLAGS = new Set([
	"-fno-canonical-system-headers",
	"-Wno-maybe-uninitialized",
	"-fext-numeric-literals",
	"-frounding-math",
	"-fabi-version=0",
]);

let cachedRocmInfo: { rocmPath?: string; rocmInclude?: string } | undefined;

function getRocmInfo(): { rocmPath?: string; rocmInclude?: string } {
	const envPath = process.env.ROCM_PATH || process.env.HIP_PATH;
	if (envPath) {
		const inc = join(envPath, "include");
		return { rocmPath: envPath, rocmInclude: existsSync(inc) ? inc : undefined };
	}
	if (!cachedRocmInfo) {
		const rocmPath = existsSync("/opt/rocm") ? "/opt/rocm" : undefined;
		const rocmInclude = rocmPath && existsSync("/opt/rocm/include") ? "/opt/rocm/include" : undefined;
		cachedRocmInfo = { rocmPath, rocmInclude };
	}
	return cachedRocmInfo;
}

function normalizePathKey(p: string): string {
	const norm = normalize(resolve(p));
	return process.platform === "win32" ? norm.toLowerCase() : norm;
}

/**
 * Split a shell command string from compile_commands.json into arguments.
 */
export function splitCompileCommand(command: string): string[] {
	const args: string[] = [];
	let current = "";
	let quote: '"' | "'" | null = null;
	for (let i = 0; i < command.length; i++) {
		const c = command[i];
		if (quote) {
			if (c === "\\" && i + 1 < command.length && quote === '"') {
				current += command[++i];
			} else if (c === quote) {
				quote = null;
			} else {
				current += c;
			}
		} else if (c === '"' || c === "'") {
			quote = c;
		} else if (c === " " || c === "\t") {
			if (current.length > 0) {
				args.push(current);
				current = "";
			}
		} else if (c === "\\" && i + 1 < command.length && process.platform !== "win32") {
			current += command[++i];
		} else {
			current += c;
		}
	}
	if (current.length > 0) {
		args.push(current);
	}
	return args;
}

/**
 * Sanitize compiler arguments for libclang / clangd:
 * - Removes compiler driver, -c, -o <out>, dependency generation flags (-MD/-MF/-MT), and input file path
 * - Deduplicates multiple --offload-arch=* / --cuda-gpu-arch=* flags down to a single architecture
 * - Removes GCC-specific flags that cause libclang unknown-argument errors
 */
export function sanitizeCompileFlags(
	rawArgs: string[],
	targetFilePath: string,
	workingDir?: string,
	contentHint?: string,
): string[] {
	const result: string[] = [];
	const targetNorm = normalizePathKey(targetFilePath);
	const ext = extname(targetFilePath).toLowerCase();
	const isHipByExt = ext === ".hip" || ext === ".cuh" || ext === ".hiph";
	const isHipByContent =
		!isHipByExt &&
		contentHint !== undefined &&
		(contentHint.includes("<hip/") ||
			contentHint.includes("__global__") ||
			contentHint.includes("hipLaunchKernelGGL"));

	let seenOffloadArch = false;
	let hasExplicitLanguage = false;
	let hasStdFlag = false;
	// A header inherits its language from the compile entry it borrows flags from: a C `-std=`
	// (no "++") or a `.c` input means the header must be parsed as C, not C++.
	let hasCStdFlag = false;
	let entrySourceIsC = false;

	// Skip the first token if it looks like a compiler binary (clang++, hipcc, g++, nvcc, c++, etc.)
	let startIndex = 0;
	if (rawArgs.length > 0) {
		const first = rawArgs[0].toLowerCase();
		if (
			!first.startsWith("-") &&
			(first.includes("clang") ||
				first.includes("gcc") ||
				first.includes("g++") ||
				first.includes("c++") ||
				first.includes("cc") ||
				first.includes("hipcc") ||
				first.includes("nvcc") ||
				first.endsWith(".exe"))
		) {
			startIndex = 1;
		}
	}

	for (let i = startIndex; i < rawArgs.length; i++) {
		const arg = rawArgs[i];
		if (!arg) continue;

		// Skip output & dependency file flags with an argument
		if (arg === "-o" || arg === "-MF" || arg === "-MT" || arg === "-MQ") {
			i++;
			continue;
		}
		if (
			arg === "-c" ||
			arg === "-MD" ||
			arg === "-MMD" ||
			arg === "-MP" ||
			arg.startsWith("-o") ||
			arg.startsWith("-MF") ||
			arg.startsWith("-MT")
		) {
			continue;
		}

		if (GCC_ONLY_FLAGS.has(arg) || arg.startsWith("-fconcepts-diagnostics-depth=")) {
			continue;
		}

		// Deduplicate --offload-arch=* and --cuda-gpu-arch=* down to 1 architecture for single-pass speed
		if (arg.startsWith("--offload-arch=") || arg.startsWith("--cuda-gpu-arch=")) {
			if (seenOffloadArch) continue;
			seenOffloadArch = true;
			result.push(arg);
			continue;
		}
		if (arg === "--offload-arch" || arg === "--cuda-gpu-arch") {
			const nextArch = rawArgs[i + 1];
			i++;
			if (seenOffloadArch || !nextArch) continue;
			seenOffloadArch = true;
			result.push(`${arg}=${nextArch}`);
			continue;
		}

		if (arg === "-x" && i + 1 < rawArgs.length) {
			hasExplicitLanguage = true;
			result.push(arg, rawArgs[++i]);
			continue;
		}

		if (arg.startsWith("-std=")) {
			hasStdFlag = true;
			hasCStdFlag = !arg.includes("++");
		}

		// Skip input source file path
		if (!arg.startsWith("-")) {
			const resolvedArg = workingDir ? resolve(workingDir, arg) : resolve(arg);
			if (normalizePathKey(resolvedArg) === targetNorm) {
				continue;
			}
			const argExt = extname(arg).toLowerCase();
			if (argExt === ".c") {
				entrySourceIsC = true;
			}
			if (
				argExt === ".cpp" ||
				argExt === ".cc" ||
				argExt === ".cxx" ||
				argExt === ".c" ||
				argExt === ".hip" ||
				argExt === ".cu"
			) {
				continue;
			}
		}

		result.push(arg);
	}

	const isHip = isHipByExt || isHipByContent || seenOffloadArch;
	const isHeader = isCppOrHipHeader(targetFilePath);
	const isC = !isHip && (ext === ".c" || (isHeader && (hasCStdFlag || entrySourceIsC)));

	if (!hasExplicitLanguage) {
		if (isHip) {
			result.unshift("-x", isHeader ? "hip-header" : "hip");
		} else if (isC) {
			result.unshift("-x", isHeader ? "c-header" : "c");
		} else if (isHeader) {
			result.unshift("-x", "c++-header");
		} else {
			result.unshift("-x", "c++");
		}
	}

	if (!hasStdFlag && !isC) {
		result.push("-std=c++20");
	}

	if (isHip) {
		if (!seenOffloadArch) {
			const defaultArch = process.env.HCC_AMDGPU_TARGET || process.env.HIP_OFFLOAD_ARCH || "gfx1100";
			result.push(`--offload-arch=${defaultArch.split(",")[0].split(";")[0].trim()}`);
		}
		const { rocmPath, rocmInclude } = getRocmInfo();
		if (rocmPath && !result.some((a) => a.startsWith("--rocm-path="))) {
			result.push(`--rocm-path=${rocmPath}`);
		}
		if (rocmInclude && !result.includes(`-I${rocmInclude}`)) {
			result.push(`-I${rocmInclude}`);
		}
	}

	// Ensure include of target file's own directory and capped error limit for minimum latency
	const fileDir = dirname(resolve(targetFilePath));
	if (!result.includes(`-I${fileDir}`)) {
		result.push(`-I${fileDir}`);
	}
	if (!result.some((a) => a.startsWith("-ferror-limit="))) {
		result.push("-ferror-limit=20");
	}

	return result;
}

export class CompileCommandsResolver {
	private cache = new Map<string, CachedCompileDb>();
	private dirLookupCache = new Map<string, CachedDirLookup>();

	/**
	 * Resolve sanitized libclang / clangd compiler arguments for `filePath`.
	 * Automatically inherits flags from a sibling .hip/.cpp entry if `filePath` is a header or a newly created file.
	 */
	getFlagsForFile(filePath: string, workspaceCwd: string, contentHint?: string): string[] {
		const absPath = resolve(workspaceCwd, filePath);
		const exactKey = normalizePathKey(absPath);
		const db = this.findAndLoadCompileDb(absPath, workspaceCwd);

		if (db) {
			const cachedFlags = db.sanitizedFlagsByFile.get(exactKey);
			if (cachedFlags) return cachedFlags;

			let entry = db.entriesByFile.get(exactKey);
			if (!entry) {
				// Inherit from a file in the same directory, or fallback to first HIP / C++ entry in the project
				const dirKey = normalizePathKey(dirname(absPath));
				entry =
					db.entriesByDir.get(dirKey) ??
					(extname(absPath).toLowerCase() === ".hip" || extname(absPath).toLowerCase() === ".cuh"
						? (db.firstHipEntry ?? db.firstCppEntry)
						: (db.firstCppEntry ?? db.firstHipEntry));
			}

			if (entry) {
				const rawArgs = entry.arguments ?? (entry.command ? splitCompileCommand(entry.command) : []);
				const sanitized = sanitizeCompileFlags(rawArgs, absPath, entry.directory, contentHint);
				if (entry.directory && !sanitized.some((a) => a.startsWith("-working-directory="))) {
					sanitized.unshift(`-working-directory=${entry.directory}`);
				}
				db.sanitizedFlagsByFile.set(exactKey, sanitized);
				return sanitized;
			}
		}

		return sanitizeCompileFlags([], absPath, workspaceCwd, contentHint);
	}

	private findAndLoadCompileDb(filePath: string, workspaceCwd: string): CachedCompileDb | undefined {
		const now = Date.now();
		const dirKey = normalizePathKey(dirname(filePath));
		const cachedLookup = this.dirLookupCache.get(dirKey);
		if (cachedLookup && cachedLookup.expiresAtMs > now) {
			return cachedLookup.dbPath ? this.loadCompileDb(cachedLookup.dbPath, now) : undefined;
		}

		const candidateDirs: string[] = [];
		let cur = dirname(resolve(filePath));
		for (let depth = 0; depth < 5; depth++) {
			candidateDirs.push(cur);
			const parent = dirname(cur);
			if (parent === cur) break;
			cur = parent;
		}
		const resolvedWorkspace = resolve(workspaceCwd);
		if (!candidateDirs.includes(resolvedWorkspace)) {
			candidateDirs.unshift(resolvedWorkspace);
		}

		const subdirs = ["", "build", "out", "cmake-build-release", "cmake-build-debug"];
		for (const baseDir of candidateDirs) {
			for (const sub of subdirs) {
				const candidate = sub
					? join(baseDir, sub, "compile_commands.json")
					: join(baseDir, "compile_commands.json");
				if (existsSync(candidate)) {
					this.dirLookupCache.set(dirKey, { dbPath: candidate, expiresAtMs: now + DB_LOOKUP_CACHE_TTL_MS });
					return this.loadCompileDb(candidate, now);
				}
			}
		}
		this.dirLookupCache.set(dirKey, { dbPath: null, expiresAtMs: now + DB_LOOKUP_CACHE_TTL_MS });
		return undefined;
	}

	private loadCompileDb(dbPath: string, now = Date.now()): CachedCompileDb | undefined {
		try {
			const cached = this.cache.get(dbPath);
			if (cached && now - cached.lastStatCheckMs < DB_LOOKUP_CACHE_TTL_MS) {
				return cached;
			}

			const st = statSync(dbPath);
			if (cached && cached.mtimeMs === st.mtimeMs) {
				cached.lastStatCheckMs = now;
				return cached;
			}

			const raw = readFileSync(dbPath, "utf-8");
			const parsed = JSON.parse(raw) as CompileCommandEntry[];
			if (!Array.isArray(parsed)) return undefined;

			const entriesByFile = new Map<string, CompileCommandEntry>();
			const entriesByDir = new Map<string, CompileCommandEntry>();
			let firstHipEntry: CompileCommandEntry | undefined;
			let firstCppEntry: CompileCommandEntry | undefined;

			for (const entry of parsed) {
				if (!entry || typeof entry.file !== "string") continue;
				const baseDir = entry.directory || dirname(dbPath);
				const absFile = resolve(baseDir, entry.file);
				const fileKey = normalizePathKey(absFile);
				const dirKey = normalizePathKey(dirname(absFile));

				entriesByFile.set(fileKey, entry);
				if (!entriesByDir.has(dirKey)) {
					entriesByDir.set(dirKey, entry);
				}
				const ext = extname(absFile).toLowerCase();
				if (!firstHipEntry && (ext === ".hip" || ext === ".cu" || entry.command?.includes("hip"))) {
					firstHipEntry = entry;
				} else if (!firstCppEntry) {
					firstCppEntry = entry;
				}
			}

			const db: CachedCompileDb = {
				dbPath,
				mtimeMs: st.mtimeMs,
				lastStatCheckMs: now,
				entriesByFile,
				entriesByDir,
				sanitizedFlagsByFile: new Map(),
				firstHipEntry,
				firstCppEntry,
			};
			this.cache.set(dbPath, db);
			return db;
		} catch {
			return undefined;
		}
	}
}
