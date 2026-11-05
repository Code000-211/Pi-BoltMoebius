/**
 * A snapshot of the working folder for the system prompt, taken once when the session starts: its files, and for a small
 * project their contents. Nearly every coding run otherwise spends its first turn listing the folder (`find`, `ls`)
 * and its second reading the files it found; in 156 benchmark runs, 70 began with a listing and 31 continued with 4-5
 * reads. The snapshot answers both up front, bounded so that a large repository costs a short summary.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

export interface ProjectSnapshot {
	/** The section text. */
	text: string;
	/** Files whose whole content the text holds, by absolute path: they count as read. */
	inlined: Map<string, string>;
}

/** Listed one per line up to this many; above, folders with their file counts. */
const MAX_LISTED_FILES = 150;
/** Contents are included when the project has at most this many files... */
const MAX_INLINED_FILES = 40;
/** ...of at most this many characters together... */
const MAX_INLINED_TOTAL = 16_000;
/** ...and each file at most this many. */
const MAX_INLINED_FILE = 6_000;
const MAX_WALKED = 5_000;
const SKIPPED_DIRS = new Set([
	"node_modules",
	"target",
	"build",
	"dist",
	"__pycache__",
	".venv",
	"venv",
	".git",
	"out",
]);

function listFiles(cwd: string): string[] | undefined {
	if (existsSync(join(cwd, ".git"))) {
		const result = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
			cwd,
			encoding: "utf-8",
			timeout: 2_000,
			maxBuffer: 16 * 1024 * 1024,
		});
		if (result.status === 0) return result.stdout.split("\0").filter(Boolean).sort();
	}
	const files: string[] = [];
	const walk = (dir: string, depth: number): void => {
		if (files.length >= MAX_WALKED || depth > 6) return;
		let entries: import("node:fs").Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			if (entry.name.startsWith(".") || SKIPPED_DIRS.has(entry.name)) continue;
			const path = join(dir, entry.name);
			if (entry.isDirectory()) walk(path, depth + 1);
			else if (entry.isFile()) files.push(relative(cwd, path).split(sep).join("/"));
			if (files.length >= MAX_WALKED) return;
		}
	};
	walk(cwd, 0);
	return files.length >= MAX_WALKED ? undefined : files;
}

/** Folders with how many files each holds, two levels deep, for a project too large to list. */
function summarize(files: string[]): string {
	const counts = new Map<string, number>();
	const top: string[] = [];
	for (const file of files) {
		const parts = file.split("/");
		if (parts.length === 1) top.push(file);
		for (let depth = 1; depth <= Math.min(2, parts.length - 1); depth++) {
			const dir = `${parts.slice(0, depth).join("/")}/`;
			counts.set(dir, (counts.get(dir) ?? 0) + 1);
		}
	}
	const dirs = [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(0, 80);
	return [...top.slice(0, 40), ...dirs.map(([dir, n]) => `${dir} (${n} files)`)].join("\n");
}

/** The snapshot of `cwd`, or undefined for a folder that is no project (the home folder, /) or cannot be listed. */
export function takeProjectSnapshot(cwd: string, options?: { contents?: boolean }): ProjectSnapshot | undefined {
	const root = resolve(cwd);
	if (root === resolve(homedir()) || root === resolve("/")) return undefined;
	const files = listFiles(root);
	if (!files || files.length === 0) return undefined;
	const inlined = new Map<string, string>();
	let listing: string;
	if (files.length > MAX_LISTED_FILES) {
		listing = `${files.length} files; the folders, with how many files each holds:\n${summarize(files)}`;
	} else {
		listing = files.join("\n");
		if ((options?.contents ?? true) && files.length <= MAX_INLINED_FILES) {
			// Small files in full while they fit; a larger one is named as left out, to be read.
			const contents: Array<[string, string]> = [];
			const left: string[] = [];
			let total = 0;
			for (const file of files) {
				const path = join(root, file);
				let text: string;
				try {
					if (statSync(path).size > MAX_INLINED_FILE) {
						left.push(file);
						continue;
					}
					text = readFileSync(path, "utf-8");
				} catch {
					continue;
				}
				if (text.includes("\0")) continue;
				if (total + text.length > MAX_INLINED_TOTAL) {
					left.push(file);
					continue;
				}
				total += text.length;
				contents.push([file, text]);
			}
			if (contents.length > 0) {
				for (const [file, text] of contents) inlined.set(join(root, file), text);
				const body = contents
					.map(([file, text]) => `--- ${file}\n${text.endsWith("\n") ? text : `${text}\n`}`)
					.join("");
				const note = left.length > 0 ? `\nNot included (read them when needed): ${left.join(", ")}\n` : "";
				return {
					text: `The files of the working folder and their contents when the session started (they may have changed since; read a file again after a command changed it):\n${listing}\n${note}\n${body}`,
					inlined,
				};
			}
		}
	}
	return withListing();

	function withListing(): ProjectSnapshot {
		return { text: `The files of the working folder when the session started:\n${listing}`, inlined: new Map() };
	}
}
