import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type BackgroundJob, BackgroundJobs, formatJobReport } from "../src/core/background-jobs.ts";
import { createBashTool, fixedSleepSeconds, leadingSleep } from "../src/core/tools/bash.ts";
import { createWaitTool, WAIT_LADDER_MS } from "../src/core/tools/wait.ts";

function getText(result: { content?: Array<{ type: string; text?: string }> }): string {
	return (result.content ?? []).map((part) => part.text ?? "").join("");
}

function ended(jobs: BackgroundJobs, id: string): Promise<BackgroundJob> {
	return new Promise((resolve) => {
		const job = jobs.get(id);
		if (job && job.status !== "running") return resolve(job);
		const unsubscribe = jobs.subscribe((event) => {
			if (event.type === "end" && event.job.id === id) {
				unsubscribe();
				resolve(event.job);
			}
		});
	});
}

/** A job that ends when the test says so. */
function fakeJob(jobs: BackgroundJobs, command: string) {
	return jobs.add({
		command,
		cwd: "/",
		pid: undefined,
		startedAt: Date.now(),
		outputFile: undefined,
		output: () => "",
		kill: () => {},
	});
}

describe("background jobs", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-jobs-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("moves a command still running after its time to the background, and records its end and output", async () => {
		const jobs = new BackgroundJobs();
		const bash = createBashTool(dir, { backgroundJobs: jobs, autoBackgroundSeconds: 0.2 });
		const start = performance.now();
		const result = await bash.execute("bg-1", { command: "echo started; sleep 0.6; echo finished" });
		expect(performance.now() - start).toBeLessThan(500);
		const text = getText(result);
		expect(text).toContain("started");
		expect(text).toContain("Command still running after 0.2 seconds: moved to the background as job bg1");
		expect(jobs.running().map((job) => job.id)).toEqual(["bg1"]);

		const job = await ended(jobs, "bg1");
		expect(job).toMatchObject({ status: "done", exitCode: 0 });
		const report = formatJobReport(jobs.takeUnreported());
		expect(report).toMatch(/Background job bg1 \(`echo started; sleep 0\.6; echo finished`\) ended with exit code 0/);
		expect(report).toContain("finished");
		expect(job.outputFile && readFileSync(job.outputFile, "utf-8")).toBe("started\nfinished\n");
		expect(jobs.takeUnreported()).toEqual([]);
	});

	it("starts a command in the background right away when the call asks", async () => {
		const jobs = new BackgroundJobs();
		const bash = createBashTool(dir, { backgroundJobs: jobs });
		const start = performance.now();
		const result = await bash.execute("bg-2", { command: "sleep 0.3; echo late", background: true });
		expect(performance.now() - start).toBeLessThan(250);
		expect(getText(result)).toMatch(/^Started in the background as job bg1 \(pid \d+/);
		expect(jobs.get("bg1")?.pid).toBeGreaterThan(0);
		expect(await ended(jobs, "bg1")).toMatchObject({ status: "done", tail: "late\n" });
	});

	it("moves a command to the background at its timeout, instead of ending it", async () => {
		const jobs = new BackgroundJobs();
		const bash = createBashTool(dir, { backgroundJobs: jobs, autoBackgroundSeconds: 5 });
		const start = performance.now();
		const result = await bash.execute("bg-3", { command: "echo waiting; sleep 0.6; echo built", timeout: 0.2 });
		expect(performance.now() - start).toBeLessThan(500);
		expect(getText(result)).toContain(
			"Command still running at its timeout of 0.2 seconds: moved to the background as job bg1",
		);
		expect(getText(result)).not.toContain("still ends it");
		expect(await ended(jobs, "bg1")).toMatchObject({ status: "done", exitCode: 0, tail: "waiting\nbuilt\n" });
	});

	it("ends at its timeout a command without background jobs", async () => {
		const bash = createBashTool(dir);
		await expect(bash.execute("bg-3b", { command: "sleep 3", timeout: 0.2 })).rejects.toThrow(
			"Command timed out after 0.2 seconds",
		);
	});

	it("ends a job started in the background at its timeout, and as killed when stopped", async () => {
		const jobs = new BackgroundJobs();
		const bash = createBashTool(dir, { backgroundJobs: jobs, autoBackgroundSeconds: 0.1 });
		const timed = await bash.execute("bg-4", { command: "sleep 5", timeout: 0.6, background: true });
		expect(getText(timed)).toContain("its timeout of 0.6 seconds still ends it");
		await bash.execute("bg-5", { command: "sleep 5", background: true });
		expect(jobs.kill("bg2")).toBe(true);
		expect(await ended(jobs, "bg2")).toMatchObject({ status: "killed" });
		expect(await ended(jobs, "bg1")).toMatchObject({ status: "timed out", exitCode: null });
		expect(formatJobReport(jobs.takeUnreported())).toMatch(
			/2 background jobs ended\.[\s\S]*bg1 \(`sleep 5`\) was stopped by its timeout after 0\.6 s[\s\S]*bg2 \(`sleep 5`\) was stopped after/,
		);
	});

	it("ends background jobs with Pi, and does not keep Pi running for them", () => {
		const script = join(dir, "exit-with-job.ts");
		const src = join(import.meta.dirname, "..", "src", "core");
		writeFileSync(
			script,
			`import { createBashTool } from ${JSON.stringify(join(src, "tools", "bash.ts"))};\n` +
				`import { BackgroundJobs } from ${JSON.stringify(join(src, "background-jobs.ts"))};\n` +
				`const tool = createBashTool(${JSON.stringify(dir)}, { backgroundJobs: new BackgroundJobs() });\n` +
				`const r = await tool.execute("x", { command: "sleep 30; echo late", background: true });\n` +
				`console.log(r.content[0].text.match(/pid (\\d+)/)[1]);\n`,
		);
		const start = performance.now();
		const result = spawnSync(process.execPath, [script], { timeout: 15_000, encoding: "utf-8" });
		expect(result.status).toBe(0);
		expect(performance.now() - start).toBeLessThan(10_000);
		const pid = Number(result.stdout.trim());
		expect(pid).toBeGreaterThan(0);
		expect(() => process.kill(pid, 0)).toThrow();
	});

	it("puts jobs that end close together into one wait", async () => {
		const jobs = new BackgroundJobs();
		const a = fakeJob(jobs, "a");
		const b = fakeJob(jobs, "b");
		const c = fakeJob(jobs, "c");
		const waiting = jobs.waitForEnd(5_000);
		expect(jobs.hasWaiters()).toBe(true);
		setTimeout(() => a.end("done", 0, ""), 20);
		setTimeout(() => b.end("failed", 2, ""), 200);
		const start = performance.now();
		expect(await waiting).toBe("ended");
		// b ended within the window; c still runs, so the window ran out.
		expect(performance.now() - start).toBeGreaterThan(1_400);
		expect(jobs.takeUnreported().map((job) => job.id)).toEqual(["bg1", "bg2"]);
		expect(jobs.hasWaiters()).toBe(false);
		c.end("done", 0, "");
	});

	it("ends a wait early on wake, on abort, and at once when every job ended", async () => {
		const jobs = new BackgroundJobs();
		const a = fakeJob(jobs, "a");
		const woken = jobs.waitForEnd(5_000);
		jobs.wake();
		expect(await woken).toBe("woken");
		const abort = new AbortController();
		const aborted = jobs.waitForEnd(5_000, abort.signal);
		abort.abort();
		expect(await aborted).toBe("aborted");
		const start = performance.now();
		const last = jobs.waitForEnd(5_000);
		a.end("done", 0, "");
		expect(await last).toBe("ended");
		expect(performance.now() - start).toBeLessThan(500);
	});
});

describe("wait tool", () => {
	it("returns at once when no job runs", async () => {
		const wait = createWaitTool({ backgroundJobs: new BackgroundJobs() });
		expect(getText(await wait.execute("w", {}))).toBe("Nothing to wait for: no background job is running.");
	});

	it("returns the report of a job that ends while it waits, once", async () => {
		const jobs = new BackgroundJobs();
		const job = fakeJob(jobs, "make");
		const wait = createWaitTool({ backgroundJobs: jobs });
		setTimeout(() => job.end("failed", 2, "error: x\n"), 50);
		const text = getText(await wait.execute("w", {}));
		expect(text).toMatch(
			/^Background job bg1 \(`make`\) ended with exit code 2 after [\d.]+ s\.\n\nEnd of its output:\nerror: x/,
		);
		expect(jobs.takeUnreported()).toEqual([]);
		expect(getText(await wait.execute("w2", {}))).toBe("Nothing to wait for: no background job is running.");
	});

	it("waits longer each time nothing ends, and asks for other work from the second empty wait on", async () => {
		const jobs = new BackgroundJobs();
		fakeJob(jobs, "slow");
		const wait = createWaitTool({ backgroundJobs: jobs });
		const durations: number[] = [];
		const texts: string[] = [];
		const realWait = jobs.waitForEnd.bind(jobs);
		jobs.waitForEnd = async (ms, signal) => {
			durations.push(ms);
			return realWait(1, signal);
		};
		for (let i = 0; i < 3; i++) texts.push(getText(await wait.execute(`w${i}`, {})));
		expect(durations).toEqual([WAIT_LADDER_MS[0], WAIT_LADDER_MS[1], WAIT_LADDER_MS[2]]);
		expect(texts[0]).toMatch(/^No background job ended within 120 s\. Running: bg1 \(`slow`, running [\d.]+ s\)\.$/);
		expect(texts[1]).toContain("Nothing ended after 420 s of back-to-back waits. Waiting is not progress");
		expect(texts[2]).toContain("Nothing ended after 1020 s of back-to-back waits.");
	});
});

describe("fixed sleeps", () => {
	it("finds the longest fixed sleep outside a loop", () => {
		expect(fixedSleepSeconds("sleep 295; tail -1 build.log")).toBe(295);
		expect(fixedSleepSeconds("cd x && sleep 2m && make")).toBe(120);
		expect(fixedSleepSeconds("sleep 3; curl localhost:8000 && sleep 25")).toBe(25);
		expect(fixedSleepSeconds("ssh host 'cd /w && nohup ./run.sh & sleep 30'")).toBe(30);
		expect(fixedSleepSeconds("until grep -q EXIT log; do sleep 30; done")).toBe(0);
		expect(fixedSleepSeconds("while ! curl -sf x; do sleep 60; done")).toBe(0);
		expect(fixedSleepSeconds("for i in 1 2; do sleep 20; for j in a; do sleep 30; done; done; echo")).toBe(0);
		expect(fixedSleepSeconds("sleep 20; for i in 1 2 3; do curl x; done")).toBe(20);
		expect(fixedSleepSeconds("sleep 20; python3 -c 'for x in y: print(x)'")).toBe(20);
		expect(fixedSleepSeconds("grep -r sleeping src; echo nosleep 50")).toBe(0);
		expect(fixedSleepSeconds("time.sleep(30)")).toBe(0);
	});

	it("finds a sleep the command starts with", () => {
		expect(leadingSleep("sleep 45; tail -5 build.log")).toEqual({ seconds: 45, rest: "tail -5 build.log" });
		expect(leadingSleep("  sleep 2m && make")).toEqual({ seconds: 120, rest: "make" });
		expect(leadingSleep("sleep 20\nls")).toEqual({ seconds: 20, rest: "ls" });
		expect(leadingSleep("sleep 30")).toEqual({ seconds: 30, rest: "" });
		expect(leadingSleep("sleep 30 & echo started")).toBeUndefined();
		expect(leadingSleep("cd x; sleep 30; ls")).toBeUndefined();
	});

	it("sleeps for a command that looks at a job after a while, and stops when a job ends", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-sleep-"));
		try {
			const jobs = new BackgroundJobs();
			const job = fakeJob(jobs, "make");
			const bash = createBashTool(dir, { backgroundJobs: jobs });
			setTimeout(() => job.end("done", 0, ""), 200);
			const start = performance.now();
			const result = await bash.execute("s0", { command: "sleep 45; echo looked" });
			expect(performance.now() - start).toBeLessThan(2000);
			// The report of the job comes with the result, not as a message after it.
			expect(getText(result)).toMatch(
				/^\[The sleep of 45 s ended after \d\.\d s: a background job ended\.\]\nBackground job bg1 \(`make`\) ended with exit code 0[\s\S]*\n\nlooked\n$/,
			);
			expect(jobs.takeUnreported()).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not run a command that sleeps longer than a command runs before it goes to the background", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-sleep-"));
		try {
			const jobs = new BackgroundJobs();
			const bash = createBashTool(dir, { backgroundJobs: jobs, autoBackgroundSeconds: 20 });
			const start = performance.now();
			await expect(bash.execute("s1", { command: "sleep 30; echo checked" })).rejects.toThrow(
				/^Not run: the command sleeps 30 seconds, a fixed time longer than a command runs before it goes to the background \(20 s\)\. To wait for a background job, call wait/,
			);
			expect(performance.now() - start).toBeLessThan(500);
			expect(getText(await bash.execute("s2", { command: "sleep 0.1; echo short" }))).toBe("short\n");
			expect(getText(await bash.execute("s3", { command: "sleep 30", background: true }))).toMatch(
				/^Started in the background/,
			);
			// Without jobs (no wait, no background), the tool runs what it gets.
			const plain = createBashTool(dir);
			expect(getText(await plain.execute("s4", { command: "sleep 11 & echo ran" }))).toContain("ran");
			jobs.killAll();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
