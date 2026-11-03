/**
 * docsearch: fast search over the project's code and documentation and your doc folders.
 *
 * The index lives in a Rust addon (BM25 + a section–entity graph walked with personalized
 * PageRank, as E²GraphRAG and HippoRAG retrieve, but with no model at query time). Docs are split
 * at their headings, code at its definitions (one section per function, class or struct, named by
 * it), so a search for a name lands on its definition. A search takes about a millisecond; the
 * index builds on a thread at session start and follows file changes.
 *
 *   project_search    the model searches code and docs; sections come back with path:lines
 *   auto-recall       the best sections for a prompt are added before the run (when they match well)
 *   /docs <query>     search yourself;  /docs  status;  /docs rebuild;  /docs auto on|off
 *
 * Settings: ~/.pi/agent/docsearch.json
 *   { "project": true, "roots": ["~/notes"], "autoRecall": true }
 *
 * Install: packages/docsearch/install.sh, then `pi-bolt compile` (see packages/docsearch/README.md).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Type } from "typebox";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

// A literal path, so that `pi-bolt compile` embeds the addon in the executable.
const { DocIndex } = require("./docsearch.linux-x64.node");

interface Hit {
	path: string;
	lineStart: number;
	lineEnd: number;
	heading: string;
	score: number;
	coverage: number;
	named: number;
	text: string;
	truncated: boolean;
}

interface SearchResult {
	ready: boolean;
	hits: Hit[];
	entities: string[];
	queryTerms: number;
	micros: number;
}

interface Config {
	/** Index the documentation of the project Pi runs in (its git root, else the working directory). */
	project: boolean;
	/** More folders, indexed in every project. `~` is expanded. */
	roots: string[];
	/** Index source code as well as docs. */
	code: boolean;
	/** File extensions to index, replacing the defaults (DOC_EXTENSIONS, plus CODE_EXTENSIONS with `code`). */
	extensions?: string[];
	/**
	 * Characters of text shown for the best results, in rank order; the results after them come as
	 * `path:lines · heading` only. Measured on the eval sets: 1500/1000/600 + 3 pointers keeps every
	 * answer listed and cuts the output by ~60% against six full sections.
	 */
	resultChars: number[];
	/** Results in all, shown in full or as pointers (the tool's `k` overrides it). */
	results: number;
	/** Add the best-matching sections to a typed prompt before the model runs. */
	autoRecall: boolean;
	autoRecallHits: number;
	autoRecallChars: number;
	/** Share of the prompt's terms, weighted by rarity, a section must contain to be added (0..1)... */
	autoRecallMinCoverage: number;
	/** ...or this share, when the section mentions a name (identifier, file, product) the prompt names. */
	autoRecallNamedCoverage: number;
}

const DOC_EXTENSIONS = ["md", "mdx", "markdown", "txt", "rst", "adoc", "org"];
const CODE_EXTENSIONS = ["c", "cc", "cpp", "cxx", "h", "hh", "hpp", "hip", "cu", "cuh", "rs", "py", "sh", "ts", "js", "go"];
const isCode = (p: string) => CODE_EXTENSIONS.includes(p.slice(p.lastIndexOf(".") + 1).toLowerCase());

const DEFAULTS: Config = {
	project: true,
	roots: [],
	code: true,
	resultChars: [1500, 1000, 600],
	results: 6,
	autoRecall: true,
	autoRecallHits: 3,
	autoRecallChars: 2400,
	autoRecallMinCoverage: 0.85,
	autoRecallNamedCoverage: 0.3,
};

const CONFIG_PATH = join(getAgentDir(), "docsearch.json");

function loadConfig(): Config {
	try {
		if (existsSync(CONFIG_PATH)) return { ...DEFAULTS, ...JSON.parse(readFileSync(CONFIG_PATH, "utf8")) };
	} catch {
		// A broken file falls back to the defaults; /docs shows the path to fix.
	}
	return { ...DEFAULTS };
}

function saveConfig(patch: Partial<Config>): void {
	let current: Record<string, unknown> = {};
	try {
		if (existsSync(CONFIG_PATH)) current = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
	} catch {}
	writeFileSync(CONFIG_PATH, `${JSON.stringify({ ...current, ...patch }, null, "\t")}\n`);
}

const expand = (p: string) => (p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p);

/** The git root above `cwd`, or `cwd`. Never the home directory or `/`: too much to index. */
function projectRoot(cwd: string): string | undefined {
	let dir = resolve(cwd);
	for (;;) {
		if (existsSync(join(dir, ".git"))) break;
		const up = dirname(dir);
		if (up === dir) {
			dir = resolve(cwd);
			break;
		}
		dir = up;
	}
	return dir === homedir() || dir === "/" ? undefined : dir;
}

export default function (pi: ExtensionAPI) {
	// PI_DOCSEARCH=off leaves the extension out entirely (no tool, no recall), to measure without it.
	if (process.env.PI_DOCSEARCH === "off") return;
	let index: any;
	let base = "";
	let config = DEFAULTS;

	const show = (p: string) => {
		if (base && (p === base || p.startsWith(`${base}/`))) return relative(base, p) || ".";
		return p.startsWith(`${homedir()}/`) ? `~/${relative(homedir(), p)}` : p;
	};

	function start(ctx: ExtensionContext) {
		config = loadConfig();
		const root = config.project ? projectRoot(ctx.cwd) : undefined;
		base = root ?? "";
		const roots = [...new Set([...(root ? [root] : []), ...config.roots.map((r) => resolve(expand(r)))])].filter((r) =>
			existsSync(r),
		);
		const extensions = config.extensions ?? [...DOC_EXTENSIONS, ...(config.code ? CODE_EXTENSIONS : [])];
		index = roots.length ? new DocIndex({ roots, extensions }) : undefined;
		if (!index) {
			ctx.ui.setStatus("docsearch", undefined);
			return;
		}
		// The build runs on a thread; show the count once it is there.
		let tries = 0;
		const poll = setInterval(() => {
			const s = index?.stats();
			if (!s || s.ready || ++tries > 100) {
				clearInterval(poll);
				ctx.ui.setStatus("docsearch", s?.ready ? `index ${s.files}` : undefined);
			}
		}, 100);
	}

	function search(query: string, k: number, maxChars: number, path?: string, waitMs = 5000): SearchResult | undefined {
		if (!index) return undefined;
		const pathPrefix = path ? (isAbsolute(expand(path)) ? expand(path) : resolve(base || process.cwd(), path)) : undefined;
		return index.search(query, { k, maxChars, pathPrefix, waitMs });
	}

	/** Cuts `text` to at most `max` characters, at a line break when one is in the second half. */
	function cut(text: string, max: number): [string, boolean] {
		if (text.length <= max) return [text, false];
		let end = text.lastIndexOf("\n", max);
		if (end < max / 2) end = max;
		return [text.slice(0, end), true];
	}

	/** Each hit with the text `chars[i]` allows (all of it when `chars` is not given); past `chars`, a pointer. */
	function format(hits: Hit[], chars?: number[]): string {
		const pointers: string[] = [];
		const full = hits
			.map((h, i) => {
				const where = `${show(h.path)}:${h.lineStart}-${h.lineEnd}${h.heading ? ` · ${h.heading}` : ""}`;
				const max = chars ? chars[i] : Number.POSITIVE_INFINITY;
				if (max === undefined) {
					pointers.push(`   ${where}`);
					return undefined;
				}
				const [text, shortened] = cut(h.text, max);
				const more = h.truncated || shortened ? `\n[cut — read ${show(h.path)} lines ${h.lineStart}-${h.lineEnd} for the rest]` : "";
				return `── ${where}\n${text}${more}`;
			})
			.filter((x) => x !== undefined)
			.join("\n\n");
		return pointers.length ? `${full}\n\nMore matches (read the lines to see them):\n${pointers.join("\n")}` : full;
	}

	pi.on("session_start", async (_event, ctx) => start(ctx));
	pi.on("session_shutdown", async () => {
		index = undefined;
	});

	pi.registerTool({
		name: "project_search",
		label: "Project search",
		description:
			"Search this project's code and documentation and the configured doc folders. Returns the best-matching " +
			"sections with path and line range: a doc section under its headings, or a whole function, class or struct " +
			"under its name. A query naming a function or type returns its definition first. Ranks by terms and by the " +
			"names the query mentions (identifiers, file names, flags, products). ~1 ms.",
		promptSnippet: "Find definitions (functions, classes) and doc sections by name or keywords; returns path:lines",
		promptGuidelines: [
			"To find where a function, class or struct is defined, or what the docs, specs, READMEs or notes say about something, use project_search before grep, rg, find or read.",
			"project_search ranks by words, not meaning: put the names and identifiers you know in the query (function names, flags, file names, error text); a description in other words than the code uses finds little, so then try likely identifiers or use rg.",
			"Use rg instead for exact-text matches across all files, such as every call site of a function.",
			"project_search shows the best three results with their text and lists the rest as path:lines: read a listed result's lines only when its heading looks like the answer. For several lookups, run several project_search calls at once rather than one after another.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "What to find: a question or keywords; names and identifiers help most" }),
			k: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Results to return (default 6: the best three with their text, the rest as path:lines)" })),
			path: Type.Optional(Type.String({ description: "Only files under this path (relative to the project or absolute)" })),
		}),
		outputSchema: Type.Object({
			hits: Type.Array(
				Type.Object({
					path: Type.String(),
					lineStart: Type.Integer(),
					lineEnd: Type.Integer(),
					heading: Type.String(),
					text: Type.String(),
					truncated: Type.Boolean(),
				}),
			),
		}),
		async execute(_id, params) {
			const r = search(params.query, params.k ?? config.results, Math.max(...config.resultChars, 200), params.path);
			if (!r) throw new Error(`Nothing to search: no project root here and no "roots" in ${CONFIG_PATH}.`);
			if (!r.ready) throw new Error("The index is still being built; try again in a moment.");
			const hits = r.hits.map((h) => ({ ...h, path: show(h.path) }));
			const head = hits.length
				? `${hits.length} sections (${(r.micros / 1000).toFixed(1)} ms${r.entities.length ? `; names: ${r.entities.join(", ")}` : ""})`
				: `No sections match "${params.query}". Try other words or names.`;
			return {
				content: [{ type: "text", text: hits.length ? `${head}\n\n${format(r.hits, config.resultChars)}` : head }],
				structuredContent: {
					hits: hits.map(({ path, lineStart, lineEnd, heading, text, truncated }) => ({
						path,
						lineStart,
						lineEnd,
						heading,
						text,
						truncated,
					})),
				},
				details: { count: hits.length, micros: r.micros, entities: r.entities },
			};
		},
	});

	// Auto-recall: only for typed prompts, only doc sections (code is looked up when needed), and only
	// those that cover nearly all of the prompt's rare terms or mention a name the prompt names, so
	// "mach weiter" or "fix the test" add nothing.
	pi.on("before_agent_start", async (event) => {
		if (!config.autoRecall || event.messageType !== "user" || !event.prompt || !index) return;
		const prompt = event.prompt.trim();
		if (prompt.startsWith("/")) return;
		const r = search(prompt, config.autoRecallHits * 2, Math.floor(config.autoRecallChars / config.autoRecallHits), undefined, 300);
		if (!r?.ready) return;
		const hits = r.hits
			.filter(
				(h) =>
					!isCode(h.path) &&
					((h.named > 0 && h.coverage >= config.autoRecallNamedCoverage) ||
					(r.queryTerms >= 3 && h.coverage >= config.autoRecallMinCoverage)),
			)
			.slice(0, config.autoRecallHits);
		if (!hits.length) return;
		return {
			message: {
				customType: "docsearch-recall",
				content: `<doc_search_auto>\nSections from the docs that match this prompt (project_search finds more):\n\n${format(hits)}\n</doc_search_auto>`,
				display: true,
				details: { places: hits.map((h) => `${show(h.path)}:${h.lineStart}`), micros: r.micros },
			},
		};
	});

	pi.registerMessageRenderer("docsearch-recall", (message, _options, theme) => {
		const places: string[] = (message.details as any)?.places ?? [];
		return new Text(theme.fg("accent", "📄 docs ") + theme.fg("dim", places.join(" · ")), 0, 0);
	});

	pi.registerCommand("docs", {
		description: "Search code and docs: /docs <query> · /docs (status) · /docs rebuild · /docs auto on|off",
		handler: async (args, ctx) => {
			const a = (args ?? "").trim();
			if (a === "auto on" || a === "auto off") {
				saveConfig({ autoRecall: a === "auto on" });
				config = loadConfig();
				ctx.ui.notify(`docsearch auto-recall ${config.autoRecall ? "on" : "off"}`, "info");
				return;
			}
			if (a === "rebuild") {
				start(ctx);
				ctx.ui.notify("docsearch: rebuilding", "info");
				return;
			}
			if (!index) {
				ctx.ui.notify(`docsearch: nothing to index here. Add "roots" in ${CONFIG_PATH}.`, "warning");
				return;
			}
			if (!a) {
				const s = index.stats();
				ctx.ui.notify(
					`docsearch: ${s.ready ? `${s.files} files, ${s.sections} sections, ${s.entities} names, built in ${s.buildMs} ms` : "building"}` +
						`\nroots: ${s.roots.map(show).join(", ")}\nauto-recall: ${config.autoRecall ? "on" : "off"} · settings: ${CONFIG_PATH}`,
					"info",
				);
				return;
			}
			const r = search(a, 8, 200);
			if (!r?.ready) return ctx.ui.notify("docsearch: still building", "warning");
			const lines = r.hits.map((h) => `${show(h.path)}:${h.lineStart}-${h.lineEnd}  ${h.heading}`);
			ctx.ui.notify(`${lines.length} sections in ${(r.micros / 1000).toFixed(1)} ms\n${lines.join("\n")}`, "info");
		},
	});
}
