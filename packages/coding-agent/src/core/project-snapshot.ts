/**
 * A listing of the working folder for the system prompt, taken once when the session starts. Nearly every coding run
 * otherwise spends its first turn listing the folder (`find`, `ls`): in 156 benchmark runs, 70 began with a listing.
 * Bounded, so that a large repository costs a short summary. Small files' contents were included too, once: that
 * made glm-5.3-flash think longer over them than the reads would have taken.
 */

import { spawnSync } from "node:child_process";
import { type Dirent, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

/** Listed one per line up to this many; above, folders with their file counts. */
const MAX_LISTED_FILES = 150;
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
		let entries: Dirent[];
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

/** The listing of `cwd`, or undefined for a folder that is no project (the home folder, /) or cannot be listed. */
export function takeProjectSnapshot(cwd: string): string | undefined {
	const root = resolve(cwd);
	if (root === resolve(homedir()) || root === resolve("/")) return undefined;
	const files = listFiles(root);
	if (!files || files.length === 0) return undefined;
	const listing =
		files.length > MAX_LISTED_FILES
			? `${files.length} files; the folders, with how many files each holds:\n${summarize(files)}`
			: files.join("\n");
	return `The files of the working folder when the session started:\n${listing}`;
}
