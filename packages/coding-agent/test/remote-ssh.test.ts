import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createRemoteBashOperations,
	createRemoteEditOperations,
	createRemoteReadOperations,
	createRemoteWriteOperations,
	parseRemoteTarget,
	resolveRemoteDir,
	SshConnection,
} from "../src/core/remote/ssh.ts";
import { writeFakeSsh, writeFakeSshAskingPassphrase } from "./fake-ssh.ts";

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

describe("remote machine over ssh", () => {
	let dir: string;
	let ssh: SshConnection;
	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-remote-"));
		ssh = new SshConnection("fake", { sshCommand: writeFakeSsh(dir) });
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it("parses host:dir", () => {
		expect(parseRemoteTarget("dev:/home/dev/Projects/Radiance")).toEqual({
			host: "dev",
			dir: "/home/dev/Projects/Radiance",
		});
		expect(parseRemoteTarget("me@box")).toEqual({ host: "me@box", dir: "~" });
		expect(parseRemoteTarget("box:~/work")).toEqual({ host: "box", dir: "~/work" });
		expect(parseRemoteTarget("not a host")).toBeUndefined();
	});

	it("resolves the folder there, ~ included", async () => {
		expect(await resolveRemoteDir(ssh, dir)).toBe(dir);
		expect(await resolveRemoteDir(ssh, "~")).toBe(process.env.HOME);
		await expect(resolveRemoteDir(ssh, join(dir, "missing"))).rejects.toThrow(/^Folder .* on fake:/);
	});

	it("reads, writes and edits files there, with any characters in their names", async () => {
		const name = join(dir, "sub dir", 'it\'s "x".txt');
		const write = createRemoteWriteOperations(ssh);
		await write.mkdir(join(dir, "sub dir"));
		expect(await write.readExisting!(name)).toBeUndefined();
		await write.writeFile(name, "a 'quoted' $HOME `x`\n");
		expect(readFileSync(name, "utf-8")).toBe("a 'quoted' $HOME `x`\n");
		expect(await write.readExisting!(name)).toBe("a 'quoted' $HOME `x`\n");
		expect((await createRemoteReadOperations(ssh).readFile(name)).toString()).toBe("a 'quoted' $HOME `x`\n");
		const edit = createRemoteEditOperations(ssh);
		await edit.access(name);
		await expect(edit.access(join(dir, "nope.txt"))).rejects.toMatchObject({ code: "ENOENT" });
		await expect(createRemoteReadOperations(ssh).readFile(join(dir, "nope.txt"))).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("runs a command in the folder there, with its output and exit code", async () => {
		const bash = createRemoteBashOperations(ssh, () => dir);
		const out: Buffer[] = [];
		const result = await bash.exec("pwd; echo err >&2; exit 3", "/ignored", { onData: (d) => out.push(d) });
		expect(result.exitCode).toBe(3);
		expect(Buffer.concat(out).toString()).toContain(dir);
		expect(Buffer.concat(out).toString()).toContain("err");
	});

	it("ends the command there at its timeout and on abort", async () => {
		const bash = createRemoteBashOperations(ssh, () => dir);
		const pidFile = join(dir, "pid1");
		await expect(
			bash.exec(`echo $$ > ${JSON.stringify(pidFile)}; sleep 30`, dir, { onData: () => {}, timeout: 0.5 }),
		).rejects.toThrow("timeout:0.5");
		const pid = Number(readFileSync(pidFile, "utf-8"));
		const deadline = Date.now() + 5_000;
		while (alive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
		expect(alive(pid)).toBe(false);

		const abort = new AbortController();
		const pidFile2 = join(dir, "pid2");
		const running = bash.exec(`echo $$ > ${JSON.stringify(pidFile2)}; sleep 30`, dir, {
			onData: () => {},
			signal: abort.signal,
		});
		while (!existsSync(pidFile2) || !readFileSync(pidFile2, "utf-8")) await new Promise((r) => setTimeout(r, 20));
		abort.abort();
		await expect(running).rejects.toThrow("aborted");
		const pid2 = Number(readFileSync(pidFile2, "utf-8"));
		const deadline2 = Date.now() + 5_000;
		while (alive(pid2) && Date.now() < deadline2) await new Promise((r) => setTimeout(r, 50));
		expect(alive(pid2)).toBe(false);
		mkdirSync(join(dir, "done"), { recursive: true });
	});

	it("hands ssh's passphrase question to askSecret once, and fails without an answer", async () => {
		const askDir = mkdtempSync(join(tmpdir(), "pi-askpass-test-"));
		try {
			const fake = writeFakeSshAskingPassphrase(askDir, "s3cr3t");
			await expect(resolveRemoteDir(new SshConnection("fake", { sshCommand: fake }), dir)).rejects.toThrow(
				"Permission denied (publickey).",
			);
			const prompts: string[] = [];
			const refusing = new SshConnection("fake", { sshCommand: fake, askSecret: async () => undefined });
			await expect(resolveRemoteDir(refusing, dir)).rejects.toThrow("Permission denied (publickey).");
			refusing.close();
			const asking = new SshConnection("fake", {
				sshCommand: fake,
				askSecret: async (prompt) => {
					prompts.push(prompt);
					return "s3cr3t";
				},
			});
			expect(await resolveRemoteDir(asking, dir)).toBe(dir);
			expect(
				(await createRemoteReadOperations(asking).readFile(join(dir, "sub dir", 'it\'s "x".txt'))).length,
			).toBeGreaterThan(0);
			expect(prompts).toEqual(["Enter passphrase for key '/k':"]);
			asking.close();
		} finally {
			rmSync(askDir, { recursive: true, force: true });
		}
	});
});
