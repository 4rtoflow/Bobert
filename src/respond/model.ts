import {
	CUSTOM_MODEL_KEY,
	DEFAULT_MODEL_KEY,
	findModelCandidate,
	MODEL_CANDIDATES,
	type ModelCandidate,
} from "../config/models";
import type { Provider, UserSettings } from "../store/users";

/** 返答に使うモデルと、その呼び出し先 */
export interface ResolvedModel {
	provider: Provider;
	/** プロバイダでのモデルID */
	modelId: string;
	/** 表示用の名前 */
	label: string;
	supportsImages: boolean;
	/** PDFをそのまま読めるか */
	supportsPdf: boolean;
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

	const candidate = selectedCandidate(settings);
	if (candidate === null) {
		return resolveCustomModel(settings.customModelId ?? "", providers);
	}
	const base = {
		label: candidate.label,
		supportsImages: candidate.supportsImages,
		supportsPdf: candidate.supportsPdf,
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

/** 「その他」で入力したモデルを使っているか */
export function usesCustomModel(settings: UserSettings): boolean {
	return (
		settings.modelKey === CUSTOM_MODEL_KEY && Boolean(settings.customModelId)
	);
}

/**
 * 本人が使う候補。「その他」で入力したモデルを使っていればnull。
 * 候補にないモデルが設定されていたら(候補から外したときなど)、既定のモデルを使う。
 */
export function selectedCandidate(
	settings: UserSettings,
): ModelCandidate | null {
	if (usesCustomModel(settings)) {
		return null;
	}
	const candidate =
		findModelCandidate(settings.modelKey) ??
		findModelCandidate(DEFAULT_MODEL_KEY);
	if (!candidate) {
		throw new Error(`Default model ${DEFAULT_MODEL_KEY} is not a candidate`);
	}
	return candidate;
}

/** 登録した資格情報で使える候補。Claudeは、AnthropicのキーかOpenRouterのどちらかがあれば使える */
export function availableCandidates(
	providers: ReadonlySet<Provider>,
): ModelCandidate[] {
	return MODEL_CANDIDATES.filter(
		(candidate) =>
			providers.has("openrouter") ||
			(candidate.anthropicId !== undefined && providers.has("anthropic")),
	);
}

/** 「その他」で入力したIDの呼び出し先。claude-で始まるものはAnthropicで直接、それ以外はOpenRouterで呼ぶ */
export function customModelProvider(modelId: string): Provider {
	return modelId.startsWith("claude-") ? "anthropic" : "openrouter";
}

function resolveCustomModel(
	modelId: string,
	providers: ReadonlySet<Provider>,
): ModelResolution {
	const provider = customModelProvider(modelId);
	if (!providers.has(provider)) {
		return { ok: false, missing: provider, label: modelId };
	}
	// Claudeは画像とPDFを読める。ほかのモデルが読めるかはここでは分からないので、
	// 応答の処理で、OpenRouterのモデル情報から確かめる
	return {
		ok: true,
		model: {
			provider,
			modelId,
			label: modelId,
			supportsImages: provider === "anthropic",
			supportsPdf: provider === "anthropic",
		},
	};
}
