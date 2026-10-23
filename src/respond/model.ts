import { DEFAULT_MODEL_KEY, MODEL_CANDIDATES } from "../config/models";
import type { Provider, UserSettings } from "../store/users";

/** 返答に使うモデルと、その呼び出し先 */
export interface ResolvedModel {
	provider: Provider;
	/** プロバイダでのモデルID */
	modelId: string;
	/** 表示用の名前 */
	label: string;
	supportsImages: boolean;
}

export type ModelResolution =
	| { ok: true; model: ResolvedModel }
	| {
			ok: false;
			/** 何が足りないか。返信で登録方法を案内する */
			missing: "credentials" | "anthropic" | "openrouter";
			label: string;
	  };

/**
 * 本人の設定と登録済みの資格情報から、使うモデルと呼び出し先を決める
 * (仕様: docs/spec/llm-cost.md「モデルの候補」)。
 * Claudeは、Anthropicのキーがあれば直接呼び(Max/Teamの付属クレジットが使える)、なければOpenRouter経由で呼ぶ。
 */
export function resolveModel(
	settings: UserSettings,
	providers: ReadonlySet<Provider>,
): ModelResolution {
	if (providers.size === 0) {
		return { ok: false, missing: "credentials", label: "" };
	}

	if (settings.modelKey === "custom" && settings.customModelId) {
		// 「その他」で入力されたID。claude-で始まるものはAnthropicで直接、それ以外はOpenRouterで呼ぶ
		const id = settings.customModelId;
		const provider: Provider = id.startsWith("claude-")
			? "anthropic"
			: "openrouter";
		if (!providers.has(provider)) {
			return { ok: false, missing: provider, label: id };
		}
		// 画像に対応しているかは、Claude以外は分からないので渡さない
		return {
			ok: true,
			model: {
				provider,
				modelId: id,
				label: id,
				supportsImages: provider === "anthropic",
			},
		};
	}

	const candidate =
		MODEL_CANDIDATES.find((model) => model.key === settings.modelKey) ??
		MODEL_CANDIDATES.find((model) => model.key === DEFAULT_MODEL_KEY);
	if (!candidate) {
		throw new Error(`Default model ${DEFAULT_MODEL_KEY} is not a candidate`);
	}
	const base = {
		label: candidate.label,
		supportsImages: candidate.supportsImages,
	};
	if (candidate.anthropicId && providers.has("anthropic")) {
		return {
			ok: true,
			model: { ...base, provider: "anthropic", modelId: candidate.anthropicId },
		};
	}
	if (providers.has("openrouter")) {
		return {
			ok: true,
			model: {
				...base,
				provider: "openrouter",
				modelId: candidate.openRouterId,
			},
		};
	}
	return { ok: false, missing: "openrouter", label: candidate.label };
}
