/**
 * モデル情報。取得したら、しばらく使い回す。
 * - OpenRouterのモデル一覧: 「その他」で入力されたモデルの存在の確認、画像を読めるかの判断、選べる思考の深さ、
 *   Web検索を使えるかの判断、利用量の表示の費用(Anthropicで直接呼ぶClaude)に使う。
 *   一覧は大きい(数百件、約800KB)
 * - Anthropicのモデル情報: 「その他」で入力したClaudeで選べる思考の深さと、Web検索を使えるかに使う
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
	/** 道具を使えるか。OpenRouterのWeb検索は、モデルが道具として呼ぶので、使えないモデルでは検索できない */
	supportsTools: boolean;
	/** 単価。分からなければnull */
	pricing: ModelPricing | null;
}

/** 「その他」で入力したClaudeについて、Anthropicのモデル情報から分かること */
export interface ClaudeModelInfo {
	/** 選べる思考の深さ(浅い順)。空なら選べない */
	efforts: string[];
	/** Web検索を使えるか */
	webSearch: boolean;
}

/** モデルの単価 */
export interface ModelPricing {
	base: TokenPrices;
	/** 入力が多いと単価が上がるモデルの、段階ごとの単価(入力のトークン数がminPromptTokens以上のとき) */
	tiers: { minPromptTokens: number; prices: TokenPrices }[];
}

/** 1トークンあたりの単価(USD) */
export interface TokenPrices {
	prompt: number;
	completion: number;
	/** キャッシュから読む入力。なければpromptの単価 */
	cacheRead: number | null;
	/** キャッシュに書く入力(5分間保持)。なければpromptの単価 */
	cacheWrite: number | null;
	/** Web検索1回 */
	webSearch: number | null;
}

/** OpenRouterの単価(1トークンあたりのUSDを文字列で持つ) */
interface PricingResponse {
	prompt?: unknown;
	completion?: unknown;
	input_cache_read?: unknown;
	input_cache_write?: unknown;
	web_search?: unknown;
	/** 入力が多いときの単価や、時間帯ごとの単価 */
	overrides?: unknown;
}

interface ModelsResponse {
	data?: {
		id?: unknown;
		architecture?: { input_modalities?: unknown };
		reasoning?: { supported_efforts?: unknown };
		supported_parameters?: unknown;
		pricing?: PricingResponse;
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

/** 「その他」で入力したClaudeのモデル情報(モデルIDごと) */
const claudeModelCache = new Map<
	string,
	{ info: ClaudeModelInfo; expiresAt: number }
>();

/** OpenRouterのモデルを探す。一覧になければnull。一覧を取得できなければ例外を投げる */
export async function findOpenRouterModel(
	id: string,
): Promise<OpenRouterModelInfo | null> {
	return (await loadModels()).get(id) ?? null;
}

/**
 * 「その他」で入力したClaudeのモデル情報。本人のキーで、Anthropicのモデル情報から取り出す。
 * 確かめられなければ、例外を投げる。
 */
export async function findClaudeModel(
	credential: AnthropicCredential,
	modelId: string,
): Promise<ClaudeModelInfo> {
	const cached = claudeModelCache.get(modelId);
	if (cached !== undefined && Date.now() < cached.expiresAt) {
		return cached.info;
	}
	const check = await checkAnthropicModel(credential, modelId);
	if (check.status !== "found") {
		throw new Error(`Anthropic model check failed: ${check.status}`);
	}
	const info = { efforts: check.efforts, webSearch: check.webSearch };
	claudeModelCache.set(modelId, {
		info,
		expiresAt: Date.now() + CACHE_TTL_MS,
	});
	return info;
}

/** 使い回しているモデル情報を捨てる(テスト用) */
export function clearModelInfoCache(): void {
	cache = null;
	claudeModelCache.clear();
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
		const parameters = model.supported_parameters;
		models.set(model.id, {
			id: model.id,
			supportsImages: Array.isArray(modalities) && modalities.includes("image"),
			efforts: Array.isArray(efforts)
				? efforts.filter((effort) => typeof effort === "string")
				: [],
			supportsTools: Array.isArray(parameters) && parameters.includes("tools"),
			pricing: model.pricing ? parsePricing(model.pricing) : null,
		});
	}
	return models;
}

/**
 * 単価を読む。段階ごとの単価のうち、入力のトークン数で決まるもの(min_prompt_tokens)だけを使う。
 * 時間帯で変わる単価は、Anthropicで直接呼ぶClaudeには関係しないので使わない。
 */
function parsePricing(pricing: PricingResponse): ModelPricing | null {
	const base = parsePrices(pricing, null);
	if (base === null) {
		return null;
	}
	const tiers: ModelPricing["tiers"] = [];
	for (const override of Array.isArray(pricing.overrides)
		? pricing.overrides
		: []) {
		const minPromptTokens = override?.min_prompt_tokens;
		const prices = parsePrices(override, base);
		if (typeof minPromptTokens === "number" && prices !== null) {
			tiers.push({ minPromptTokens, prices });
		}
	}
	return { base, tiers };
}

/** 単価を数にする。書かれていない単価は、fallbackのものを使う */
function parsePrices(
	pricing: PricingResponse,
	fallback: TokenPrices | null,
): TokenPrices | null {
	const price = (value: unknown) => {
		const number = typeof value === "string" ? Number(value) : Number.NaN;
		return Number.isFinite(number) ? number : null;
	};
	const prompt = price(pricing.prompt) ?? fallback?.prompt ?? null;
	const completion = price(pricing.completion) ?? fallback?.completion ?? null;
	if (prompt === null || completion === null) {
		return null;
	}
	return {
		prompt,
		completion,
		cacheRead: price(pricing.input_cache_read) ?? fallback?.cacheRead ?? null,
		cacheWrite:
			price(pricing.input_cache_write) ?? fallback?.cacheWrite ?? null,
		webSearch: price(pricing.web_search) ?? fallback?.webSearch ?? null,
	};
}
