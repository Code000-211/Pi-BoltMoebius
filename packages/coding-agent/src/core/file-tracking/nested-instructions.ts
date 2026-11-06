import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import { stripBom } from "../../utils/text.ts";
import { pathKey } from "./file-state.ts";

const NESTED_INSTRUCTION_CANDIDATES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];

interface InstructionFile {
	path: string;
	content: string;
}

function loadInstructionFileFromDir(dir: string): InstructionFile | null {
	for (const filename of NESTED_INSTRUCTION_CANDIDATES) {
		const filePath = join(dir, filename);
		if (!existsSync(filePath)) continue;
		try {
			if (!statSync(filePath).isFile()) continue;
			return { path: filePath, content: stripBom(readFileSync(filePath, "utf-8")) };
		} catch {
			// Ignore unreadable files
		}
	}
	return null;
}

/**
 * Format nested `CLAUDE.md` / `AGENTS.md` files discovered on `read`, matching Claude Code's
 * `mods/agents-md` framing (`Contents of <path>:\n\n<content>`).
 */
export function formatNestedInstructionsReminder(files: InstructionFile[]): string {
	if (files.length === 0) return "";
	const frames = files.map((f) => `Contents of ${f.path}:\n\n${f.content.trimEnd()}`);
	return `\n\n<system-reminder>\n${frames.join("\n\n")}\n</system-reminder>`;
}

/** The `CLAUDE.md` / `AGENTS.md` files in folders below the working folder, each given once when a read reaches it. */
export class NestedInstructions {
	private readonly dirInstructionCache = new Map<string, InstructionFile | null>();
	private readonly sentNestedInstructions = new Set<string>();

	/**
	 * Discover any unseen nested `CLAUDE.md` / `AGENTS.md` files in directories strictly below
	 * `workspaceCwd` up to `dirname(readAbsolutePath)` (matching Claude Code's `mods/agents-md`
	 * on-read hook). Each nested instruction file is returned at most once per session.
	 */
	discover(readAbsolutePath: string, workspaceCwd: string): InstructionFile[] {
		const rootNorm = normalize(resolve(workspaceCwd));
		const rootKey = pathKey(rootNorm);
		const readNorm = normalize(resolve(readAbsolutePath));
		const readKey = pathKey(readNorm);
		const sep = process.platform === "win32" ? "\\" : "/";
		const rootPrefix = rootKey.endsWith(sep) ? rootKey : `${rootKey}${sep}`;
		if (!readKey.startsWith(rootPrefix)) {
			return [];
		}

		// Collect ancestor directories between rootNorm (exclusive) and dirname(readNorm) (inclusive), root-first.
		const dirs: string[] = [];
		let currentDir = dirname(readNorm);
		while (true) {
			const currentKey = pathKey(currentDir);
			if (currentKey === rootKey || !currentKey.startsWith(rootPrefix)) break;
			dirs.push(currentDir);
			const parentDir = dirname(currentDir);
			if (parentDir === currentDir) break;
			currentDir = parentDir;
		}
		if (dirs.length === 0) return [];
		dirs.reverse();

		const attached: InstructionFile[] = [];
		for (const dir of dirs) {
			const dirKey = pathKey(dir);
			let cached = this.dirInstructionCache.get(dirKey);
			if (cached === undefined) {
				cached = loadInstructionFileFromDir(dir);
				this.dirInstructionCache.set(dirKey, cached);
			}
			if (!cached) continue;
			const fileKey = pathKey(cached.path);
			// If the user explicitly called Read on the instruction file itself, mark it as seen without duplicating it
			if (fileKey === readKey) {
				this.sentNestedInstructions.add(fileKey);
				continue;
			}
			if (this.sentNestedInstructions.has(fileKey)) continue;
			this.sentNestedInstructions.add(fileKey);
			attached.push(cached);
		}
		return attached;
	}
}
