/**
 * モデル情報(OpenRouterのモデル一覧)。
 * 「その他」で入力されたモデルの存在の確認と、画像を読めるかの判断に使う。
 * 一覧は大きい(数百件、約800KB)ので、取得したら、しばらく使い回す。
 */

const MODELS_URL = "https://openrouter.ai/api/v1/models";

/** 一覧を使い回す時間 */
const CACHE_TTL_MS = 60 * 60_000;

/** OpenRouterのモデルについて、Bobertが使う情報 */
export interface OpenRouterModelInfo {
	id: string;
	/** 画像を読めるか */
	supportsImages: boolean;
}

interface ModelsResponse {
	data?: {
		id?: unknown;
		architecture?: { input_modalities?: unknown };
	}[];
}

/**
 * 取得した一覧。取得中のPromiseは、同時に来たほかのリクエストと分け合わない。
 * Workersでは、別のリクエストが作ったPromiseを待つと、処理が止まることがあるため。
 */
let cache: {
	models: Map<string, OpenRouterModelInfo>;
	expiresAt: number;
} | null = null;

/** OpenRouterのモデルを探す。一覧になければnull。一覧を取得できなければ例外を投げる */
export async function findOpenRouterModel(
	id: string,
): Promise<OpenRouterModelInfo | null> {
	return (await loadModels()).get(id) ?? null;
}

/** 使い回している一覧を捨てる(テスト用) */
export function clearModelInfoCache(): void {
	cache = null;
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
		models.set(model.id, {
			id: model.id,
			supportsImages: Array.isArray(modalities) && modalities.includes("image"),
		});
	}
	return models;
}
