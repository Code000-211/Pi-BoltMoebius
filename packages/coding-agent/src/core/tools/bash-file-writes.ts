/**
 * Whether a bash command changes a file the way the edit and write tools do: `sed -i` or `perl -i`, or text the command
 * itself spells out (`echo`, `printf`, a heredoc) redirected or `tee`d into a file. Such a change skips what those tools
 * check (the file was read and did not change since, the compiler's new errors), so the bash tool refuses it while they
 * are there, as oh-my-pi's bash interceptor does.
 *
 * Only the command's own top level counts: text in quotes (such as `ssh host 'sed -i …'`) and heredoc bodies do not.
 * A file under the temp folder or in /dev (also relative to a leading `cd` there), an append (`>>`, `tee -a`: it keeps
 * what is there, as a log or notes do), and a program's output redirected to a file (`make > build.log`) are not
 * changes of this kind.
 */

import { tmpdir } from "node:os";
import { commandName, parse, underDir } from "./bash-parse.ts";

export interface FileWrite {
	/** How the command writes: `sed -i`, `perl -i`, `a redirection`, `tee`. */
	how: string;
	/** The file, as written in the command. */
	target: string;
	/** The folder a leading `cd` moved to, which a relative target is in; "" for the command's own. */
	dir: string;
}

function isScratch(target: string): boolean {
	const tmp = tmpdir();
	return (
		target.startsWith("/dev/") ||
		target.startsWith("/tmp/") ||
		target.startsWith(`${tmp}/`) ||
		/^\$\{?TMPDIR\}?\//.test(target) ||
		target.startsWith("/proc/")
	);
}

/** Files the command changes as edit or write would (see the file comment); empty when none. */
export function fileWritesInCommand(command: string): FileWrite[] {
	const writes: FileWrite[] = [];
	// The folder a leading `cd` moved to, for relative targets (`cd /tmp && cat > a.py`).
	let dir = "";
	const scratch = (target: string) => isScratch(underDir(dir, target));
	for (const pipeline of parse(command)) {
		const cd = pipeline.length === 1 ? commandName(pipeline[0]!.words) : undefined;
		if (cd?.name === "cd" && cd.args[0]) {
			dir = underDir(dir, cd.args[0]);
			continue;
		}
		for (const segment of pipeline) {
			const { name, args } = commandName(segment.words);
			if (name === "sed" || name === "perl") {
				const inPlace = args.some(
					(a) => a === "--in-place" || a.startsWith("--in-place=") || /^-[a-zA-Z]*i/.test(a),
				);
				// The script comes with -e or -f, or else as the first word that is not an option; the rest are files.
				const positional: string[] = [];
				let script = false;
				for (let k = 0; k < args.length; k++) {
					const a = args[k]!;
					if (a === "-e" || a === "-f" || a === "--expression" || a === "--file" || /^-[a-zA-Z]*e$/.test(a)) {
						script = true;
						k++;
					} else if (!a.startsWith("-")) positional.push(a);
				}
				const files = script ? positional : positional.slice(1);
				// One file is what edit is for. The same replacement over many files (a glob, a list) is sed's job.
				const target = files[0];
				if (inPlace && files.length === 1 && target && !/[*?[]/.test(target) && !scratch(target)) {
					writes.push({ how: `${name} -i`, target, dir });
				}
			}
		}
		// Text the command spells out: the pipeline starts with echo or printf, or with cat or tee reading a heredoc
		// (or cat reading stdin). A program's output (`make > build.log`, a script fed by a heredoc) is not.
		const head = pipeline[0]!;
		const first = commandName(head.words);
		const authored =
			first.name === "echo" ||
			first.name === "printf" ||
			(first.name === "cat" && (head.heredoc || first.args.length === 0)) ||
			(first.name === "tee" && head.heredoc);
		if (!authored) continue;
		for (const segment of pipeline) {
			const { name, args } = commandName(segment.words);
			for (const target of segment.redirects) {
				if (!scratch(target)) writes.push({ how: "a redirection", target, dir });
			}
			if (name === "tee") {
				for (const target of args.filter((a) => !a.startsWith("-"))) {
					if (!scratch(target) && !args.includes("-a") && !args.includes("--append"))
						writes.push({ how: "tee", target, dir });
				}
			}
		}
	}
	return writes;
}

/**
 * Files a command prints whole with `cat` (`cat a.py b.py`, also after `cd dir &&`): the model has seen them as a read
 * would show them. Paths as written, with the folder a leading `cd` moved to; empty for anything else (pipes,
 * redirections, globs, variables, options other than -n).
 */
export function filesShownByCat(command: string): { dir: string; files: string[] } {
	const none = { dir: "", files: [] };
	if (/[|<>$`*?[\n]|\(|\)/.test(command)) return none;
	let dir = "";
	const files: string[] = [];
	for (const pipeline of parse(command)) {
		const segment = pipeline[0]!;
		if (pipeline.length !== 1 || segment.redirects.length > 0 || segment.heredoc) return none;
		const { name, args } = commandName(segment.words);
		if (name === "cd" && args.length === 1 && files.length === 0) {
			dir = underDir(dir, args[0]!);
			continue;
		}
		if (name !== "cat") return none;
		for (const arg of args) {
			if (arg === "-n") continue;
			if (arg.startsWith("-")) return none;
			files.push(arg);
		}
	}
	return { dir, files };
}
