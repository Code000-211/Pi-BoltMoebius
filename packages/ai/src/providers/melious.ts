import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider, type RefreshModelsContext } from "../models.ts";
import type { AnyModel, ModelCost } from "../types.ts";
import { isModelType } from "../utils/model-operations.ts";
import { MELIOUS_MODEL_CATALOG } from "./melious.catalog.generated.ts";
import { withCatalogListing } from "./model-listing.ts";

export const MELIOUS_BASE_URL = "https://api.melious.ai/v1";
const MELIOUS_MODELS_TIMEOUT_MS = 15_000;

export interface MeliousModelPricing {
	prompt?: string | number;
	completion?: string | number;
	input?: string | number;
	output?: string | number;
	input_cache_read?: string | number;
	input_cache_write?: string | number;
}

export interface MeliousModelMeta {
	context_length?: number | null;
	max_completion_tokens?: number | null;
	pricing?: MeliousModelPricing;
	reasoning?: boolean;
	modalities?: {
		input?: string[];
		output?: string[];
	};
}

export interface MeliousModelEntry {
	id: string;
	name?: string;
	context_length?: number | null;
	max_completion_tokens?: number | null;
	pricing?: MeliousModelPricing;
	_meta?: MeliousModelMeta;
}

function parsePerMillionRate(value: string | number | undefined, fallback: number): number {
	if (typeof value === "number") {
		if (!Number.isFinite(value) || value < 0) return fallback;
		// Values < 0.01 are per-token rates; convert to $/1M tokens.
		return value > 0 && value < 0.01 ? Number((value * 1_000_000).toFixed(6)) : value;
	}
	if (typeof value === "string") {
		const parsed = Number.parseFloat(value);
		if (!Number.isFinite(parsed) || parsed < 0) return fallback;
		return parsed > 0 && parsed < 0.01 ? Number((parsed * 1_000_000).toFixed(6)) : parsed;
	}
	return fallback;
}

export function meliousCost(pricing: MeliousModelPricing | undefined, fallback?: ModelCost): ModelCost {
	const base = fallback ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	if (!pricing) return base;
	return {
		input: parsePerMillionRate(pricing.prompt ?? pricing.input, base.input),
		output: parsePerMillionRate(pricing.completion ?? pricing.output, base.output),
		cacheRead: parsePerMillionRate(pricing.input_cache_read, base.cacheRead),
		cacheWrite: parsePerMillionRate(pricing.input_cache_write, base.cacheWrite),
	};
}

/**
 * Enrich and synchronize the Melious catalog with `GET /models?include_meta=true` when a key is
 * available. Existing models in the static catalog retain their compatibility metadata while
 * receiving updated context window and pricing from `_meta`, and any newly added models returned by
 * the Melious API are appended automatically.
 */
export async function personalizeMeliousCatalog(
	catalog: readonly AnyModel[],
	context: RefreshModelsContext,
): Promise<readonly AnyModel[]> {
	const key = context.credential?.type === "oauth" ? context.credential.access : context.credential?.key;
	if (!key) return catalog;
	const baseUrl = (context.baseUrl ?? MELIOUS_BASE_URL).replace(/\/+$/, "");
	const modelsUrl = baseUrl.endsWith("/v1")
		? `${baseUrl}/models?include_meta=true`
		: `${baseUrl}/v1/models?include_meta=true`;
	let response: Response;
	try {
		response = await fetch(modelsUrl, {
			headers: { accept: "application/json", authorization: `Bearer ${key}` },
			signal: AbortSignal.any([context.signal, AbortSignal.timeout(MELIOUS_MODELS_TIMEOUT_MS)]),
		});
	} catch {
		return catalog;
	}
	if (response.status === 401 || response.status === 403 || response.status === 404) return catalog;
	if (!response.ok) return catalog;
	const body: unknown = await response.json();
	if (typeof body !== "object" || body === null || !("data" in body) || !Array.isArray(body.data)) {
		return catalog;
	}
	const discovered = new Map<string, MeliousModelEntry>();
	for (const entry of body.data as unknown[]) {
		if (typeof entry === "object" && entry !== null && "id" in entry && typeof entry.id === "string") {
			discovered.set(entry.id, entry as MeliousModelEntry);
		}
	}
	if (discovered.size === 0) return catalog;

	const seen = new Set<string>();
	const updated = catalog.map((model): AnyModel => {
		if (!isModelType(model, "chat")) return model;
		seen.add(model.id);
		const entry = discovered.get(model.id);
		if (!entry) return model;
		const meta = entry._meta;
		const contextWindow = meta?.context_length || entry.context_length || model.contextWindow;
		const maxTokens = meta?.max_completion_tokens || entry.max_completion_tokens || model.maxTokens;
		const pricing = meta?.pricing ?? entry.pricing;
		return {
			...model,
			contextWindow,
			maxTokens,
			cost: pricing ? meliousCost(pricing, model.cost) : model.cost,
		};
	});

	for (const [id, entry] of discovered) {
		if (seen.has(id)) continue;
		const meta = entry._meta;
		const contextWindow = meta?.context_length || entry.context_length || 131_072;
		const maxTokens = meta?.max_completion_tokens || entry.max_completion_tokens || Math.min(contextWindow, 65_536);
		const inputModalities = meta?.modalities?.input;
		const hasImage = Array.isArray(inputModalities) && inputModalities.includes("image");
		const lowerId = id.toLowerCase();
		const reasoning =
			meta?.reasoning ??
			(lowerId.includes("deepseek") ||
				lowerId.includes("glm-5") ||
				lowerId.includes("qwen3") ||
				lowerId.includes("kimi") ||
				lowerId.includes("gpt-oss") ||
				lowerId.includes("minimax") ||
				lowerId.includes("r1"));
		updated.push({
			type: "chat",
			id,
			name: entry.name || id,
			api: "openai-completions",
			provider: "melious",
			baseUrl: MELIOUS_BASE_URL,
			reasoning,
			input: hasImage ? ["text", "image"] : ["text"],
			cost: meliousCost(meta?.pricing ?? entry.pricing),
			compat: {
				supportsStore: false,
				supportsDeveloperRole: false,
				supportsReasoningEffort: reasoning,
				supportsUsageInStreaming: true,
				maxTokensField: "max_tokens",
				thinkingFormat: "openai",
				supportsLongCacheRetention: false,
				supportsStrictMode: true,
			},
			contextWindow,
			maxTokens,
		});
	}

	return updated;
}

export function meliousProvider(): Provider<"anthropic-messages" | "openai-completions"> {
	return withCatalogListing(
		createProvider<"anthropic-messages" | "openai-completions">({
			id: "melious",
			name: "Melious",
			baseUrl: MELIOUS_BASE_URL,
			auth: { apiKey: envApiKeyAuth("Melious API key", ["MELIOUS_API_KEY"]) },
			get models() {
				return Object.values(MELIOUS_MODEL_CATALOG.chat());
			},
			api: {
				"anthropic-messages": anthropicMessagesApi(),
				"openai-completions": openAICompletionsApi(),
			},
		}),
		MELIOUS_MODEL_CATALOG,
	);
}
