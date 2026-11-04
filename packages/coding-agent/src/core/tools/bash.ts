import { randomUUID } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { access as fsAccess } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import type { Writable } from "node:stream";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type ChildProcess, spawn } from "child_process";
import { type Static, Type } from "typebox";
import { findExecutableOnPath, waitForChildProcess } from "../../utils/child-process.ts";
import {
	getDirectGitBash,
	getMsysBash,
	getShellConfig,
	getShellEnv,
	killProcessTree,
	MSYS_SHELL_GROUP_VARIABLE,
	msysShellSpawn,
	type ShellConfig,
	trackDetachedChildPid,
	untrackDetachedChildPid,
} from "../../utils/shell.ts";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { notifySearchExternalChange } from "./native-search.ts";
import { OutputAccumulator } from "./output-accumulator.ts";
import { BASH_UPDATE_THROTTLE_MS, createShellRenderers } from "./renderers/bash.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncationDetails } from "./truncate.ts";

const MAX_TIMEOUT_MS = 2_147_483_647;
/** Output limit of `structuredContent.output`, which programmatic callers such as codemode scripts receive. */
const STRUCTURED_OUTPUT_MAX_BYTES = 1024 * 1024;
/** What the model gets of a command's output: its first lines (the first error) and its end (the summary). */
const BASH_MAX_BYTES = 32 * 1024;
const BASH_HEAD_LINES = 40;
const BASH_HEAD_BYTES = 4 * 1024;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;

function resolveTimeoutMs(timeout: number | undefined): number | undefined {
	if (timeout === undefined) return undefined;
	if (!Number.isFinite(timeout) || timeout <= 0) {
		throw new Error("Invalid timeout: must be a finite number of seconds");
	}

	const timeoutMs = timeout * 1000;
	if (timeoutMs > MAX_TIMEOUT_MS) {
		throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
	}
	return timeoutMs;
}

const bashSchema = Type.Object({
	command: Type.String({ description: "Shell command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
});

export const bashToolSystemPromptContribution = {
	snippet: "Execute bash commands (ls, grep, find, etc.)",
	guidelines: [
		"You can inspect PI_* environment variables for current model and session details.",
		// From deepseek-harness. In Pi's sessions, 80 local `sleep` calls waited 2.8 h for other commands.
		"Do not wait for a command with sleep or a polling loop: give a long command a timeout, after which it goes on in the background and a message reports when it ends. Meanwhile, go on with work that does not depend on it.",
	],
} as const;

export type BashToolInput = Static<typeof bashSchema>;

/**
 * Result for programmatic callers such as codemode scripts. A non-zero exit code is an error result for the model, but scripts still resolve to this value.
 * `output` is not limited like the model-facing output: callers decide how much of it reaches the model.
 */
const bashOutputSchema = Type.Object({
	output: Type.String({ description: "Combined stdout and stderr, possibly truncated" }),
	truncated: Type.Boolean(),
	full_output_path: Type.Optional(Type.String({ description: "Full output, when truncated" })),
	exit_code: Type.Number(),
	wall_time_seconds: Type.Number(),
});

export type BashToolOutput = Static<typeof bashOutputSchema>;

export interface BashToolDetails {
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

/**
 * Pluggable operations for the bash tool.
 * Override these to delegate command execution to remote systems (for example SSH).
 */
export interface BashOperations {
	/**
	 * Execute a command and stream output.
	 * @param command The command to execute
	 * @param cwd Working directory
	 * @param options Execution options
	 * @returns Promise resolving to the exit code. Report signal terminations as 128 + signal number;
	 * a null exit code is treated as a failed command.
	 */
	exec: (
		command: string,
		cwd: string,
		options: {
			onData: (data: Buffer) => void;
			signal?: AbortSignal;
			timeout?: number;
			env?: NodeJS.ProcessEnv;
			/** The process started for the command, for a caller that lets it run on in the background. */
			onSpawn?: (child: ChildProcess) => void;
		},
	) => Promise<{ exitCode: number | null }>;
}

/** Commands a timeout moved to the background, by process id: ended with Pi (as the timeout ended them before). */
const backgroundJobPids = new Set<number>();
let backgroundJobCount = 0;
let backgroundExitHook = false;

function keepAsBackgroundJob(child: ChildProcess | undefined): number | undefined {
	if (!child?.pid) return undefined;
	// It must not keep `pi -p` alive: Pi's exit ends it instead.
	for (const stream of [child.stdout, child.stderr]) {
		(stream as unknown as { unref?: () => void } | null)?.unref?.();
	}
	child.unref();
	backgroundJobPids.add(child.pid);
	if (!backgroundExitHook) {
		backgroundExitHook = true;
		process.once("exit", () => {
			for (const pid of backgroundJobPids) killProcessTree(pid, { sync: true });
		});
	}
	return child.pid;
}

const MOVED_TO_BACKGROUND = Symbol("moved to the background");

function untilTimeout<T>(running: Promise<T>, seconds: number): Promise<T | typeof MOVED_TO_BACKGROUND> {
	let timer: NodeJS.Timeout | undefined;
	return Promise.race([
		running,
		new Promise<typeof MOVED_TO_BACKGROUND>((resolve) => {
			timer = setTimeout(() => resolve(MOVED_TO_BACKGROUND), seconds * 1000);
		}),
	]).finally(() => clearTimeout(timer));
}

/** How much of a background job's output its completion message carries. */
const BACKGROUND_DONE_TAIL_CHARS = 2048;

const SHELL_METACHAR_REGEX = /[|&;<>()$`"'*?[#~=%!{}\r\n\\]/;
const SHELL_KEYWORDS_AND_BUILTINS = new Set([
	"if",
	"then",
	"else",
	"elif",
	"fi",
	"for",
	"while",
	"until",
	"do",
	"done",
	"case",
	"esac",
	"in",
	"function",
	"select",
	"time",
	"coproc",
	"cd",
	"echo",
	"printf",
	"pwd",
	"export",
	"unset",
	"local",
	"declare",
	"typeset",
	"readonly",
	"source",
	".",
	"eval",
	"exec",
	"exit",
	"return",
	"shift",
	"trap",
	"wait",
	"kill",
	"jobs",
	"fg",
	"bg",
	"disown",
	"read",
	"mapfile",
	"readarray",
	"test",
	"[",
	"[[",
	"true",
	"false",
	":",
	"alias",
	"unalias",
	"builtin",
	"command",
	"type",
	"hash",
	"ulimit",
	"umask",
	"shopt",
	"set",
	"pushd",
	"popd",
	"dirs",
	"let",
	"history",
	"help",
	"enable",
	"caller",
	"bind",
	"complete",
	"compgen",
	"compopt",
]);

const directBinaryCache = new Map<string, string | null>();

function tryParseDirectBinaryCommand(
	command: string,
	env: NodeJS.ProcessEnv,
): { executable: string; args: string[] } | undefined {
	const trimmed = command.trim();
	if (!trimmed || SHELL_METACHAR_REGEX.test(trimmed)) return undefined;
	const tokens = trimmed.split(/[ \t]+/);
	if (tokens.length === 0) return undefined;
	const cmdName = tokens[0];
	if (!cmdName || cmdName.includes("=") || SHELL_KEYWORDS_AND_BUILTINS.has(cmdName)) return undefined;
	if (process.platform === "win32") {
		for (let i = 0; i < tokens.length; i++) {
			if (tokens[i].startsWith("/")) return undefined;
		}
	}
	const pathValue = env.PATH ?? env.Path ?? "";
	const cacheKey = `${pathValue}\0${cmdName}`;
	let resolved = directBinaryCache.get(cacheKey);
	if (resolved === undefined) {
		resolved = findExecutableOnPath(cmdName, env) ?? null;
		directBinaryCache.set(cacheKey, resolved);
	}
	if (!resolved) return undefined;
	if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(resolved)) {
		return undefined;
	}
	return { executable: resolved, args: tokens.slice(1) };
}

interface WarmBashProcess {
	child: ChildProcess;
	shellExe: string;
	cwd: string;
	msys?: { bash: string; group: string };
}

let warmBashProcess: WarmBashProcess | undefined;

/** Where a warm shell takes its command: fd 3, or stdin where fd 3 is not used (see WARM_BASH_FD3). */
function warmCommandInput(child: ChildProcess): Writable | undefined {
	return (WARM_BASH_FD3 ? child.stdio[3] : child.stdin) as Writable | undefined;
}

/**
 * Whether a waiting warm shell keeps the process alive: not while it waits (`pi -p` and `--mode json` would never exit
 * once a command ran through it), again once it runs a command. `unref` on the child alone leaves its pipes holding the
 * event loop.
 */
function holdWarmShell(child: ChildProcess, hold: boolean): void {
	for (const stream of [child.stdout, child.stderr, warmCommandInput(child)]) {
		const handle = stream as unknown as { ref?: () => void; unref?: () => void } | null | undefined;
		if (hold) handle?.ref?.();
		else handle?.unref?.();
	}
	if (hold) child.ref();
	else child.unref();
}

function quoteBashSingle(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

/** The lines that turn the warm shell's environment (`baseEnv`) into `targetEnv`: what it adds or changes, and what it removes. */
export function buildEnvDiffScript(baseEnv: NodeJS.ProcessEnv, targetEnv: NodeJS.ProcessEnv): string {
	const name = /^[A-Za-z_][A-Za-z0-9_]*$/;
	let prefix = "";
	for (const [key, val] of Object.entries(targetEnv)) {
		if (!name.test(key)) continue;
		if (val !== undefined && baseEnv[key] !== val) {
			prefix += `export ${key}=${quoteBashSingle(val)}\n`;
		}
	}
	// A variable the target leaves out (PI_* removed for the command, a spawn hook's removal) must not survive from the
	// warm shell's environment.
	for (const [key, val] of Object.entries(baseEnv)) {
		if (val !== undefined && targetEnv[key] === undefined && name.test(key)) {
			prefix += `unset -v ${key}\n`;
		}
	}
	return prefix;
}

/**
 * The warm shell reads its command from fd 3 and runs it with stdin on /dev/null, as a command started normally gets it.
 * Reading the command from stdin instead would hand a command that reads stdin (`read`, `cat` with no file) the rest of its
 * own script. Windows' MSYS shells cannot be handed a fourth descriptor reliably, so they keep reading from stdin.
 */
const WARM_BASH_FD3 = process.platform !== "win32";
const WARM_BASH_FD3_SCRIPT = `IFS= read -r -d '' __pi_command <&3; exec 3<&-; eval "$__pi_command" </dev/null`;

function spawnWarmBashCandidate(
	shellExe: string,
	cwd: string,
	baseEnv: NodeJS.ProcessEnv,
	msysBash: string | undefined,
): WarmBashProcess | undefined {
	try {
		const msys = msysBash ? { bash: msysBash, group: randomUUID() } : undefined;
		const msysSpawn = WARM_BASH_FD3 ? undefined : msysShellSpawn(shellExe, ["-s"]);
		const child = spawn(shellExe, WARM_BASH_FD3 ? ["-c", WARM_BASH_FD3_SCRIPT] : (msysSpawn?.args ?? ["-s"]), {
			cwd,
			detached: process.platform !== "win32",
			env: msys ? { ...baseEnv, [MSYS_SHELL_GROUP_VARIABLE]: msys.group } : baseEnv,
			stdio: WARM_BASH_FD3 ? ["ignore", "pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
			windowsHide: true,
			...(msysSpawn && { windowsVerbatimArguments: true, argv0: msysSpawn.argv0 }),
		});
		child.on("error", () => {
			if (warmBashProcess?.child === child) warmBashProcess = undefined;
		});
		child.on("exit", () => {
			if (warmBashProcess?.child === child) warmBashProcess = undefined;
		});
		holdWarmShell(child, false);
		return { child, shellExe, cwd, msys };
	} catch {
		return undefined;
	}
}

/** Shared process execution used by the built-in shell tools. */
export function createLocalShellOperations(shellName: string, resolveShellConfig: () => ShellConfig): BashOperations {
	return {
		exec: async (command, cwd, { onData, signal, timeout, env, onSpawn }) => {
			const timeoutMs = resolveTimeoutMs(timeout);
			if (signal?.aborted) {
				throw new Error("aborted");
			}
			const shellConfig = resolveShellConfig();
			try {
				await fsAccess(cwd, constants.F_OK);
			} catch {
				throw new Error(`Working directory does not exist: ${cwd}\nCannot execute ${shellName} commands.`);
			}

			const commandFromStdin = shellConfig.commandTransport === "stdin";
			// Windows, Git Bash (or MSYS2, Cygwin): a variable of this command's own that its processes inherit, by which
			// stopping it finds them all (getMsysBash, killProcessTree).
			const msysBash = getMsysBash(shellConfig.shell);
			const direct = commandFromStdin ? undefined : getDirectGitBash(shellConfig.shell);
			const shellExe = direct?.bash ?? shellConfig.shell;
			const baseShellEnv = getShellEnv();
			const rawEnv = env ?? baseShellEnv;
			const shellEnv = direct ? direct.environment(rawEnv) : rawEnv;

			let child: ChildProcess | undefined;
			let msys: { bash: string; group: string } | undefined;

			// Fast-Path 1: Direct Binary Execution for simple single-command invocations without shell metacharacters.
			// Only activate when shellExe actually exists so mocked/invalid shell paths still surface ENOENT as expected.
			const canUseFastPaths =
				shellName === "bash" &&
				!commandFromStdin &&
				shellConfig.args.length === 1 &&
				shellConfig.args[0] === "-c" &&
				(shellExe === "sh" || shellExe === "/bin/bash" || existsSync(shellExe));

			const directBin = canUseFastPaths ? tryParseDirectBinaryCommand(command, shellEnv) : undefined;
			if (directBin) {
				msys = msysBash ? { bash: msysBash, group: randomUUID() } : undefined;
				child = spawn(directBin.executable, directBin.args, {
					cwd,
					detached: process.platform !== "win32",
					env: msys ? { ...shellEnv, [MSYS_SHELL_GROUP_VARIABLE]: msys.group } : shellEnv,
					stdio: ["ignore", "pipe", "pipe"],
					windowsHide: true,
				});
			}

			// Fast-Path 2: Pre-Spawned Warm Bash Standby Worker (0ms process creation + MSYS2 DLL initialization).
			if (!child && canUseFastPaths) {
				const defaultShellEnv = direct ? direct.environment(baseShellEnv) : baseShellEnv;
				if (
					warmBashProcess &&
					warmBashProcess.shellExe === shellExe &&
					warmBashProcess.cwd === cwd &&
					warmBashProcess.child.exitCode === null &&
					!warmBashProcess.child.killed &&
					warmCommandInput(warmBashProcess.child)?.writable
				) {
					const taken = warmBashProcess;
					warmBashProcess = undefined;
					child = taken.child;
					msys = taken.msys;
					holdWarmShell(child, true);
					const envPrefix = env ? buildEnvDiffScript(defaultShellEnv, shellEnv) : "";
					const input = warmCommandInput(child);
					input?.on("error", () => {});
					input?.end(envPrefix ? `${envPrefix}${command}` : command);
					setImmediate(() => {
						if (!warmBashProcess) {
							warmBashProcess = spawnWarmBashCandidate(shellExe, cwd, defaultShellEnv, msysBash);
						}
					});
				} else {
					setImmediate(() => {
						if (!warmBashProcess) {
							warmBashProcess = spawnWarmBashCandidate(shellExe, cwd, defaultShellEnv, msysBash);
						}
					});
				}
			}

			// Standard Shell Spawn Fallback
			if (!child) {
				msys = msysBash ? { bash: msysBash, group: randomUUID() } : undefined;
				const shellArgs = commandFromStdin ? shellConfig.args : [...shellConfig.args, command];
				const msysSpawn = commandFromStdin ? undefined : msysShellSpawn(shellExe, shellArgs);
				child = spawn(shellExe, msysSpawn?.args ?? shellArgs, {
					cwd,
					detached: process.platform !== "win32",
					env: msys ? { ...shellEnv, [MSYS_SHELL_GROUP_VARIABLE]: msys.group } : shellEnv,
					stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
					windowsHide: true,
					...(msysSpawn && { windowsVerbatimArguments: true, argv0: msysSpawn.argv0 }),
				});
				if (commandFromStdin) {
					child.stdin?.on("error", () => {});
					child.stdin?.end(command);
				}
			}
			if (child.pid) trackDetachedChildPid(child.pid, msys);
			onSpawn?.(child);
			let timedOut = false;
			let timeoutHandle: NodeJS.Timeout | undefined;
			const onAbort = () => {
				if (child.pid) killProcessTree(child.pid);
			};

			try {
				// Set timeout if provided.
				if (timeoutMs !== undefined) {
					timeoutHandle = setTimeout(() => {
						timedOut = true;
						if (child.pid) killProcessTree(child.pid);
					}, timeoutMs);
				}
				// Stream stdout and stderr.
				child.stdout?.on("data", onData);
				child.stderr?.on("data", onData);
				// Handle abort signal by killing the entire process tree.
				if (signal) {
					if (signal.aborted) onAbort();
					else signal.addEventListener("abort", onAbort, { once: true });
				}
				// Handle shell spawn errors and wait for the process to terminate without hanging
				// on inherited stdio handles held by detached descendants.
				const exitCode = await waitForChildProcess(child);
				if (signal?.aborted) {
					throw new Error("aborted");
				}
				if (timedOut) {
					throw new Error(`timeout:${timeout}`);
				}
				// A signal-killed shell has no exit code. Use the standard shell convention so
				// callers do not mistake the termination for a successful command.
				const signalCode = child.signalCode;
				return { exitCode: exitCode ?? (signalCode ? 128 + (osConstants.signals[signalCode] ?? 0) : 1) };
			} finally {
				if (child.pid) untrackDetachedChildPid(child.pid);
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (signal) signal.removeEventListener("abort", onAbort);
			}
		},
	};
}

/**
 * Create bash operations using pi's built-in local shell execution backend.
 *
 * This is useful for extensions that intercept user_bash and still want pi's
 * standard local shell behavior while wrapping or rewriting commands.
 */
export function createLocalBashOperations(options?: { shellPath?: string }): BashOperations {
	return createLocalShellOperations("bash", () => getShellConfig(options?.shellPath));
}

export interface BashSpawnContext {
	command: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
}

export type BashSpawnHook = (context: BashSpawnContext) => BashSpawnContext;

function resolveSpawnContext(
	command: string,
	cwd: string,
	spawnHook: BashSpawnHook | undefined,
	exposeSessionEnvironment: boolean,
	ctx: ExtensionContext | undefined,
): BashSpawnContext {
	const env = getShellEnv();
	delete env.PI_SESSION_ID;
	delete env.PI_SESSION_FILE;
	delete env.PI_PROVIDER;
	delete env.PI_MODEL;
	delete env.PI_REASONING_LEVEL;
	if (exposeSessionEnvironment && ctx) {
		const model = ctx.model;
		env.PI_SESSION_ID = ctx.sessionManager.getSessionId();
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (sessionFile) env.PI_SESSION_FILE = sessionFile;
		if (model) {
			env.PI_PROVIDER = model.provider;
			env.PI_MODEL = model.id;
		}
		if (ctx.thinkingLevel) env.PI_REASONING_LEVEL = ctx.thinkingLevel;
	}
	const baseContext: BashSpawnContext = { command, cwd, env };
	return spawnHook ? spawnHook(baseContext) : baseContext;
}

export interface BashToolOptions {
	/** Custom operations for command execution. Default: local shell */
	operations?: BashOperations;
	/** Command prefix prepended to every command (for example shell setup commands) */
	commandPrefix?: string;
	/** Optional explicit shell path from settings */
	shellPath?: string;
	/** Expose current Pi session metadata as PI_* environment variables. Default: true */
	exposeSessionEnvironment?: boolean;
	/** Hook to adjust command, cwd, or env before execution */
	spawnHook?: BashSpawnHook;
	/**
	 * Given, a command still running when its timeout ends goes on in the background instead of being ended: the call
	 * returns its output so far, and this gets the completion message (exit code, end of the output) once it ends.
	 */
	onBackgroundDone?: (message: string) => void;
}

export type BashRenderState = {
	startedAt: number | undefined;
	endedAt: number | undefined;
	interval: NodeJS.Timeout | undefined;
};

export interface ShellToolConfig {
	name: string;
	label: string;
	shellName: string;
	prompt: string;
	promptSnippet: string;
	promptGuidelines?: readonly string[];
	tempFilePrefix: string;
}

export function createShellToolDefinition(
	cwd: string,
	config: ShellToolConfig,
	options?: BashToolOptions,
): ToolDefinition<typeof bashSchema, BashToolDetails | undefined, BashRenderState> {
	const ops = options?.operations ?? createLocalBashOperations({ shellPath: options?.shellPath });
	const commandPrefix = options?.commandPrefix;
	const exposeSessionEnvironment = options?.exposeSessionEnvironment ?? true;
	const spawnHook = options?.spawnHook;
	return {
		name: config.name,
		label: config.label,
		description: `Execute a ${config.shellName} command in the current working directory. Returns stdout and stderr. Output longer than ${DEFAULT_MAX_LINES} lines or ${BASH_MAX_BYTES / 1024}KB keeps its first ${BASH_HEAD_LINES} lines and its end; the full output is then saved to a temp file. Colors and progress-bar redraws are removed. Optionally provide a timeout in seconds${options?.onBackgroundDone ? ": a command still running then goes on in the background, and a message reports when it ends" : ""}.`,
		promptSnippet: config.promptSnippet,
		promptGuidelines: exposeSessionEnvironment && config.promptGuidelines ? [...config.promptGuidelines] : undefined,
		parameters: bashSchema,
		outputSchema: bashOutputSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		async execute(
			_toolCallId,
			{ command, timeout }: { command: string; timeout?: number },
			signal?: AbortSignal,
			onUpdate?,
			ctx?: ExtensionContext,
		) {
			const resolvedCommand = commandPrefix ? `${commandPrefix}\n${command}` : command;
			const spawnContext = resolveSpawnContext(
				resolvedCommand,
				ctx?.cwd || cwd,
				spawnHook,
				exposeSessionEnvironment,
				ctx,
			);
			const output = new OutputAccumulator({
				tempFilePrefix: config.tempFilePrefix,
				maxBytes: BASH_MAX_BYTES,
				clean: true,
				headLines: BASH_HEAD_LINES,
				headBytes: BASH_HEAD_BYTES,
			});
			let acceptingOutput = true;
			let updateTimer: NodeJS.Timeout | undefined;
			let updateDirty = false;
			// The call returned (its command went on in the background): no more updates for it.
			let updatesStopped = false;
			let lastUpdateAt = 0;

			const emitOutputUpdate = () => {
				if (!onUpdate || !updateDirty || updatesStopped) return;
				updateDirty = false;
				lastUpdateAt = Date.now();
				const snapshot = output.snapshot({ persistIfTruncated: true });
				onUpdate({
					content: [{ type: "text", text: snapshot.content || "" }],
					details: {
						truncation: snapshot.truncation.truncated ? truncationDetails(snapshot.truncation) : undefined,
						fullOutputPath: snapshot.fullOutputPath,
					},
				});
			};

			const clearUpdateTimer = () => {
				if (updateTimer) {
					clearTimeout(updateTimer);
					updateTimer = undefined;
				}
			};

			const scheduleOutputUpdate = () => {
				if (!onUpdate || updatesStopped) return;
				updateDirty = true;
				const delay = BASH_UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
				if (delay <= 0) {
					clearUpdateTimer();
					emitOutputUpdate();
					return;
				}
				updateTimer ??= setTimeout(() => {
					updateTimer = undefined;
					emitOutputUpdate();
				}, delay);
			};

			if (onUpdate) {
				onUpdate({ content: [], details: undefined });
			}

			const handleData = (data: Buffer) => {
				if (!acceptingOutput) return;
				output.append(data);
				scheduleOutputUpdate();
			};

			const finishOutput = async () => {
				acceptingOutput = false;
				output.finish();
				clearUpdateTimer();
				emitOutputUpdate();
				const snapshot = output.snapshot({ persistIfTruncated: true });
				try {
					output.closeTempFile();
				} catch (error) {
					// A full disk must not cost the model the output and exit code it already has.
					fullOutputError = error instanceof Error ? error.message : String(error);
				}
				return snapshot;
			};

			let fullOutputError: string | undefined;
			const formatOutput = (snapshot: Awaited<ReturnType<typeof finishOutput>>, emptyText = "(no output)") => {
				const truncation = snapshot.truncation;
				let text = snapshot.content || emptyText;
				let details: BashToolDetails | undefined;
				if (truncation.truncated) {
					details = { truncation: truncationDetails(truncation), fullOutputPath: snapshot.fullOutputPath };
					const startLine = truncation.totalLines - (truncation.outputLines - (snapshot.headLines ?? 0)) + 1;
					const endLine = truncation.totalLines;
					const head = snapshot.headLines ? `lines 1-${snapshot.headLines} and ` : "";
					const fullOutput = snapshot.fullOutputPath
						? `Full output: ${snapshot.fullOutputPath}`
						: "The full output could not be saved";
					if (truncation.lastLinePartial) {
						const lastLineSize = formatSize(output.getLastLineBytes());
						text += `\n\n[Showing ${head}the last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). ${fullOutput}]`;
					} else if (truncation.truncatedBy === "lines") {
						text += `\n\n[Showing ${head || "lines "}${startLine}-${endLine} of ${truncation.totalLines}. ${fullOutput}]`;
					} else {
						text += `\n\n[Showing ${head || "lines "}${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(BASH_MAX_BYTES)} limit). ${fullOutput}]`;
					}
					if (fullOutputError) {
						text += snapshot.fullOutputPath
							? `\n[The full output file is incomplete: ${fullOutputError}]`
							: `\n[${fullOutputError}]`;
					}
				}
				return { text, details };
			};

			const appendStatus = (text: string, status: string) => `${text ? `${text}\n\n` : ""}${status}`;
			const startedAt = performance.now();

			const onBackgroundDone = options?.onBackgroundDone;
			const background =
				onBackgroundDone !== undefined &&
				timeout !== undefined &&
				timeout > 0 &&
				process.env.PI_BASH_BACKGROUND_ON_TIMEOUT !== "off";
			// The command's own abort: the tool call's, until a timeout moves it to the background.
			const commandAbort = new AbortController();
			const forwardAbort = () => commandAbort.abort();
			if (signal?.aborted) commandAbort.abort();
			else signal?.addEventListener("abort", forwardAbort, { once: true });
			let spawned: ChildProcess | undefined;

			try {
				let exitCode: number | null;
				try {
					const running = ops.exec(spawnContext.command, spawnContext.cwd, {
						onData: handleData,
						signal: background ? commandAbort.signal : signal,
						timeout: background ? undefined : timeout,
						env: spawnContext.env,
						onSpawn: (child) => {
							spawned = child;
						},
					});
					const result = background ? await untilTimeout(running, timeout) : await running;
					if (result === MOVED_TO_BACKGROUND) {
						signal?.removeEventListener("abort", forwardAbort);
						updatesStopped = true;
						const id = `bg${++backgroundJobCount}`;
						const pid = keepAsBackgroundJob(spawned);
						const file = output.ensureFullOutputFile();
						const { text, details } = formatOutput(output.snapshot({ persistIfTruncated: true }), "");
						void running
							.then(
								(done) => done.exitCode,
								() => null,
							)
							.then(async (code) => {
								if (pid) backgroundJobPids.delete(pid);
								notifySearchExternalChange();
								const done = await finishOutput();
								const tail = done.content.slice(-BACKGROUND_DONE_TAIL_CHARS);
								const seconds = Math.round((performance.now() - startedAt) / 100) / 10;
								onBackgroundDone?.(
									`Background job ${id} (\`${command}\`) ended ${code === null ? "without an exit code" : `with exit code ${code}`} after ${seconds} s.` +
										`${tail ? `\n\nEnd of its output:\n${tail}` : ""}${file ? `\n\n[Full output: ${file}]` : ""}`,
								);
							});
						const stop = pid
							? ` (pid ${pid}; stop it with: ${process.platform === "win32" ? `taskkill /T /F /PID ${pid}` : `kill -- -${pid}`})`
							: "";
						return {
							content: [
								{
									type: "text",
									text: appendStatus(
										text,
										`Command still running after ${timeout} seconds: moved to the background as job ${id}${stop}. ` +
											`Its output goes on into ${file ?? "memory"}. A message reports when it ends, with its exit code and the end of its output: do not wait or poll for it, go on with other work.`,
									),
								},
							],
							details,
						};
					}
					exitCode = result.exitCode;
				} catch (err) {
					const snapshot = await finishOutput();
					const { text } = formatOutput(snapshot, "");
					if (err instanceof Error && err.message === "aborted") {
						throw new Error(appendStatus(text, "Command aborted"));
					}
					if (err instanceof Error && err.message.startsWith("timeout:")) {
						const timeoutSecs = err.message.split(":")[1];
						throw new Error(appendStatus(text, `Command timed out after ${timeoutSecs} seconds`));
					}
					throw err;
				}

				const snapshot = await finishOutput();
				const { text: outputText, details } = formatOutput(snapshot);
				if (exitCode === null) {
					throw new Error(appendStatus(outputText, "Command terminated without an exit code"));
				}
				const wallTimeSeconds = Math.round((performance.now() - startedAt) / 100) / 10;
				const fullOutput = await output.readFullOutput(STRUCTURED_OUTPUT_MAX_BYTES);
				const structuredContent: BashToolOutput = {
					output: fullOutput.content,
					truncated: fullOutput.truncated,
					...(fullOutput.truncated && snapshot.fullOutputPath
						? { full_output_path: snapshot.fullOutputPath }
						: {}),
					exit_code: exitCode,
					wall_time_seconds: wallTimeSeconds,
				};
				if (exitCode !== 0) {
					return {
						content: [{ type: "text", text: appendStatus(outputText, `Command exited with code ${exitCode}`) }],
						details,
						structuredContent,
						isError: true,
					};
				}
				return { content: [{ type: "text", text: outputText }], details, structuredContent };
			} finally {
				clearUpdateTimer();
				signal?.removeEventListener("abort", forwardAbort);
				// The command may have created, changed or removed files that grep and find hold in their caches.
				notifySearchExternalChange();
			}
		},
		...createShellRenderers(config.prompt),
	};
}

const bashToolConfig: ShellToolConfig = {
	name: "bash",
	label: "bash",
	shellName: "bash",
	prompt: "$",
	promptSnippet: bashToolSystemPromptContribution.snippet,
	promptGuidelines: bashToolSystemPromptContribution.guidelines,
	tempFilePrefix: "pi-bash",
};

export function createBashToolDefinition(
	cwd: string,
	options?: BashToolOptions,
): ToolDefinition<typeof bashSchema, BashToolDetails | undefined, BashRenderState> {
	return createShellToolDefinition(cwd, bashToolConfig, options);
}

export function createBashTool(cwd: string, options?: BashToolOptions): AgentTool<typeof bashSchema> {
	const definition = createBashToolDefinition(cwd, options);
	const tool = wrapToolDefinition(definition);
	Object.assign(tool, {
		promptSnippet: definition.promptSnippet,
		promptGuidelines: definition.promptGuidelines,
	});
	return tool;
}
