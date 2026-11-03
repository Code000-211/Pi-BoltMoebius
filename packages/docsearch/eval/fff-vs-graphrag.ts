// The grep tool's search (coding-agent's nativeGrep, with native/fff/prebuilds built by native/fff/build.mjs) against
// docsearch's project_search, in one Bun process, on the same snapshots and test sets. A hit counts when it lies in a
// target's file and inside (grep: the line) or overlapping (sections) its lines.
//
//   DOCSEARCH_EVAL_DATA=<folder with corpus/ and code/> bun packages/docsearch/eval/fff-vs-graphrag.ts
//   DOCSEARCH_NODE=<addon> picks the addon (default: the installed one)
import { readFileSync } from "node:fs";
import path from "node:path";
import { nativeGrep } from "../../coding-agent/src/core/tools/native-search.ts";

const HERE = import.meta.dir;
const S = process.env.DOCSEARCH_EVAL_DATA ?? "";
if (!S) throw new Error("set DOCSEARCH_EVAL_DATA to the folder with corpus/ and code/");
const { DocIndex } = require(process.env.DOCSEARCH_NODE ?? `${process.env.HOME}/.pi/agent/extensions/docsearch/docsearch.linux-x64.node`);

const DOC_EXT = ["md", "mdx", "markdown", "txt", "rst", "adoc", "org"];
const CODE_EXT = ["c", "cc", "cpp", "cxx", "h", "hh", "hpp", "hip", "cu", "cuh", "rs", "py", "sh", "ts", "js", "go"];
const STOP = new Set(
	("a an and are as at be by can do does for from has have how i if in into is it its of on or so that the then there this to was what when where which who why with you your " +
		"aber als am an auch auf aus bei bin bis das dass dem den der des die du ein eine einem einen einer es für hat ich im in ist mit nach nicht noch oder sich sie sind so und von vor wie wir wird wo zu zum zur " +
		"function which where does what welche welcher welches funktion wird werden").split(" "),
);

type Target = { file: string; a: number; b: number };
type Query = { kind: string; text: string; targets: Target[] };

function load(file: string): Query[] {
	return readFileSync(file, "utf8")
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => {
			const [kind, text, targets] = l.split("\t");
			return {
				kind,
				text,
				targets: targets.split("|").map((t) => {
					const [f, r] = t.trim().split(/:(?=[\d-]+$)/);
					const [a, b] = r.split("-").map(Number);
					return { file: f, a, b: b ?? a };
				}),
			};
		});
}

const median = (v: number[]) => [...v].sort((x, y) => x - y)[Math.floor((v.length - 1) / 2)];
const pct = (v: number[], p: number) => [...v].sort((x, y) => x - y)[Math.floor((v.length - 1) * p)];

/** The words of a query a person would grep for: identifiers, flags, words of 4+ letters that say something. */
function keywords(q: string): string[] {
	const words = q.match(/[\p{L}\p{N}_][\p{L}\p{N}_\-.:/]*[\p{L}\p{N}_]|[\p{L}\p{N}_]/gu) ?? [];
	const flags = q.match(/--[\w-]+/g) ?? [];
	return [...new Set([...flags, ...words.filter((w) => w.length >= 4 && !STOP.has(w.toLowerCase()))])];
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const isPlainWord = (w: string) => /^[\p{Ll}]+$/u.test(w);

async function grep(root: string, pattern: string, literal: boolean, ignoreCase: boolean, limit: number) {
	return nativeGrep({ root, isDirectory: true, pattern, literal, ignoreCase, limit, keepChars: 500 });
}

function rankGrep(root: string, q: Query, matches: { filePath: string; lineNumber: number }[]) {
	let strict = 0;
	let file = 0;
	for (let i = 0; i < matches.length; i++) {
		const rel = path.relative(root, matches[i].filePath);
		for (const t of q.targets) {
			if (rel !== t.file) continue;
			if (!file) file = i + 1;
			if (!strict && matches[i].lineNumber >= t.a && matches[i].lineNumber <= t.b) strict = i + 1;
		}
	}
	return { strict, file };
}

function rankSections(root: string, q: Query, hits: { path: string; lineStart: number; lineEnd: number }[]) {
	let strict = 0;
	let file = 0;
	for (let i = 0; i < hits.length; i++) {
		const rel = path.relative(root, hits[i].path);
		for (const t of q.targets) {
			if (rel !== t.file) continue;
			if (!file) file = i + 1;
			if (!strict && hits[i].lineStart <= t.b && hits[i].lineEnd >= t.a) strict = i + 1;
		}
	}
	return { strict, file };
}

type Row = { name: string; strict: number[]; file: number[]; ms: number[]; chars: number[]; extraMs?: number[] };

function report(title: string, n: number, rows: Row[]) {
	console.log(`\n## ${title} (${n} queries)`);
	console.log(
		"variant".padEnd(34) +
			"Hit@1  Hit@3  Hit@10  in output | file@1 file@10 | p50 ms  p95 ms | output chars p50",
	);
	for (const r of rows) {
		const at = (v: number[], k: number) => `${Math.round((100 * v.filter((x) => x > 0 && x <= k).length) / v.length)}%`.padStart(5);
		const any = `${Math.round((100 * r.strict.filter((x) => x > 0).length) / r.strict.length)}%`.padStart(9);
		console.log(
			r.name.padEnd(34) +
				`${at(r.strict, 1)}  ${at(r.strict, 3)}  ${at(r.strict, 10)}  ${any} | ${at(r.file, 1)}  ${at(r.file, 10)} | ${median(r.ms).toFixed(2).padStart(6)}  ${pct(r.ms, 0.95).toFixed(2).padStart(6)} | ${String(median(r.chars)).padStart(8)}` +
				(r.extraMs ? `   (+ choosing the word: p50 ${median(r.extraMs).toFixed(1)} ms)` : ""),
		);
	}
}

async function bench(title: string, root: string, file: string, exts: string[], names: boolean) {
	const queries = load(file);

	// Cold starts: the index build, and grep's first call (empty tree and content cache).
	const t0 = performance.now();
	const ix = new DocIndex({ roots: [root], extensions: exts });
	ix.search("x", { waitMs: 60000 });
	const buildMs = performance.now() - t0;
	const t1 = performance.now();
	await grep(root, "zzqx_never_there", true, false, 100);
	const grepColdMs = performance.now() - t1;
	await grep(root, "zzqx_never_there", true, false, 100); // warm the content cache
	console.log(`\n# ${title}: project_search index ${buildMs.toFixed(0)} ms (${ix.stats().sections} sections) · grep first call ${grepColdMs.toFixed(0)} ms`);

	const rows: Row[] = [];
	const rag: Row = { name: "project_search (BM25+defs+graph)", strict: [], file: [], ms: [], chars: [] };
	for (const q of queries) {
		const r = ix.search(q.text, { k: 10, maxChars: 1500 });
		const times: number[] = [];
		for (let i = 0; i < 5; i++) {
			const t = performance.now();
			ix.search(q.text, { k: 6, maxChars: 1500 });
			times.push(performance.now() - t);
		}
		const { strict, file } = rankSections(root, q, r.hits);
		rag.strict.push(strict);
		rag.file.push(file);
		rag.ms.push(median(times));
		rag.chars.push(r.hits.slice(0, 6).reduce((n: number, h: any) => n + h.text.length + h.path.length + 20, 0));
	}
	rows.push(rag);

	const runGrep = async (name: string, choose: (q: Query) => Promise<{ pattern: string; literal: boolean; ignoreCase: boolean; extra: number } | undefined>) => {
		const row: Row = { name, strict: [], file: [], ms: [], chars: [], extraMs: [] };
		for (const q of queries) {
			const c = await choose(q);
			if (!c) {
				row.strict.push(0);
				row.file.push(0);
				row.ms.push(0);
				row.chars.push(0);
				row.extraMs!.push(0);
				continue;
			}
			let res = await grep(root, c.pattern, c.literal, c.ignoreCase, 100);
			const times: number[] = [];
			for (let i = 0; i < 5; i++) {
				const t = performance.now();
				res = await grep(root, c.pattern, c.literal, c.ignoreCase, 100);
				times.push(performance.now() - t);
			}
			const { strict, file } = rankGrep(root, q, res.matches);
			row.strict.push(strict);
			row.file.push(file);
			row.ms.push(median(times));
			row.chars.push(res.matches.reduce((n, m) => n + path.relative(root, m.filePath).length + 8 + Math.min(m.lineText.length, 500), 0));
			row.extraMs!.push(c.extra);
		}
		if (!row.extraMs!.some((x) => x > 0)) delete row.extraMs;
		rows.push(row);
	};

	if (names) {
		await runGrep("grep NAME (literal, case-sensitive)", async (q) => ({ pattern: q.text, literal: true, ignoreCase: false, extra: 0 }));
	}
	// The word with the fewest matches: generous to grep, an agent does not know the counts before it tries.
	await runGrep("grep rarest word of the query", async (q) => {
		const t = performance.now();
		let best: { pattern: string; literal: boolean; ignoreCase: boolean; n: number } | undefined;
		for (const w of keywords(q.text)) {
			const ignoreCase = isPlainWord(w);
			const r = await grep(root, w, true, ignoreCase, 100000);
			if (r.matches.length > 0 && (!best || r.matches.length < best.n)) best = { pattern: w, literal: true, ignoreCase, n: r.matches.length };
		}
		return best && { ...best, extra: performance.now() - t };
	});
	await runGrep("grep all words (w1|w2|...)", async (q) => {
		const ws = keywords(q.text);
		return ws.length ? { pattern: ws.map(esc).join("|"), literal: false, ignoreCase: true, extra: 0 } : undefined;
	});

	report(title, queries.length, rows);
	const kinds = [...new Set(queries.map((q) => q.kind))];
	if (kinds.length > 1) {
		console.log("Hit@3 per query type " + kinds.join(" / "));
		for (const r of rows) {
			const per = kinds.map((k) => {
				const sel = queries.map((q, i) => [q, r.strict[i]] as const).filter(([q]) => q.kind === k);
				return `${Math.round((100 * sel.filter(([, x]) => x > 0 && x <= 3).length) / sel.length)}%`;
			});
			console.log("  " + r.name.padEnd(32) + per.join(" / "));
		}
	}
}

console.log(`load ${readFileSync("/proc/loadavg", "utf8").split(" ")[0]}`);
await bench("Docs (radiance docs, frozen)", `${S}/corpus`, `${HERE}/docs-eval.tsv`, DOC_EXT, false);
await bench("Code: functions by name", `${S}/code`, `${HERE}/code-names.tsv`, [...DOC_EXT, ...CODE_EXT], true);
await bench("Code: functions by description", `${S}/code`, `${HERE}/code-eval.tsv`, [...DOC_EXT, ...CODE_EXT], false);
console.log(`\nload ${readFileSync("/proc/loadavg", "utf8").split(" ")[0]}`);
