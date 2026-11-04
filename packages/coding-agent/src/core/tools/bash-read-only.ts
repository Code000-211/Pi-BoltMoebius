/**
 * Whether a bash command only reads, so it may start while the model's message is still streaming: an early run that is
 * then dropped (an abort, a retried stream, other final arguments) must leave nothing behind.
 *
 * Deliberately narrow: commands from a fixed list, with the options that write or run other programs refused, joined
 * by `|`, `&&`, `||` and `;`, optionally after `cd`. No redirections, command or process substitution, backgrounding,
 * variable assignments or line breaks. Anything else runs as usual, after the message.
 */

/** Options that make an otherwise reading command write a file or run another program. */
const REFUSED_OPTIONS: Record<string, (arg: string) => boolean> = {
	tail: (a) => a === "-f" || a === "-F" || a.startsWith("--follow") || /^-[^-]*[fF]/.test(a),
	sort: (a) => a === "-o" || a.startsWith("--output") || /^-[^-]*o/.test(a),
	tree: (a) => a === "-o",
	rg: (a) => a.startsWith("--pre"),
	find: (a) => /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/.test(a),
};

const READ_COMMANDS = new Set([
	"cat",
	"head",
	"tail",
	"ls",
	"wc",
	"pwd",
	"echo",
	"stat",
	"file",
	"du",
	"df",
	"tree",
	"realpath",
	"readlink",
	"basename",
	"dirname",
	"which",
	"nl",
	"cut",
	"sort",
	"comm",
	"diff",
	"cmp",
	"md5sum",
	"sha1sum",
	"sha256sum",
	"grep",
	"egrep",
	"fgrep",
	"rg",
	"find",
	"jq",
	"true",
	"false",
	"date",
	"uname",
	"whoami",
	"id",
]);

/** git subcommands that only read the repository. */
const GIT_READ_SUBCOMMANDS = new Set([
	"status",
	"log",
	"diff",
	"show",
	"blame",
	"ls-files",
	"ls-tree",
	"rev-parse",
	"describe",
	"shortlog",
	"grep",
	"cat-file",
]);

/** Splits a command into words and the operators between them; undefined for what this check does not take. */
function tokenize(command: string): string[] | undefined {
	if (/[\n\r`]|\$\(|[<>]|&(?!&)/.test(command.replace(/&&/g, ""))) return undefined;
	const tokens: string[] = [];
	let word = "";
	let inWord = false;
	for (let i = 0; i < command.length; i++) {
		const c = command[i];
		if (c === "'" || c === '"') {
			const close = command.indexOf(c, i + 1);
			if (close === -1) return undefined;
			word += command.slice(i + 1, close);
			inWord = true;
			i = close;
		} else if (c === " " || c === "\t") {
			if (inWord) tokens.push(word);
			word = "";
			inWord = false;
		} else if (c === "|" || c === ";" || c === "&") {
			if (inWord) tokens.push(word);
			word = "";
			inWord = false;
			const two = command.slice(i, i + 2);
			if (two === "||" || two === "&&") {
				tokens.push(two);
				i++;
			} else {
				tokens.push(c);
			}
		} else if (c === "\\") {
			word += command[i + 1] ?? "";
			inWord = true;
			i++;
		} else {
			word += c;
			inWord = true;
		}
	}
	if (inWord) tokens.push(word);
	return tokens;
}

function readsOnly(words: string[], first: boolean): boolean {
	const [name, ...args] = words;
	if (!name || name.includes("=")) return false;
	// `cd dir && ...`: the shell's own folder, gone with it.
	if (name === "cd") return first && args.length <= 1;
	if (name === "git") {
		let i = 0;
		while (args[i] === "--no-pager" || args[i] === "-C") i += args[i] === "-C" ? 2 : 1;
		const sub = args[i];
		if (!sub || !GIT_READ_SUBCOMMANDS.has(sub)) return false;
		// `--output=<file>` writes; `grep -O` opens a pager on the files.
		return !args.slice(i + 1).some((a) => a.startsWith("--output") || a === "-O" || a.startsWith("--open-files"));
	}
	if (!READ_COMMANDS.has(name)) return false;
	const refused = REFUSED_OPTIONS[name];
	return !refused || !args.some(refused);
}

export function isReadOnlyCommand(command: string): boolean {
	const tokens = tokenize(command.trim());
	if (!tokens || tokens.length === 0) return false;
	let words: string[] = [];
	let segment = 0;
	for (const token of [...tokens, ";"]) {
		if (token === "|" || token === ";" || token === "&&" || token === "||") {
			if (words.length === 0 || !readsOnly(words, segment === 0)) return false;
			words = [];
			segment++;
		} else {
			words.push(token);
		}
	}
	return true;
}
