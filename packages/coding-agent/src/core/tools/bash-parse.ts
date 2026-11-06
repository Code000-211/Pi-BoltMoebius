/**
 * A bash command read as the shell would at its top level, for the bash tool's guards (bash-file-writes.ts,
 * bash-self-kill.ts): its pipelines, their commands' words with quotes removed, and their redirections. Heredoc bodies
 * and comments are skipped; what runs inside quotes (`ssh host '…'`, `bash -c "…"`) stays one word.
 */

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

/** `path` as seen from `dir` (a folder a `cd` moved to, "" for none): absolute and home paths stay as they are. */
export function underDir(dir: string, path: string): string {
	return path.startsWith("/") || path.startsWith("~") || !dir ? path : `${dir}/${path}`;
}
