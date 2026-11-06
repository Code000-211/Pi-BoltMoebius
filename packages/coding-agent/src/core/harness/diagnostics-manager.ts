import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { stripBom } from "../../utils/text.ts";
import type { BackgroundChecks } from "../checks/background-checks.ts";
import type { Checker } from "../checks/checkers.ts";
import { notifySearchFileTouched } from "../tools/native-search.ts";
import { CppHipDiagnosticsEngine } from "./cpp-hip-engine.ts";
import { FileStateTracker, isCppOrHipFile } from "./file-state-tracker.ts";

const NESTED_INSTRUCTION_CANDIDATES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];

function loadInstructionFileFromDir(dir: string): { path: string; content: string } | null {
	for (const filename of NESTED_INSTRUCTION_CANDIDATES) {
		const filePath = join(dir, filename);
		if (!existsSync(filePath)) continue;
		try {
			if (!statSync(filePath).isFile()) continue;
			return {
				path: filePath,
				content: stripBom(readFileSync(filePath, "utf-8")),
			};
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
export function formatNestedInstructionsReminder(files: Array<{ path: string; content: string }>): string {
	if (files.length === 0) return "";
	const frames = files.map((f) => `Contents of ${f.path}:\n\n${f.content.trimEnd()}`);
	return `\n\n<system-reminder>\n${frames.join("\n\n")}\n</system-reminder>`;
}

/**
 * Format a compact `cat -n` style snippet around `firstChangedLine` using a single `indexOf("\n")`
 * scan so large files never allocate a full `split("\n")` array.
 */
export function formatPostEditSnippet(
	newContent: string,
	firstChangedLine: number | undefined,
	contextRadius = 3,
): string {
	if (!firstChangedLine || firstChangedLine < 1 || !newContent) return "";

	const startLine = Math.max(1, firstChangedLine - contextRadius);
	const endLine = firstChangedLine + contextRadius + 2;

	const snippetLines: string[] = [];
	let currentLine = 1;
	let pos = 0;
	const len = newContent.length;

	while (pos <= len && currentLine <= endLine) {
		const nextNl = newContent.indexOf("\n", pos);
		if (currentLine >= startLine) {
			const lineText = nextNl === -1 ? newContent.slice(pos) : newContent.slice(pos, nextNl);
			const lineNo = String(currentLine).padStart(6, " ");
			snippetLines.push(`${lineNo}→${lineText}`);
		}
		if (nextNl === -1) break;
		pos = nextNl + 1;
		currentLine++;
	}

	if (snippetLines.length === 0) return "";
	return `\n\nHere is a snippet of the edited file around line ${firstChangedLine}:\n${snippetLines.join("\n")}`;
}

export class ClaudeHarnessManager {
	readonly stateTracker = new FileStateTracker();
	readonly cppHipEngine: CppHipDiagnosticsEngine;
	/** The checks after an edit, in the background (see checks/background-checks.ts). */
	private checks?: BackgroundChecks;
	/**
	 * Whether the files are on this machine. Those on a remote machine stay out of the search caches here, and get no
	 * nested AGENTS.md files: both would come from this machine's files at the same paths.
	 */
	private readonly local: boolean;

	constructor(options?: { local?: boolean }) {
		this.cppHipEngine = new CppHipDiagnosticsEngine(this.stateTracker);
		this.local = options?.local ?? true;
	}

	setBackgroundChecks(checks: BackgroundChecks | undefined): void {
		this.checks = checks;
	}

	/**
	 * C, C++ and HIP through libclang as a background check (see checks/background-checks.ts), so that an edit does not
	 * wait for the reparse: a tenth of a second on a warm translation unit, seconds on a large one. It uses this
	 * manager's engine, which knows the files read and changed: a header is parsed in a source that includes it, with
	 * the other headers the agent changed. Undefined when the libclang bridge is not there.
	 */
	cppChecker(workspaceCwd: string): Checker | undefined {
		if (!this.cppHipEngine.available()) return undefined;
		const checker: Checker = {
			name: "cpp",
			matches: (path) => isCppOrHipFile(path),
			unit: (path) => ({ key: `cpp:${path}`, checker, cwd: workspaceCwd, file: path }),
			run: (unit) => this.cppHipEngine.check(unit.file!, readFileSync(unit.file!, "utf8"), unit.cwd),
		};
		return checker;
	}

	/**
	 * Called by `read.ts` as soon as a file is read: records the file's mtime and content, starts its background check
	 * (its baseline), and returns the nested instruction files found on the way. Pass `contentComplete: false` when
	 * `content` is only a prefix of a large file.
	 */
	onFileRead(
		absolutePath: string,
		content: string,
		mtimeMs: number,
		workspaceCwd: string,
		rawBuffer?: Buffer,
		contentComplete = true,
	): string {
		this.stateTracker.recordFileRead(absolutePath, content, mtimeMs, contentComplete);
		if (contentComplete) {
			if (this.local) notifySearchFileTouched(absolutePath, rawBuffer ?? content, mtimeMs);
			this.checks?.onRead(absolutePath);
		}
		if (!this.local) return "";
		const nestedFiles = this.stateTracker.discoverNestedInstructionsOnRead(
			absolutePath,
			workspaceCwd,
			loadInstructionFileFromDir,
		);
		return formatNestedInstructionsReminder(nestedFiles);
	}

	/**
	 * Verify Read-Before-Edit, mtime staleness & content equality guard before modifying an existing file.
	 */
	assertCanModifyExistingFile(
		absolutePath: string,
		currentMtimeMs: number | undefined,
		currentContent?: string,
	): void {
		this.stateTracker.assertCanModifyExistingFile(absolutePath, currentMtimeMs, currentContent);
	}

	/**
	 * Called by `edit.ts` / `write.ts` (and bash, for a file a command changed) after writing the new content: updates
	 * the tracked state, starts the file's background check, and returns the snippet to append when asked for.
	 *
	 * `newContent` must be exactly what was written to disk (BOM and line endings included) so the next read-before-edit
	 * content check matches. `displayContent` is the LF-normalized text used for the snippet; it defaults to
	 * `newContent`.
	 */
	onFileModified(params: {
		absolutePath: string;
		newContent: string;
		displayContent?: string;
		newMtimeMs: number;
		firstChangedLine?: number;
		includePostEditSnippet?: boolean;
	}): string {
		const {
			absolutePath,
			newContent,
			displayContent = newContent,
			newMtimeMs,
			firstChangedLine,
			includePostEditSnippet = false,
		} = params;
		this.stateTracker.recordFileModifiedByAgent(absolutePath, newContent, newMtimeMs);
		if (this.local) notifySearchFileTouched(absolutePath, newContent, newMtimeMs);
		this.checks?.onEdited(absolutePath);
		return includePostEditSnippet && firstChangedLine !== undefined
			? formatPostEditSnippet(displayContent, firstChangedLine)
			: "";
	}
}

export const defaultClaudeHarnessManager = new ClaudeHarnessManager();
