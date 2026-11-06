import type { AgentTool } from "@earendil-works/pi-agent-core";
import { constants } from "fs";
import { access as fsAccess, readFile as fsReadFile, stat as fsStat, writeFile as fsWriteFile } from "fs/promises";
import { type Static, Type } from "typebox";
import { splitBom } from "../../utils/text.ts";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { type ClaudeHarnessManager, defaultClaudeHarnessManager, StaleFileError } from "../harness/index.ts";
import {
	applyEditsToNormalizedContent,
	describeClosestText,
	detectLineEnding,
	type Edit,
	EditNotFoundError,
	generateDiffString,
	generateUnifiedPatch,
	normalizeToLF,
	restoreLineEndings,
} from "./edit-diff.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { resolveToCwd } from "./path-utils.ts";
import { type EditRenderState, editRenderers } from "./renderers/edit.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const replaceEditSchema = Type.Object(
	{
		oldText: Type.String({
			description:
				"Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
		}),
		newText: Type.String({ description: "Replacement text for this targeted edit." }),
	},
	{},
);

const editSchema = Type.Object(
	{
		path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
		edits: Type.Array(replaceEditSchema, {
			description:
				"One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
		}),
	},
	{},
);

export const editToolSystemPromptContribution = {
	snippet: "Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
	guidelines: [
		"Use edit for precise changes (edits[].oldText must match exactly)",
		"When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls",
		"Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.",
		"Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.",
	],
} as const;

/** Whether every oldText occurs exactly once, as it is, in `content`: the edits do not depend on what the agent last saw of it. */
function editsMatchExactlyOnce(content: string, edits: SingleEditInput[]): boolean {
	return edits.every(({ oldText }) => {
		const text = normalizeToLF(oldText);
		const first = content.indexOf(text);
		return text.length > 0 && first !== -1 && content.indexOf(text, first + 1) === -1;
	});
}

export type EditToolInput = Static<typeof editSchema>;
type LegacyEditToolInput = EditToolInput & {
	oldText?: unknown;
	newText?: unknown;
};

type SingleEditInput = { oldText: string; newText: string };

function isSingleEditInput(value: unknown): value is SingleEditInput {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}

	const edit = value as Record<string, unknown>;
	return typeof edit.oldText === "string" && typeof edit.newText === "string";
}

export interface EditToolDetails {
	/** Display-oriented diff of the changes made */
	diff: string;
	/** Standard unified patch of the changes made */
	patch: string;
	/** Line number of the first change in the new file (for editor navigation) */
	firstChangedLine?: number;
}

/**
 * Pluggable operations for the edit tool.
 * Override these to delegate file editing to remote systems (for example SSH).
 */
export interface EditOperations {
	/** Read file contents as a Buffer */
	readFile: (absolutePath: string) => Promise<Buffer>;
	/** Write content to a file */
	writeFile: (absolutePath: string, content: string) => Promise<void>;
	/** Check if file is readable and writable (throw if not) */
	access: (absolutePath: string) => Promise<void>;
}

const defaultEditOperations: EditOperations = {
	readFile: (path) => fsReadFile(path),
	writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
	access: (path) => fsAccess(path, constants.R_OK | constants.W_OK),
};

export interface EditToolOptions {
	/** Custom operations for file editing. Default: local filesystem */
	operations?: EditOperations;
	/** Shared harness manager: read-before-edit tracking, and the background checks after an edit. */
	harness?: ClaudeHarnessManager;
	/** Enforce that the file was read first and not modified externally since read. */
	enforceReadBeforeEdit?: boolean;
	/** Include a compact line-numbered context snippet around the edited lines in the tool result. */
	includePostEditSnippet?: boolean;
}

function prepareEditArguments(input: unknown): EditToolInput {
	if (!input || typeof input !== "object") {
		return input as EditToolInput;
	}

	const args = input as Record<string, unknown>;

	// Some models (Opus 4.6, GLM-5.1) send edits as a JSON string instead of an array.
	// Others send a single edit object instead of a one-element edits array.
	if (typeof args.edits === "string") {
		try {
			const parsed = JSON.parse(args.edits);
			if (Array.isArray(parsed)) {
				args.edits = parsed;
			} else if (isSingleEditInput(parsed)) {
				args.edits = [parsed];
			}
		} catch {}
	} else if (isSingleEditInput(args.edits)) {
		args.edits = [args.edits];
	}

	const legacy = args as LegacyEditToolInput;
	if (typeof legacy.oldText !== "string" || typeof legacy.newText !== "string") {
		return args as EditToolInput;
	}

	const edits = Array.isArray(legacy.edits) ? [...legacy.edits] : [];
	edits.push({ oldText: legacy.oldText, newText: legacy.newText });
	const { oldText: _oldText, newText: _newText, ...rest } = legacy;
	return { ...rest, edits } as EditToolInput;
}

function validateEditInput(input: EditToolInput): { path: string; edits: Edit[] } {
	if (!Array.isArray(input.edits) || input.edits.length === 0) {
		throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
	}
	return { path: input.path, edits: input.edits };
}

export function createEditToolDefinition(
	cwd: string,
	options?: EditToolOptions,
): ToolDefinition<typeof editSchema, EditToolDetails | undefined, EditRenderState> {
	const ops = options?.operations ?? defaultEditOperations;
	const harness = options?.harness ?? defaultClaudeHarnessManager;
	const enforceReadBeforeEdit = options?.enforceReadBeforeEdit ?? false;
	const includePostEditSnippet = options?.includePostEditSnippet ?? false;
	return {
		name: "edit",
		label: "edit",
		description:
			"Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes. A command that tests the edit can follow it in the same response: the calls run in order.",
		promptSnippet: editToolSystemPromptContribution.snippet,
		promptGuidelines: [...editToolSystemPromptContribution.guidelines],
		parameters: editSchema,
		// A response's calls run in order when one of them changes files or runs a command: an edit and the command that
		// tests it can come in one response (see the system prompt's rule), which saves a turn.
		executionMode: "sequential",
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		renderShell: "self",
		prepareArguments: prepareEditArguments,
		async execute(_toolCallId, input: EditToolInput, signal?: AbortSignal, _onUpdate?, ctx?: ExtensionContext) {
			const { path, edits } = validateEditInput(input);
			const workspaceCwd = ctx?.cwd || cwd;
			const absolutePath = resolveToCwd(path, workspaceCwd);

			return withFileMutationQueue(absolutePath, async () => {
				// Do not reject from an abort event listener here: that would release the
				// mutation queue while an in-flight filesystem operation may still finish.
				// Checking signal.aborted after each await observes the same aborts while
				// keeping the queue locked until the current operation has settled.
				const throwIfAborted = (): void => {
					if (signal?.aborted) throw new Error("Operation aborted");
				};

				throwIfAborted();

				// Check if file exists.
				try {
					await ops.access(absolutePath);
				} catch (error: unknown) {
					throwIfAborted();
					const errorMessage =
						error instanceof Error && "code" in error ? `Error code: ${error.code}` : String(error);
					throw new Error(`Could not edit file: ${path}. ${errorMessage}.`);
				}
				throwIfAborted();

				// Read the file.
				const buffer = await ops.readFile(absolutePath);
				const rawContent = buffer.toString("utf-8");
				throwIfAborted();

				// Strip BOM before matching. The model will not include an invisible BOM in oldText.
				const { bom, text: content } = splitBom(rawContent);
				const originalEnding = detectLineEnding(content);
				const normalizedContent = normalizeToLF(content);

				let changedOnDisk = false;
				let readHere: string | undefined;
				if (enforceReadBeforeEdit) {
					const beforeStat =
						ops === defaultEditOperations ? await fsStat(absolutePath).catch(() => undefined) : undefined;
					if (!harness.stateTracker.hasBeenRead(absolutePath)) {
						// Not read in this session, but seen another way (cat or grep in bash, a search): an edit whose every
						// oldText is there exactly once changes only those places, so the file counts as read now, which also
						// takes the diagnostics it has before the edit. Otherwise it has to be read first.
						if (!editsMatchExactlyOnce(normalizedContent, edits)) {
							harness.assertCanModifyExistingFile(absolutePath, undefined, rawContent);
						}
						readHere = harness.onFileRead(
							absolutePath,
							rawContent,
							beforeStat?.mtimeMs ?? Date.now(),
							workspaceCwd,
							buffer,
						);
					}
					try {
						harness.assertCanModifyExistingFile(absolutePath, beforeStat?.mtimeMs, rawContent);
					} catch (error) {
						// Changed on disk since it was read (a formatter, the user): an edit whose every oldText is still
						// there exactly once changes only those places, so it applies without reading the file again.
						if (!(error instanceof StaleFileError) || !editsMatchExactlyOnce(normalizedContent, edits))
							throw error;
						changedOnDisk = true;
					}
					throwIfAborted();
				}
				let applied: ReturnType<typeof applyEditsToNormalizedContent>;
				try {
					applied = applyEditsToNormalizedContent(normalizedContent, edits, path);
				} catch (error) {
					if (!(error instanceof EditNotFoundError)) throw error;
					const closest = describeClosestText(normalizedContent, edits[error.editIndex].oldText);
					throw closest ? new Error(`${error.message}\n\n${closest}`) : error;
				}
				const { baseContent, newContent } = applied;
				throwIfAborted();

				const finalContent = bom + restoreLineEndings(newContent, originalEnding);
				await ops.writeFile(absolutePath, finalContent);
				throwIfAborted();

				const afterStatPromise =
					enforceReadBeforeEdit && ops === defaultEditOperations
						? fsStat(absolutePath).catch(() => undefined)
						: Promise.resolve(undefined);
				const diffResult = generateDiffString(baseContent, newContent);
				const patch = generateUnifiedPatch(path, baseContent, newContent);
				const afterStat = await afterStatPromise;
				const suffix = harness.onFileModified({
					absolutePath,
					// Track the exact bytes on disk (BOM + original line endings), or the next edit's
					// read-before-edit content check would always report an external modification.
					newContent: finalContent,
					displayContent: newContent,
					newMtimeMs: afterStat?.mtimeMs ?? Date.now(),
					firstChangedLine: diffResult.firstChangedLine,
					includePostEditSnippet,
				});
				return {
					content: [
						{
							type: "text",
							text: `Successfully replaced ${edits.length} block(s) in ${path}.${readHere !== undefined ? " The file had not been read in this session; every oldText matched it exactly once." : ""}${changedOnDisk ? " The file had changed on disk since it was last read; the edit was applied to its current content." : ""}${suffix}${readHere ?? ""}`,
						},
					],
					details: { diff: diffResult.diff, patch, firstChangedLine: diffResult.firstChangedLine },
				};
			});
		},
		...editRenderers,
	};
}

export function createEditTool(cwd: string, options?: EditToolOptions): AgentTool<typeof editSchema> {
	return wrapToolDefinition(createEditToolDefinition(cwd, options));
}
