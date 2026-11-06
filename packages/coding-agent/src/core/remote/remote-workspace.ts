/**
 * A folder on another machine that read, edit, write and bash work in over ssh (`/remote host:dir`, `--remote`). The
 * session keeps the tools' declarations, so the prompt cache holds: their calls are routed here ({@link routedToRemote})
 * and the system prompt says where they work.
 */

import type { BackgroundJobs } from "../background-jobs.ts";
import type { ToolDefinition } from "../extensions/index.ts";
import { FileTracker } from "../file-tracking/file-tracker.ts";
import type { SessionEntry } from "../session-manager.ts";
import { createBashToolDefinition } from "../tools/bash.ts";
import { createEditToolDefinition } from "../tools/edit.ts";
import { createReadToolDefinition } from "../tools/read.ts";
import { createWriteToolDefinition } from "../tools/write.ts";
import {
	type AskSecret,
	createRemoteBashOperations,
	createRemoteEditOperations,
	createRemoteReadOperations,
	createRemoteWriteOperations,
	type RemoteTarget,
	resolveRemoteDir,
	SshConnection,
} from "./ssh.ts";

/** Built-in tools that work on the remote machine while there is one. */
const REMOTE_ROUTED_TOOLS = new Set(["read", "edit", "write", "bash"]);
/** Built-in tools that search this machine: off while working on another. */
export const REMOTE_PAUSED_TOOLS = new Set(["grep", "find", "ls"]);
/** Custom session entry with the remote machine (a RemoteTarget), or null for this one. */
export const REMOTE_ENTRY = "remote";

export interface RemoteToolOptions {
	backgroundJobs: BackgroundJobs;
	/** Whether the edit tool is there (bash then refuses commands that change files as edit would). */
	editToolActive: () => boolean;
	autoResizeImages: boolean;
}

export class RemoteWorkspace {
	readonly target: RemoteTarget;
	readonly ssh: SshConnection;
	/** `target.dir`, resolved on the host. */
	readonly dir: string;
	/** Read-before-edit for the host's files, apart from this machine's; no diagnostics there. */
	readonly fileTracker = new FileTracker({ local: false });
	private readonly tools: Map<string, ToolDefinition>;

	private constructor(target: RemoteTarget, ssh: SshConnection, dir: string, options: RemoteToolOptions) {
		this.target = target;
		this.ssh = ssh;
		this.dir = dir;
		const fileTracker = this.fileTracker;
		this.tools = new Map<string, ToolDefinition>([
			[
				"read",
				createReadToolDefinition(dir, {
					operations: createRemoteReadOperations(ssh),
					fileTracker,
					autoResizeImages: options.autoResizeImages,
				}) as ToolDefinition,
			],
			[
				"edit",
				createEditToolDefinition(dir, {
					operations: createRemoteEditOperations(ssh),
					fileTracker,
					enforceReadBeforeEdit: true,
					includePostEditSnippet: true,
				}) as ToolDefinition,
			],
			[
				"write",
				createWriteToolDefinition(dir, {
					operations: createRemoteWriteOperations(ssh),
					fileTracker,
					enforceReadBeforeEdit: true,
				}) as ToolDefinition,
			],
			[
				"bash",
				createBashToolDefinition(dir, {
					operations: createRemoteBashOperations(ssh, () => dir),
					backgroundJobs: options.backgroundJobs,
					editToolActive: options.editToolActive,
					exposeSessionEnvironment: false,
				}) as ToolDefinition,
			],
		]);
	}

	/**
	 * Connects to `target` and resolves its folder there. Fails when the folder cannot be reached (without `askSecret`,
	 * ssh runs without asking for passwords). `current` is the workspace the session is in: on the same host, its master
	 * connection stays when this one fails.
	 */
	static async connect(
		target: RemoteTarget,
		options: RemoteToolOptions & { askSecret?: AskSecret; current?: RemoteWorkspace },
	): Promise<RemoteWorkspace> {
		const ssh = new SshConnection(target.host, { askSecret: options.askSecret });
		try {
			return new RemoteWorkspace(target, ssh, await resolveRemoteDir(ssh, target.dir), options);
		} catch (error) {
			if (options.current?.ssh.host === target.host) ssh.release();
			else ssh.close();
			throw error;
		}
	}

	/** The routed tool's implementation here, for a tool that works on the remote machine. */
	tool(name: string): ToolDefinition | undefined {
		return this.tools.get(name);
	}

	/** The system prompt's section on where the tools work. */
	promptSection(): string {
		return `read, edit, write and bash work on the machine ${this.target.host} over ssh, in ${this.dir}: paths are that machine's. grep, find and ls are off (they search this machine): search there with rg or find in bash. Edits there get no compiler diagnostics. Project context files and skills above are this machine's.`;
	}

	/** Lets go of this workspace for `next`: the master connection stays when `next` is on the same host. */
	leave(next: RemoteWorkspace | undefined): void {
		if (this.ssh.host === next?.ssh.host) this.ssh.release();
		else this.ssh.close();
	}
}

/**
 * `definition` (a built-in tool) as it runs on the remote machine `current()` returns while there is one: its
 * declaration stays the local tool's, and the context it gets says the remote folder is the working folder.
 */
export function routedToRemote(
	name: string,
	definition: ToolDefinition,
	current: () => RemoteWorkspace | undefined,
): ToolDefinition {
	if (!REMOTE_ROUTED_TOOLS.has(name)) return definition;
	return {
		...definition,
		execute: (toolCallId, params, signal, onUpdate, ctx) => {
			const remote = current();
			const tool = remote?.tool(name);
			if (!remote || !tool) return definition.execute(toolCallId, params, signal, onUpdate, ctx);
			const remoteCtx = new Proxy(ctx, {
				get: (t, key, receiver) => (key === "cwd" ? remote.dir : Reflect.get(t, key, receiver)),
			});
			return tool.execute(toolCallId, params, signal, onUpdate, remoteCtx);
		},
	};
}

/** The remote machine the latest `remote` entry of `branch` names: null for this machine, undefined for no entry. */
export function savedRemoteTarget(branch: SessionEntry[]): RemoteTarget | null | undefined {
	const entry = branch.findLast((e) => e.type === "custom" && e.customType === REMOTE_ENTRY);
	return entry?.type === "custom" ? (entry.data as RemoteTarget | null) : undefined;
}
