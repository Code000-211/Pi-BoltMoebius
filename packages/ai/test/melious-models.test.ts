import { afterEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../src/compat.ts";
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.ts";
import type { RefreshModelsContext } from "../src/models.ts";
import { MELIOUS_BASE_URL, meliousProvider, personalizeMeliousCatalog } from "../src/providers/melious.ts";

const originalMeliousApiKey = process.env.MELIOUS_API_KEY;

afterEach(() => {
	if (originalMeliousApiKey === undefined) {
		delete process.env.MELIOUS_API_KEY;
	} else {
		process.env.MELIOUS_API_KEY = originalMeliousApiKey;
	}
	vi.restoreAllMocks();
});

function refreshContext(key = "sk-mel-test"): RefreshModelsContext {
	return {
		credential: { type: "api_key", key },
		publish: async () => true,
		allowNetwork: true,
		signal: new AbortController().signal,
	};
}

describe("Melious provider and models", () => {
	it("exposes built-in Melious models with https://api.melious.ai/v1 baseUrl", () => {
		const glm = getModel("melious", "glm-5.3");
		expect(glm.provider).toBe("melious");
		expect(glm.baseUrl).toBe(MELIOUS_BASE_URL);
		expect(glm.reasoning).toBe(true);
		expect(glm.input).toEqual(["text", "image"]);

		const gptOss = getModel("melious", "gpt-oss-120b");
		expect(gptOss.provider).toBe("melious");
		expect(gptOss.contextWindow).toBe(131072);
	});

	it("resolves MELIOUS_API_KEY from the environment", () => {
		process.env.MELIOUS_API_KEY = "sk-mel-env-key";

		expect(findEnvKeys("melious")).toEqual(["MELIOUS_API_KEY"]);
		expect(getEnvApiKey("melious")).toBe("sk-mel-env-key");
	});

	it("enriches existing catalog models and appends new models from /v1/models?include_meta=true", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			Response.json({
				object: "list",
				data: [
					{
						id: "glm-5.3",
						_meta: {
							context_length: 1_048_576,
							max_completion_tokens: 262_144,
							pricing: {
								prompt: "0.0000011",
								completion: "0.0000035",
							},
						},
					},
					{
						id: "deepseek-v4.2-preview",
						name: "DeepSeek V4.2 Preview",
						_meta: {
							context_length: 1_000_000,
							max_completion_tokens: 131_072,
							reasoning: true,
							modalities: { input: ["text", "image"] },
							pricing: {
								prompt: "0.0000005",
								completion: "0.0000015",
							},
						},
					},
				],
			}),
		);

		const catalog = meliousProvider().getModels();
		const personalized = await personalizeMeliousCatalog(catalog, refreshContext());

		const glm = personalized.find((m) => m.id === "glm-5.3");
		expect(glm).toMatchObject({
			contextWindow: 1_048_576,
			maxTokens: 262_144,
			cost: { input: 1.1, output: 3.5, cacheRead: 0.12, cacheWrite: 0 },
		});

		const preview = personalized.find((m) => m.id === "deepseek-v4.2-preview");
		expect(preview).toMatchObject({
			id: "deepseek-v4.2-preview",
			name: "DeepSeek V4.2 Preview",
			provider: "melious",
			api: "openai-completions",
			baseUrl: MELIOUS_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 1_000_000,
			maxTokens: 131_072,
			cost: { input: 0.5, output: 1.5, cacheRead: 0, cacheWrite: 0 },
		});
	});

	it("keeps the catalog when the model list is not JSON", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("<html>bad gateway</html>", { status: 200 }));
		const catalog = meliousProvider().getModels();
		await expect(personalizeMeliousCatalog(catalog, refreshContext())).resolves.toBe(catalog);
	});
});
