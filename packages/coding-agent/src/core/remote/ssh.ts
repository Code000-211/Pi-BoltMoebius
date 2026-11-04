/**
 * Working on another machine over ssh: the operations the read, edit, write and bash tools run there.
 *
 * One ssh master connection is kept per host (ControlMaster), so each operation costs a round trip, not a new login.
 * A command started through bash is ended on the remote machine when its local ssh ends (abort, timeout, a stopped
 * background job, Pi's exit): it runs in its own process group there, and a watcher ends that group when the ssh
 * connection's input closes.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, posix } from "node:path";
import { killProcessTree } from "../../utils/shell.ts";
import type { BashOperations } from "../tools/bash.ts";
import type { EditOperations } from "../tools/edit.ts";
import type { ReadOperations } from "../tools/read.ts";
import type { WriteOperations } from "../tools/write.ts";

export interface RemoteTarget {
	/** What ssh connects to: a host, `user@host`, or an alias from ~/.ssh/config. */
	host: string;
	/** The folder on that machine the tools work in (absolute). */
	dir: string;
}

/** Parses `host:/dir` (or `host`, then the home folder there). */
export function parseRemoteTarget(spec: string): RemoteTarget | undefined {
	const match = /^([^\s:/]+(?:@[^\s:/]+)?)(?::(\S*))?$/.exec(spec.trim());
	if (!match) return undefined;
	const dir = match[2] ? match[2] : "~";
	return { host: match[1]!, dir };
}

export function formatRemoteTarget(target: RemoteTarget): string {
	return `${target.host}:${target.dir}`;
}

/** Quotes a word for a POSIX shell (and fish, whose single quotes take `'\''` too). */
export function shellQuote(word: string): string {
	return `'${word.replace(/'/g, "'\\''")}'`;
}

export interface RunResult {
	stdout: Buffer;
	stderr: string;
	code: number | null;
}

/** Answers what ssh asks (a key's passphrase, a password, a new host key), or undefined to give up. */
export type AskSecret = (prompt: string) => Promise<string | undefined>;

/**
 * An SSH_ASKPASS program that hands ssh's question to Pi and its answer back, through two FIFOs in a private folder:
 * nothing is written to disk, and Pi keeps nothing once it answered.
 */
class AskpassBridge {
	readonly program: string;
	private readonly dir: string;
	private closed = false;
	private readonly ask: AskSecret;

	constructor(ask: AskSecret) {
		this.ask = ask;
		this.dir = mkdtempSync(join(tmpdir(), "pi-askpass-"));
		chmodSync(this.dir, 0o700);
		const request = join(this.dir, "request");
		const response = join(this.dir, "response");
		for (const fifo of [request, response]) {
			if (spawnSync("mkfifo", ["-m", "600", fifo]).status !== 0) throw new Error("mkfifo failed");
		}
		this.program = join(this.dir, "askpass");
		writeFileSync(
			this.program,
			`#!/bin/sh
printf '%s\n' "$1" > ${shellQuote(request)}
answer=$(cat ${shellQuote(response)})
[ "$answer" = "${CANCEL}" ] && exit 1
printf '%s\n' "$answer"
`,
			{ mode: 0o700 },
		);
		void this.serve(request, response);
	}

	private async serve(request: string, response: string): Promise<void> {
		while (!this.closed) {
			let prompt: string;
			try {
				prompt = (await readFile(request, "utf-8")).trim();
			} catch {
				return;
			}
			if (this.closed) return;
			const answer = await this.ask(prompt).catch(() => undefined);
			await writeFile(response, answer ?? CANCEL).catch(() => {});
		}
	}

	close(): void {
		this.closed = true;
		// Unblocks the pending read of the request FIFO.
		const unblock = spawn("sh", ["-c", `printf '' > ${shellQuote(join(this.dir, "request"))}`], { stdio: "ignore" });
		unblock.on("error", () => {});
		unblock.on("close", () => rmSync(this.dir, { recursive: true, force: true }));
	}
}

const CANCEL = "__pi_askpass_cancelled__";

/** ssh to one host, sharing one master connection. */
export class SshConnection {
	readonly host: string;
	private readonly ssh: string;
	private readonly controlPath: string;
	private readonly askpass: AskpassBridge | undefined;

	/**
	 * Without `askSecret`, ssh may not ask anything (BatchMode): it needs a key without passphrase or an agent. With it,
	 * ssh's questions go to `askSecret`; the master connection then lasts 4 hours, so they come once per connection.
	 */
	constructor(host: string, options?: { sshCommand?: string; askSecret?: AskSecret }) {
		this.host = host;
		this.ssh = options?.sshCommand ?? process.env.PI_SSH_COMMAND ?? "ssh";
		const sshDir = join(homedir(), ".ssh");
		// %C is a hash of the connection: short enough for a socket path.
		this.controlPath = join(existsSync(sshDir) ? sshDir : tmpdir(), "pi-%C");
		this.askpass =
			options?.askSecret && process.platform !== "win32" ? new AskpassBridge(options.askSecret) : undefined;
	}

	private args(remoteCommand: string): string[] {
		return [
			"-o",
			`BatchMode=${this.askpass ? "no" : "yes"}`,
			"-o",
			"ControlMaster=auto",
			"-o",
			`ControlPath=${this.controlPath}`,
			"-o",
			`ControlPersist=${this.askpass ? "4h" : "600"}`,
			"-o",
			"ServerAliveInterval=15",
			"-o",
			"ServerAliveCountMax=3",
			this.host,
			"--",
			remoteCommand,
		];
	}

	/** Starts `script` under /bin/sh on the host. */
	spawn(script: string): ChildProcess {
		return spawn(this.ssh, this.args(`exec /bin/sh -c ${shellQuote(script)}`), {
			stdio: ["pipe", "pipe", "pipe"],
			detached: process.platform !== "win32",
			windowsHide: true,
			env: this.askpass
				? {
						...process.env,
						SSH_ASKPASS: this.askpass.program,
						SSH_ASKPASS_REQUIRE: "force",
						DISPLAY: process.env.DISPLAY ?? ":0",
					}
				: process.env,
		});
	}

	/** Runs `script` under /bin/sh on the host, with `input` on its standard input. */
	run(script: string, options?: { input?: string | Buffer; signal?: AbortSignal }): Promise<RunResult> {
		return new Promise((resolve, reject) => {
			const child = this.spawn(script);
			const stdout: Buffer[] = [];
			const stderr: Buffer[] = [];
			const onAbort = () => child.kill();
			options?.signal?.addEventListener("abort", onAbort, { once: true });
			child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
			child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
			child.on("error", (error) => {
				options?.signal?.removeEventListener("abort", onAbort);
				reject(new Error(`ssh ${this.host} could not start: ${error.message}`));
			});
			child.on("close", (code) => {
				options?.signal?.removeEventListener("abort", onAbort);
				if (options?.signal?.aborted) return reject(new Error("aborted"));
				resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString("utf-8"), code });
			});
			child.stdin?.on("error", () => {});
			child.stdin?.end(options?.input ?? "");
		});
	}

	/** Like {@link run}, but fails with ssh's or the command's error when it does not exit with 0. */
	async check(script: string, what: string, options?: { input?: string | Buffer }): Promise<Buffer> {
		const result = await this.run(script, options);
		if (result.code === 0) return result.stdout;
		const message = result.stderr.trim() || `exit code ${result.code}`;
		const error = new Error(`${what} on ${this.host}: ${message}`) as Error & { code?: string };
		if (/No such file|cannot open/i.test(message)) error.code = "ENOENT";
		else if (/Permission denied/i.test(message) && result.code !== 255) error.code = "EACCES";
		throw error;
	}

	/** Ends the master connection. */
	close(): void {
		this.askpass?.close();
		const child = spawn(this.ssh, ["-o", `ControlPath=${this.controlPath}`, "-O", "exit", this.host], {
			stdio: "ignore",
		});
		child.on("error", () => {});
		child.unref();
	}
}

/** The folder `dir` names on the host, with `~` expanded there. */
export async function resolveRemoteDir(ssh: SshConnection, dir: string): Promise<string> {
	const path = dir === "~" ? "$HOME" : dir.startsWith("~/") ? `"$HOME"/${shellQuote(dir.slice(2))}` : shellQuote(dir);
	const out = await ssh.check(`export LC_ALL=C; cd ${path} && pwd -P`, `Folder ${dir}`);
	return out.toString("utf-8").trim();
}

/** Resolves a path against the remote folder (paths there are POSIX). */
export function resolveRemotePath(path: string, dir: string): string {
	const clean = path.replace(/^@/, "");
	return posix.resolve(dir, clean.startsWith("~/") ? clean.slice(2) : clean);
}

export function createRemoteReadOperations(ssh: SshConnection): ReadOperations {
	return {
		readFile: (path) => ssh.check(`export LC_ALL=C; cat -- ${shellQuote(path)}`, `Reading ${path}`),
		access: async (path) => {
			await ssh.check(`test -r ${shellQuote(path)} || { echo "No such file: ${path}" >&2; exit 1; }`, "Access");
		},
		detectImageMimeType: async () => null,
	};
}

export function createRemoteEditOperations(ssh: SshConnection): EditOperations {
	return {
		readFile: (path) => ssh.check(`export LC_ALL=C; cat -- ${shellQuote(path)}`, `Reading ${path}`),
		writeFile: async (path, content) => {
			await ssh.check(`export LC_ALL=C; cat > ${shellQuote(path)}`, `Writing ${path}`, { input: content });
		},
		access: async (path) => {
			const p = shellQuote(path);
			await ssh.check(
				`test -e ${p} || { echo "No such file: ${path}" >&2; exit 1; }; test -r ${p} && test -w ${p} || { echo "Permission denied: ${path}" >&2; exit 1; }`,
				"Access",
			);
		},
	};
}

export function createRemoteWriteOperations(ssh: SshConnection): WriteOperations {
	return {
		writeFile: async (path, content) => {
			await ssh.check(`export LC_ALL=C; cat > ${shellQuote(path)}`, `Writing ${path}`, { input: content });
		},
		mkdir: async (dir) => {
			await ssh.check(`export LC_ALL=C; mkdir -p -- ${shellQuote(dir)}`, `Creating ${dir}`);
		},
		readExisting: async (path) => {
			const result = await ssh.run(`test -f ${shellQuote(path)} && cat -- ${shellQuote(path)}`);
			return result.code === 0 ? result.stdout.toString("utf-8") : undefined;
		},
	};
}

/**
 * The command in its own process group on the host, and a watcher that ends that group when the connection's input
 * closes (the local ssh ended). Exits with the command's exit code.
 */
function remoteBashScript(command: string, dir: string): string {
	// bash for `set -m`: with job control on, the command's job gets a process group of its own.
	const body = [
		"set -m",
		`cd ${shellQuote(dir)} || exit 1`,
		"export NO_COLOR=1",
		`bash -c ${shellQuote(command)} </dev/null &`,
		"pid=$!",
		"( while read -r _; do :; done; kill -TERM -$pid 2>/dev/null ) &",
		"watcher=$!",
		"wait $pid",
		"code=$?",
		"kill $watcher 2>/dev/null",
		"exit $code",
	].join("\n");
	return `exec bash -c ${shellQuote(body)}`;
}

/** How long ssh gets to end after its input closed (the command on the host is ended then) before it is killed. */
const SSH_STOP_GRACE_MS = 2000;

export function createRemoteBashOperations(ssh: SshConnection, dir: () => string): BashOperations {
	return {
		exec: (command, _cwd, { onData, signal, timeout, onSpawn }) =>
			new Promise((resolve, reject) => {
				if (signal?.aborted) return reject(new Error("aborted"));
				const child = ssh.spawn(remoteBashScript(command, dir()));
				onSpawn?.(child);
				let timedOut = false;
				// Closing the input ends the command on the host (its watcher), and then ssh; kill ssh if it hangs.
				let killTimer: ReturnType<typeof setTimeout> | undefined;
				const stop = () => {
					child.stdin?.end();
					killTimer ??= setTimeout(() => {
						if (child.pid) killProcessTree(child.pid);
						else child.kill();
					}, SSH_STOP_GRACE_MS);
					killTimer.unref?.();
				};
				const onTimeout = () => {
					timedOut = true;
					stop();
				};
				const timer = timeout && timeout > 0 ? setTimeout(onTimeout, timeout * 1000) : undefined;
				const onAbort = () => stop();
				signal?.addEventListener("abort", onAbort, { once: true });
				child.stdout?.on("data", onData);
				child.stderr?.on("data", onData);
				child.stdin?.on("error", () => {});
				child.on("error", (error) => reject(new Error(`ssh ${ssh.host} could not start: ${error.message}`)));
				child.on("close", (code) => {
					clearTimeout(timer);
					clearTimeout(killTimer);
					signal?.removeEventListener("abort", onAbort);
					if (timedOut) return reject(new Error(`timeout:${timeout}`));
					if (signal?.aborted) return reject(new Error("aborted"));
					resolve({ exitCode: code });
				});
			}),
	};
}
