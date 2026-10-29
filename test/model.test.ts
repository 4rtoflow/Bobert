import { describe, expect, it } from "vitest";
import { resolveModel } from "../src/respond/model";
import { DEFAULT_USER_SETTINGS, type Provider } from "../src/store/users";

const providers = (...names: Provider[]) => new Set(names);

describe("使うモデルと呼び出し先の決定", () => {
	it("キーを登録していなければ、登録を案内する", () => {
		expect(resolveModel(DEFAULT_USER_SETTINGS, providers())).toEqual({
			ok: false,
			missing: "credentials",
			label: "",
		});
	});

	it("既定はClaude Haiku 5.5。Anthropicのキーがあれば直接呼ぶ", () => {
		expect(
			resolveModel(DEFAULT_USER_SETTINGS, providers("anthropic", "openrouter")),
		).toEqual({
			ok: true,
			model: {
				provider: "anthropic",
				modelId: "claude-haiku-5-5",
				label: "Claude Haiku 5.5",
				supportsImages: true,
				supportsPdf: true,
			},
		});
	});

	it("Anthropicのキーがなければ、ClaudeもOpenRouter経由で呼ぶ", () => {
		const resolution = resolveModel(
			DEFAULT_USER_SETTINGS,
			providers("openrouter"),
		);
		expect(resolution).toMatchObject({
			ok: true,
			model: { provider: "openrouter", modelId: "anthropic/claude-haiku-5.5" },
		});
	});

	it("Claude以外のモデルには、OpenRouterとの連携が必要", () => {
		const settings = { ...DEFAULT_USER_SETTINGS, modelKey: "gpt-6-luna" };
		expect(resolveModel(settings, providers("anthropic"))).toEqual({
			ok: false,
			missing: "openrouter",
			label: "GPT-6 Luna",
		});
		expect(
			resolveModel(settings, providers("anthropic", "openrouter")),
		).toMatchObject({
			ok: true,
			model: { provider: "openrouter", modelId: "openai/gpt-6-luna" },
		});
	});

	it("その他で入力したIDは、claude-で始まればAnthropic、それ以外はOpenRouterで呼ぶ", () => {
		const claude = {
			...DEFAULT_USER_SETTINGS,
			modelKey: "custom",
			customModelId: "claude-sonnet-4-6",
		};
		expect(resolveModel(claude, providers("openrouter"))).toEqual({
			ok: false,
			missing: "anthropic",
			label: "claude-sonnet-4-6",
		});

		const other = {
			...DEFAULT_USER_SETTINGS,
			modelKey: "custom",
			customModelId: "x-ai/grok-4.7-mini",
		};
		expect(resolveModel(other, providers("openrouter"))).toEqual({
			ok: true,
			model: {
				provider: "openrouter",
				modelId: "x-ai/grok-4.7-mini",
				label: "x-ai/grok-4.7-mini",
				supportsImages: false,
				supportsPdf: false,
			},
		});
	});

	it("候補にないモデルが設定されていたら、既定のモデルを使う", () => {
		const settings = { ...DEFAULT_USER_SETTINGS, modelKey: "retired-model" };
		expect(resolveModel(settings, providers("anthropic"))).toMatchObject({
			ok: true,
			model: { modelId: "claude-haiku-5-5" },
		});
	});
});
