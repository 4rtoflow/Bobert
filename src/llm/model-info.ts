/**
 * モデル情報。取得したら、しばらく使い回す。
 * - OpenRouterのモデル一覧: 「その他」で入力されたモデルの存在の確認、画像を読めるかの判断、選べる思考の深さに使う。
 *   一覧は大きい(数百件、約800KB)
 * - Anthropicのモデル情報: 「その他」で入力したClaudeで選べる思考の深さに使う
 */
import { type AnthropicCredential, checkAnthropicModel } from "./anthropic";

const MODELS_URL = "https://openrouter.ai/api/v1/models";

/** モデル情報を使い回す時間 */
const CACHE_TTL_MS = 60 * 60_000;

/** OpenRouterのモデルについて、Bobertが使う情報 */
export interface OpenRouterModelInfo {
	id: string;
	/** 画像を読めるか */
	supportsImages: boolean;
	/** 選べる思考の深さ(effort)。並びはOpenRouterのまま。空なら選べない */
	efforts: string[];
}

interface ModelsResponse {
	data?: {
		id?: unknown;
		architecture?: { input_modalities?: unknown };
		reasoning?: { supported_efforts?: unknown };
	}[];
}

/**
 * 取得したOpenRouterのモデル一覧。取得中のPromiseは、同時に来たほかのリクエストと分け合わない。
 * Workersでは、別のリクエストが作ったPromiseを待つと、処理が止まることがあるため。
 */
let cache: {
	models: Map<string, OpenRouterModelInfo>;
	expiresAt: number;
} | null = null;

/** 「その他」で入力したClaudeで選べる思考の深さ(モデルIDごと) */
const claudeEffortCache = new Map<
	string,
	{ efforts: string[]; expiresAt: number }
>();

/** OpenRouterのモデルを探す。一覧になければnull。一覧を取得できなければ例外を投げる */
export async function findOpenRouterModel(
	id: string,
): Promise<OpenRouterModelInfo | null> {
	return (await loadModels()).get(id) ?? null;
}

/**
 * 「その他」で入力したClaudeで選べる思考の深さ(浅い順)。本人のキーで、Anthropicのモデル情報から取り出す。
 * 確かめられなければ、例外を投げる。
 */
export async function findClaudeEfforts(
	credential: AnthropicCredential,
	modelId: string,
): Promise<string[]> {
	const cached = claudeEffortCache.get(modelId);
	if (cached !== undefined && Date.now() < cached.expiresAt) {
		return cached.efforts;
	}
	const check = await checkAnthropicModel(credential, modelId);
	if (check.status !== "found") {
		throw new Error(`Anthropic model check failed: ${check.status}`);
	}
	claudeEffortCache.set(modelId, {
		efforts: check.efforts,
		expiresAt: Date.now() + CACHE_TTL_MS,
	});
	return check.efforts;
}

/** 使い回しているモデル情報を捨てる(テスト用) */
export function clearModelInfoCache(): void {
	cache = null;
	claudeEffortCache.clear();
}

async function loadModels(): Promise<Map<string, OpenRouterModelInfo>> {
	if (cache !== null && Date.now() < cache.expiresAt) {
		return cache.models;
	}
	const models = await fetchModels();
	cache = { models, expiresAt: Date.now() + CACHE_TTL_MS };
	return models;
}

async function fetchModels(): Promise<Map<string, OpenRouterModelInfo>> {
	const response = await fetch(MODELS_URL);
	if (!response.ok) {
		throw new Error(
			`OpenRouter models request failed with status ${response.status}`,
		);
	}
	const data = (await response.json()) as ModelsResponse;
	const models = new Map<string, OpenRouterModelInfo>();
	for (const model of data.data ?? []) {
		if (typeof model.id !== "string") {
			continue;
		}
		const modalities = model.architecture?.input_modalities;
		const efforts = model.reasoning?.supported_efforts;
		models.set(model.id, {
			id: model.id,
			supportsImages: Array.isArray(modalities) && modalities.includes("image"),
			efforts: Array.isArray(efforts)
				? efforts.filter((effort) => typeof effort === "string")
				: [],
		});
	}
	return models;
}
