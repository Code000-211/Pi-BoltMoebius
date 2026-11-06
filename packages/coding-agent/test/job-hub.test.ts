import { stripVTControlCharacters } from "node:util";
import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BackgroundJobs } from "../src/core/background-jobs.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { formatJobDuration, JobHubComponent, jobStatusText } from "../src/modes/interactive/components/job-hub.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

beforeAll(() => {
	initTheme("dark");
});

beforeEach(() => {
	setKeybindings(new KeybindingsManager());
});

function setup(rows = 24) {
	const jobs = new BackgroundJobs();
	const killed: string[] = [];
	let output = "line 1\nline 2\nbuilding...\n";
	const add = (command: string, startedAgo: number) =>
		jobs.add(
			{
				command,
				cwd: "/work",
				pid: 4242,
				startedAt: Date.now() - startedAgo,
				outputFile: "/tmp/out.log",
				output: () => output,
				kill: () => killed.push(command),
			},
			Date.now() - startedAgo + 60_000,
		);
	const build = add("cargo build --release", 125_000);
	const test = add("cargo test", 10_000);
	test.end("failed", 101, "test result: FAILED\n");
	let closed = 0;
	let renders = 0;
	const hub = new JobHubComponent(jobs, {
		rows: () => rows,
		requestRender: () => renders++,
		onClose: () => closed++,
	});
	const screen = () => hub.render(100).map((line) => stripVTControlCharacters(line));
	return {
		jobs,
		hub,
		build,
		screen,
		killed,
		closed: () => closed,
		renders: () => renders,
		setOutput: (text: string) => {
			output = text;
		},
	};
}

describe("job hub", () => {
	it("lists the jobs newest first with status and time, and the selected one's details and output", () => {
		const { hub, screen } = setup();
		const lines = screen();
		expect(lines[1]).toMatch(/^Jobs {2}1 running · 1 ended/);
		const rows = lines.filter((line) => /bg\d/.test(line) && /running|exit/.test(line));
		expect(rows[0]).toMatch(/^› ✗ bg2 {3}exit 101 +10s {2}cargo test/);
		expect(rows[1]).toMatch(/^ {2}● bg1 {3}running +2m 5s {2}cargo build --release/);
		// The newest is selected: its end of output (it ended).
		expect(lines.join("\n")).toContain("command cargo test");
		expect(lines.join("\n")).toContain("test result: FAILED");
		expect(lines).toHaveLength(24);
		expect(lines.every((line) => visibleWidth(line) <= 100)).toBe(true);
		hub.dispose();
	});

	it("selects with the arrow keys, stops a running job with x, and closes with Escape", () => {
		const { hub, screen, killed, closed } = setup();
		hub.handleInput("x");
		expect(killed).toEqual([]);
		hub.handleInput("\x1b[B");
		expect(screen().join("\n")).toContain("command cargo build --release");
		expect(screen().join("\n")).toContain("building...");
		expect(screen().at(-1)).toContain("x stop");
		hub.handleInput("x");
		expect(killed).toEqual(["cargo build --release"]);
		hub.handleInput("\x1b");
		expect(closed()).toBe(1);
		hub.dispose();
	});

	it("shows the whole output on Enter, scrolls it, and goes back on Escape", () => {
		const { hub, screen, setOutput, closed } = setup(10);
		setOutput(`${Array.from({ length: 30 }, (_, i) => `out ${i + 1}`).join("\n")}\n`);
		hub.handleInput("\x1b[B");
		hub.handleInput("\r");
		let lines = screen();
		expect(lines[1]).toMatch(/^bg1 {2}cargo build --release/);
		expect(lines.slice(2, 8)).toEqual(
			["out 25", "out 26", "out 27", "out 28", "out 29", "out 30"].map((l) => l.padEnd(100)),
		);
		hub.handleInput("\x1b[A");
		lines = screen();
		expect(lines[7]?.trim()).toBe("out 29");
		expect(lines.at(-1)).toMatch(/^1 lines above the end/);
		hub.handleInput("\x1b");
		expect(closed()).toBe(0);
		expect(screen()[1]).toMatch(/^Jobs/);
		hub.dispose();
	});

	it("says how to get jobs when there are none", () => {
		const hub = new JobHubComponent(new BackgroundJobs(), {
			rows: () => 12,
			requestRender: () => {},
			onClose: () => {},
		});
		expect(
			hub
				.render(100)
				.map((line) => stripVTControlCharacters(line))
				.join("\n"),
		).toContain("No background jobs in this session. A bash command still running after 2 minutes,");
		hub.dispose();
	});

	it("shows running jobs in the status line, and nothing without them", () => {
		const { jobs, build, hub } = setup();
		expect(stripVTControlCharacters(jobStatusText(jobs, "alt+j") ?? "")).toBe("● 1 job running (alt+j)");
		build.end("done", 0, "");
		expect(jobStatusText(jobs, "alt+j")).toBeUndefined();
		hub.dispose();
	});

	it("formats durations", () => {
		expect([formatJobDuration(4_900), formatJobDuration(125_000), formatJobDuration(3_725_000)]).toEqual([
			"4s",
			"2m 5s",
			"1h 2m",
		]);
	});
});
