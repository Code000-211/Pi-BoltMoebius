import type { BackgroundChecks } from "../checks/background-checks.ts";
import { LibclangEngine } from "../checks/cpp/libclang.ts";
import { notifySearchFileTouched } from "../tools/native-search.ts";
import { FileStateTracker } from "./file-state.ts";
import { formatNestedInstructionsReminder, NestedInstructions } from "./nested-instructions.ts";

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

/**
 * What the file tools know of the files of a session: which were read and how they looked (read-before-edit), the C
 * and C++ engine that uses them, the nested instruction files found on reads, and the background checks that follow
 * reads and edits. One per session; the tools of a remote machine get their own (`local: false`).
 */
export class FileTracker {
	readonly stateTracker = new FileStateTracker();
	readonly cppEngine = new LibclangEngine(this.stateTracker);
	private readonly nestedInstructions = new NestedInstructions();
	/** The checks after an edit, in the background (see checks/background-checks.ts). */
	private checks?: BackgroundChecks;
	/**
	 * Whether the files are on this machine. Those on a remote machine stay out of the search caches here, and get no
	 * nested AGENTS.md files: both would come from this machine's files at the same paths.
	 */
	private readonly local: boolean;

	constructor(options?: { local?: boolean }) {
		this.local = options?.local ?? true;
	}

	setBackgroundChecks(checks: BackgroundChecks | undefined): void {
		this.checks = checks;
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
		return formatNestedInstructionsReminder(this.nestedInstructions.discover(absolutePath, workspaceCwd));
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

export const defaultFileTracker = new FileTracker();
