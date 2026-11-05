/**
 * Whether a bash command would kill Pi itself: `pkill -f` (and `pgrep -f` feeding `kill`) match a pattern against the
 * whole command line of every process, and Pi's own holds its prompt when it was given on the command line, as in
 * `pi -p "…"` and in benchmark runs. A task that mentions a file, say `analysis.R`, and a model that stops its script
 * with `pkill -f analysis.R` stopped Pi with it (Terminal-Bench 2.1, mcmc-sampling-stan: exit 143 in the middle of the
 * run). The bash tool refuses such a command and says how to stop the process instead.
 */

import { readFileSync } from "node:fs";
import { commandName, parse } from "./bash-file-writes.ts";

/** pkill/pgrep options that take a value, which is not the pattern. */
const VALUE_OPTIONS = new Set([
	"-u",
	"-U",
	"-g",
	"-G",
	"-P",
	"-s",
	"-t",
	"-F",
	"--signal",
	"--pidfile",
	"--ns",
	"--nslist",
]);

interface FullMatch {
	pattern: string;
	/** `-x`: the pattern must match the whole command line. */
	exact: boolean;
}

/** The patterns that `pkill -f`, or `pgrep -f` in a command that also kills, match against whole command lines. */
export function fullMatchKillPatterns(command: string): FullMatch[] {
	const found: FullMatch[] = [];
	const kills = /\bkill\b|\bpkill\b|\bxargs\b/.test(command);
	for (const pipeline of parse(command)) {
		for (const segment of pipeline) {
			// Also inside `$( … )`, which the parser leaves in its segment (`kill $(pgrep -f x)`).
			const words = segment.words;
			const at = words.findIndex((w, i) => {
				const name = i === 0 ? commandName(words).name : w.replace(/^.*\//, "");
				return name === "pkill" || (name === "pgrep" && kills);
			});
			if (at < 0) continue;
			const args = at === 0 ? commandName(words).args : words.slice(at + 1);
			let full = false;
			let exact = false;
			let pattern: string | undefined;
			for (let i = 0; i < args.length; i++) {
				const arg = args[i]!;
				if (arg === "--full") full = true;
				else if (arg === "--exact") exact = true;
				else if (VALUE_OPTIONS.has(arg)) i++;
				else if (/^-[A-Za-z0-9]+$/.test(arg) && !/^-([A-Z]+|\d+)$/.test(arg)) {
					// Combined short flags (-fx, -9f); a number or an all-capitals word is a signal (-9, -KILL).
					if (arg.includes("f")) full = true;
					if (arg.includes("x")) exact = true;
				} else if (arg.startsWith("-") && pattern === undefined && !/^-\d+$/.test(arg) && !/^-[A-Z]+$/.test(arg)) {
					// Another long option: no pattern.
				} else if (!arg.startsWith("-") && pattern === undefined) pattern = arg;
			}
			if (full && pattern) found.push({ pattern, exact });
		}
	}
	return found;
}

let ownCommandLine: string | null | undefined;

/** This process's command line, as pkill -f sees it; null where /proc is not there. */
function commandLine(): string | null {
	if (ownCommandLine === undefined) {
		try {
			ownCommandLine = readFileSync("/proc/self/cmdline", "utf-8").split("\0").filter(Boolean).join(" ");
		} catch {
			ownCommandLine = null;
		}
	}
	return ownCommandLine;
}

/** The pattern in `command` that would kill the process with this command line (Pi's own by default), if one would. */
export function selfKillPattern(command: string, line: string | null = commandLine()): string | undefined {
	if (!line) return undefined;
	for (const { pattern, exact } of fullMatchKillPatterns(command)) {
		let matches: boolean;
		try {
			matches = new RegExp(exact ? `^(?:${pattern})$` : pattern).test(line);
		} catch {
			matches = exact ? line === pattern : line.includes(pattern);
		}
		if (matches) return pattern;
	}
	return undefined;
}

/** Why such a command was not run, and what to do instead. */
export function selfKillRefusal(pattern: string): string {
	return `Not run: \`-f ${pattern}\` matches the command line of the agent itself (it holds the task's text), so it would end this session. Stop the process by its PID instead (from \`pgrep -af '${pattern}'\`, choosing the right one, or \`$!\` after starting it), or use a pattern only that process's command line has.`;
}
