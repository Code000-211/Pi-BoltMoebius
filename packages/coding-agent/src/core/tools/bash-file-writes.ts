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

export interface FileWrite {
	/** How the command writes: `sed -i`, `perl -i`, `a redirection`, `tee`. */
	how: string;
	/** The file, as written in the command. */
	target: string;
	/** The folder a leading `cd` moved to, which a relative target is in; "" for the command's own. */
	dir: string;
}

export interface Segment {
	words: string[];
	/** Targets of `>`, `>|`, `&>` (not of appends, `>>`, or fd duplications such as `2>&1`). */
	redirects: string[];
	heredoc: boolean;
}

/** Splits a command into pipelines of segments, skipping heredoc bodies; quotes are removed from words. */
export function parse(command: string): Segment[][] {
	const pipelines: Segment[][] = [];
	let pipeline: Segment[] = [];
	let segment: Segment = { words: [], redirects: [], heredoc: false };
	let word = "";
	let inWord = false;
	let pendingRedirect = false;
	// The redirection being read appends (`>>`, `&>>`): it adds to a file, keeping what is there, as a log or notes do.
	let appending = false;
	const heredocs: string[] = [];

	const endWord = () => {
		if (!inWord) return;
		if (pendingRedirect) {
			if (!appending) segment.redirects.push(word);
			pendingRedirect = false;
		} else segment.words.push(word);
		word = "";
		inWord = false;
	};
	const endSegment = () => {
		endWord();
		pipeline.push(segment);
		segment = { words: [], redirects: [], heredoc: false };
	};
	const endPipeline = () => {
		endSegment();
		pipelines.push(pipeline);
		pipeline = [];
	};

	for (let i = 0; i < command.length; i++) {
		const c = command[i]!;
		if (c === "'") {
			const end = command.indexOf("'", i + 1);
			word += command.slice(i + 1, end < 0 ? command.length : end);
			inWord = true;
			i = end < 0 ? command.length : end;
		} else if (c === '"') {
			let j = i + 1;
			for (; j < command.length && command[j] !== '"'; j++) if (command[j] === "\\") j++;
			word += command.slice(i + 1, j);
			inWord = true;
			i = j;
		} else if (c === "\\") {
			word += command[i + 1] ?? "";
			inWord = true;
			i++;
		} else if (c === "\n") {
			endPipeline();
			// Heredoc bodies start on the next line and end at their delimiter line.
			while (heredocs.length > 0) {
				const delimiter = heredocs.shift()!;
				let lineStart = i + 1;
				for (;;) {
					const lineEnd = command.indexOf("\n", lineStart);
					const line = command.slice(lineStart, lineEnd < 0 ? command.length : lineEnd);
					if (line.trim() === delimiter || lineEnd < 0) {
						i = lineEnd < 0 ? command.length : lineEnd;
						break;
					}
					lineStart = lineEnd + 1;
				}
			}
		} else if (c === "#" && !inWord) {
			const end = command.indexOf("\n", i);
			i = (end < 0 ? command.length : end) - 1;
		} else if (c === ";" || (c === "&" && command[i + 1] === "&") || (c === "|" && command[i + 1] === "|")) {
			endPipeline();
			if (c !== ";") i++;
		} else if (c === "|") {
			endSegment();
		} else if (c === "&" && command[i + 1] === ">") {
			endWord();
			appending = command[i + 2] === ">";
			i += appending ? 2 : 1;
			pendingRedirect = true;
		} else if (c === "<" && command[i + 1] === "<" && command[i + 2] !== "<") {
			endWord();
			let j = i + 2;
			if (command[j] === "-") j++;
			while (command[j] === " ") j++;
			const match = /^['"]?([\w.-]+)['"]?/.exec(command.slice(j));
			if (match) {
				heredocs.push(match[1]!);
				segment.heredoc = true;
				i = j + match[0].length - 1;
			} else i++;
		} else if (c === ">") {
			// `2>&1`, `>&2`: a descriptor, not a file. A leading fd number belongs to the operator.
			if (inWord && /^\d+$/.test(word)) {
				word = "";
				inWord = false;
			} else endWord();
			let j = i + 1;
			appending = command[j] === ">";
			if (command[j] === ">" || command[j] === "|") j++;
			if (command[j] === "&") {
				i = j;
				while (/[\d-]/.test(command[i + 1] ?? "")) i++;
				continue;
			}
			i = j - 1;
			pendingRedirect = true;
		} else if (c === " " || c === "\t" || c === "(" || c === ")" || c === "{" || c === "}") {
			endWord();
		} else {
			word += c;
			inWord = true;
		}
	}
	endPipeline();
	return pipelines.filter((p) => p.some((s) => s.words.length > 0 || s.redirects.length > 0));
}

/** The command's name: past variable assignments and wrappers that run the next word. */
export function commandName(words: string[]): { name: string; args: string[] } {
	let i = 0;
	while (
		i < words.length &&
		(/^\w+=/.test(words[i]!) || ["sudo", "command", "env", "nice", "time"].includes(words[i]!))
	)
		i++;
	return { name: (words[i] ?? "").replace(/^.*\//, ""), args: words.slice(i + 1) };
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

/** `path` as seen from `dir` (a folder a `cd` moved to, "" for none): absolute and home paths stay as they are. */
function underDir(dir: string, path: string): string {
	return path.startsWith("/") || path.startsWith("~") || !dir ? path : `${dir}/${path}`;
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
