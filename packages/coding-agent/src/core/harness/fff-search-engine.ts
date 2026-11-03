import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export interface FffNativeBridge {
	grepBufferLiteral(
		buffer: Buffer,
		needle: string,
		ignoreCase: boolean,
		budget: number,
		keepChars: number,
	): Array<{ lineNumber: number; lineText: string }>;
	fuzzyFilterPaths(paths: string[], query: string, limit: number): string[];
	fuzzyFilterPackedPaths(packedBuffer: Buffer, query: string, limit: number): number[];
}

let cachedAddon: FffNativeBridge | null | undefined;

export function loadFffNativeAddon(): FffNativeBridge | null {
	if (cachedAddon !== undefined) return cachedAddon;
	try {
		const req = createRequire(import.meta.url);
		const currentDir = path.dirname(fileURLToPath(import.meta.url));
		const platformArch = `${process.platform}-${process.arch}`;
		const candidates = [
			path.resolve(currentDir, "../../../native/fff/prebuilds", platformArch, "fff-bridge.node"),
			path.resolve(path.dirname(process.execPath), "native/fff/prebuilds", platformArch, "fff-bridge.node"),
		];
		for (const candidate of candidates) {
			if (existsSync(candidate)) {
				cachedAddon = req(candidate) as FffNativeBridge;
				return cachedAddon;
			}
		}
	} catch {
		// Fall back cleanly if native addon cannot be loaded
	}
	cachedAddon = null;
	return null;
}

/**
 * High-speed TypeScript fallback for fff-style boundary-aware fuzzy scoring
 * when the C N-API addon is not built.
 */
export function scoreFuzzyPathFallback(pathStr: string, queryLower: string, qMask = 0): number {
	const qLen = queryLower.length;
	if (qLen === 0) return 1;
	const pLen = pathStr.length;
	if (pLen < qLen) return 0;

	let pMask = 0;
	let lastSlash = -1;
	let qi = 0;
	for (let i = 0; i < pLen; i++) {
		let c = pathStr.charCodeAt(i);
		if (c >= 65 && c <= 90) c += 32;
		if (c === 47) {
			lastSlash = i;
		} else if (c >= 97 && c <= 122) {
			pMask |= 1 << (c - 97);
		}
		if (qi < qLen && c === queryLower.charCodeAt(qi)) {
			qi++;
		}
	}
	if ((pMask & qMask) !== qMask || qi < qLen) return 0;

	const baseStart = lastSlash + 1;
	let score = 100;
	let searchFrom = 0;
	let prevMatch = -1;
	let matchedInBasename = 0;

	for (let k = 0; k < qLen; k++) {
		const qc = queryLower.charCodeAt(k);
		let bestPos = -1;
		let bestBonus = -1000;
		const maxIdx = pLen - (qLen - k);

		for (let i = searchFrom; i <= maxIdx; i++) {
			let c = pathStr.charCodeAt(i);
			if (c >= 65 && c <= 90) c += 32;
			if (c !== qc) continue;

			let bonus = 0;
			if (prevMatch !== -1 && i === prevMatch + 1) {
				bonus += 35;
			}
			if (i === baseStart) {
				bonus += 50;
			} else if (i > 0) {
				const prevC = pathStr.charCodeAt(i - 1);
				if (prevC === 47 || prevC === 95 || prevC === 45 || prevC === 46) {
					bonus += 28;
				} else if (prevC >= 97 && prevC <= 122 && pathStr.charCodeAt(i) >= 65 && pathStr.charCodeAt(i) <= 90) {
					bonus += 24;
				}
			}
			if (i >= baseStart) {
				bonus += 15;
			}
			if (bonus > bestBonus) {
				bestBonus = bonus;
				bestPos = i;
				if (bonus >= 50) break;
			}
		}

		if (bestPos === -1) return 0;
		score += 20 + bestBonus;
		if (prevMatch !== -1 && bestPos > prevMatch + 1) {
			score -= (bestPos - prevMatch - 1) * 2;
		}
		if (bestPos >= baseStart) matchedInBasename++;
		prevMatch = bestPos;
		searchFrom = bestPos + 1;
	}

	score -= pLen >> 2;
	if (matchedInBasename === qLen && pLen - baseStart === qLen) {
		score += 80;
	}
	return score > 0 ? score : 1;
}

export function fuzzyFilterPaths(paths: string[], query: string, limit: number, packedBuffer?: Buffer): string[] {
	const cleanedQuery = query.replace(/[*?[\]{}]/g, "").trim();
	if (!cleanedQuery || limit <= 0 || paths.length === 0) return [];

	const addon = loadFffNativeAddon();
	if (addon) {
		if (packedBuffer && typeof addon.fuzzyFilterPackedPaths === "function") {
			const indices = addon.fuzzyFilterPackedPaths(packedBuffer, cleanedQuery, limit);
			const results: string[] = [];
			for (let i = 0; i < indices.length; i++) {
				const p = paths[indices[i]];
				if (p !== undefined) results.push(p);
			}
			return results;
		}
		return addon.fuzzyFilterPaths(paths, cleanedQuery, limit);
	}

	const qLower = cleanedQuery.toLowerCase();
	let qMask = 0;
	for (let i = 0; i < qLower.length; i++) {
		const c = qLower.charCodeAt(i);
		if (c >= 97 && c <= 122) qMask |= 1 << (c - 97);
	}
	const scored: Array<{ path: string; score: number }> = [];
	for (let i = 0; i < paths.length; i++) {
		const p = paths[i];
		const sc = scoreFuzzyPathFallback(p, qLower, qMask);
		if (sc > 0) {
			scored.push({ path: p, score: sc });
		}
	}
	scored.sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	return scored.slice(0, limit).map((s) => s.path);
}
