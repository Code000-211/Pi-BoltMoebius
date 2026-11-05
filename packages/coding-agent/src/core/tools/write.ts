import type { AgentTool } from "@earendil-works/pi-agent-core";
import { mkdir as fsMkdir, readFile as fsReadFile, stat as fsStat, writeFile as fsWriteFile } from "fs/promises";
import { dirname } from "path";
import { type Static, Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { type ClaudeHarnessManager, defaultClaudeHarnessManager } from "../harness/index.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { resolveToCwd } from "./path-utils.ts";
import { writeRenderers } from "./renderers/write.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const writeSchema = Type.Object({
	path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
	content: Type.String({ description: "Content to write to the file" }),
});

export const writeToolSystemPromptContribution = {
	snippet: "Create or overwrite files",
	guidelines: ["Use write only for new files or complete rewrites."],
} as const;

export type WriteToolInput = Static<typeof writeSchema>;

/** Of a refused file, at most this much is shown; a longer one is cut, with a note. */
const REFUSAL_MAX_CHARS = 30_000;

/** Why a write over a file not read was refused, with the file as it is now. */
function unreadWriteRefusal(path: string, existing: string): string {
	const shown = existing.length > REFUSAL_MAX_CHARS ? existing.slice(0, REFUSAL_MAX_CHARS) : existing;
	const cut =
		shown.length < existing.length
			? `\n[cut at ${REFUSAL_MAX_CHARS} of ${existing.length} characters: read the rest if it matters]`
			: "";
	return `Not written: ${path} exists and was not read, so writing would replace what is below unseen. It counts as read now: write again to replace it, or edit it.\n\n${shown}${cut}`;
}

/**
 * Pluggable operations for the write tool.
 * Override these to delegate file writing to remote systems (for example SSH).
 */
export interface WriteOperations {
	/** Write content to a file */
	writeFile: (absolutePath: string, content: string) => Promise<void>;
	/** Create directory recursively */
	mkdir: (dir: string) => Promise<void>;
	/**
	 * The file's current content, or undefined when there is none: lets read-before-edit check other operations than
	 * the local filesystem's (by content, as they have no modification times).
	 */
	readExisting?: (absolutePath: string) => Promise<string | undefined>;
}

const defaultWriteOperations: WriteOperations = {
	writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
	mkdir: (dir) => fsMkdir(dir, { recursive: true }).then(() => {}),
};

export interface WriteToolOptions {
	/** Custom operations for file writing. Default: local filesystem */
	operations?: WriteOperations;
	/** Shared Claude harness manager for read-before-edit tracking & LSP/libclang diagnostics. */
	harness?: ClaudeHarnessManager;
	/** Enforce that an existing file was read first and not modified externally before overwriting. */
	enforceReadBeforeEdit?: boolean;
	/** Run C++/HIP (libclang) diagnostics and append <new-diagnostics> (other languages are checked in the background). Default: true */
	enableDiagnostics?: boolean;
}

export function createWriteToolDefinition(
	cwd: string,
	options?: WriteToolOptions,
): ToolDefinition<typeof writeSchema, undefined> {
	const ops = options?.operations ?? defaultWriteOperations;
	const harness = options?.harness ?? defaultClaudeHarnessManager;
	const enforceReadBeforeEdit = options?.enforceReadBeforeEdit ?? false;
	const enableDiagnostics = options?.enableDiagnostics ?? true;
	return {
		name: "write",
		label: "write",
		description:
			"Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
		promptSnippet: writeToolSystemPromptContribution.snippet,
		promptGuidelines: [...writeToolSystemPromptContribution.guidelines],
		parameters: writeSchema,
		// A response's calls run in order when one of them changes files or runs a command: an edit and the command that
		// tests it can come in one response (see the system prompt's rule), which saves a turn.
		executionMode: "sequential",
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		async execute(
			_toolCallId,
			{ path, content }: { path: string; content: string },
			signal?: AbortSignal,
			_onUpdate?,
			ctx?: ExtensionContext,
		) {
			const workspaceCwd = ctx?.cwd || cwd;
			const absolutePath = resolveToCwd(path, workspaceCwd);
			const dir = dirname(absolutePath);
			return withFileMutationQueue(absolutePath, async () => {
				// Do not reject from an abort event listener here: that would release the
				// mutation queue while an in-flight filesystem operation may still finish.
				// Checking signal.aborted after each await observes the same aborts while
				// keeping the queue locked until the current operation has settled.
				const throwIfAborted = (): void => {
					if (signal?.aborted) throw new Error("Operation aborted");
				};

				throwIfAborted();
				if (enforceReadBeforeEdit && ops === defaultWriteOperations) {
					const existingStat = await fsStat(absolutePath).catch(() => undefined);
					throwIfAborted();
					if (existingStat && !harness.stateTracker.hasBeenRead(absolutePath)) {
						// Not read: refused, with the file as it is, which then counts as read, so a write that still means
						// to replace it goes through next time instead of after a read call (10 times in 142 Terminal-Bench
						// runs a read came between).
						const existing = await fsReadFile(absolutePath, "utf-8").catch(() => undefined);
						throwIfAborted();
						if (existing !== undefined) {
							harness.onFileRead(absolutePath, existing, existingStat.mtimeMs, workspaceCwd);
							throw new Error(unreadWriteRefusal(path, existing));
						}
					}
					if (existingStat) {
						// A newer modification time with the same content (`touch`) is no change: compare the content then.
						const state = harness.stateTracker.getTrackedState(absolutePath);
						const current =
							state?.contentComplete && existingStat.mtimeMs > state.lastReadMtimeMs + 10
								? await fsReadFile(absolutePath, "utf-8").catch(() => undefined)
								: undefined;
						throwIfAborted();
						harness.assertCanModifyExistingFile(absolutePath, existingStat.mtimeMs, current);
					}
				} else if (enforceReadBeforeEdit && ops.readExisting) {
					const existing = await ops.readExisting(absolutePath);
					throwIfAborted();
					if (existing !== undefined) harness.assertCanModifyExistingFile(absolutePath, undefined, existing);
				}

				// Create parent directories if needed.
				await ops.mkdir(dir);
				throwIfAborted();

				// Write the file contents.
				await ops.writeFile(absolutePath, content);
				throwIfAborted();

				const afterStat =
					enforceReadBeforeEdit && ops === defaultWriteOperations
						? await fsStat(absolutePath).catch(() => undefined)
						: undefined;
				const { suffix } = await harness.onFileModified({
					absolutePath,
					displayPath: path,
					newContent: content,
					newMtimeMs: afterStat?.mtimeMs ?? Date.now(),
					workspaceCwd,
					includePostEditSnippet: false,
					enableDiagnostics,
				});

				return {
					content: [{ type: "text", text: `Successfully wrote to ${path}${suffix}` }],
					details: undefined,
				};
			});
		},
		...writeRenderers,
	};
}

export function createWriteTool(cwd: string, options?: WriteToolOptions): AgentTool<typeof writeSchema> {
	return wrapToolDefinition(createWriteToolDefinition(cwd, options));
}
