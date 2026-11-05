import { describe, expect, it } from "vitest";
import { fullMatchKillPatterns, selfKillPattern } from "../src/core/tools/bash-self-kill.ts";

const pi =
	"/opt/pi-harness/pi --mode json --no-session -- Save your results to /app/posterior_alpha_mean.txt and /app/analysis.R";

describe("bash commands that would kill the agent", () => {
	it("finds the pattern of pkill -f, also with combined flags and a signal", () => {
		expect(fullMatchKillPatterns('pkill -f "analysis.R"').map((m) => m.pattern)).toEqual(["analysis.R"]);
		expect(fullMatchKillPatterns("pkill -9f analysis.R").map((m) => m.pattern)).toEqual(["analysis.R"]);
		expect(fullMatchKillPatterns("pkill -KILL --full -u root analysis.R").map((m) => m.pattern)).toEqual([
			"analysis.R",
		]);
		expect(fullMatchKillPatterns("kill $(pgrep -f analysis.R)").map((m) => m.pattern)).toEqual(["analysis.R"]);
	});

	it("leaves pkill by name, and pgrep that only lists, alone", () => {
		expect(fullMatchKillPatterns("pkill Rscript")).toEqual([]);
		expect(fullMatchKillPatterns("pgrep -af analysis.R")).toEqual([]);
	});

	it("refuses the command from the Terminal-Bench run, which matched the task's text in the agent's command line", () => {
		const command = `sed -n '1,45p' /tmp/run.log; pkill -f "analysis.R"; sleep 1; pkill -9 -f "exec/R"; echo KILLED`;
		expect(selfKillPattern(command, pi)).toBe("analysis.R");
	});

	it("lets through patterns the agent's command line does not have", () => {
		expect(selfKillPattern('pkill -f "exec/R"', pi)).toBeUndefined();
		expect(selfKillPattern("pkill -f 'Rscript /app/analysis'", pi)).toBeUndefined();
		expect(selfKillPattern("pkill -xf analysis.R", pi)).toBeUndefined();
	});

	it("does nothing where the command line is not known", () => {
		expect(selfKillPattern('pkill -f "analysis.R"', null)).toBeUndefined();
	});
});
