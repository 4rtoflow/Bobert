import type { ModelCandidate } from "../config/models";
import { findOpenRouterModel, type ModelPricing } from "../llm/model-info";
import { sumUsage, type TokenUsage } from "../llm/types";
import type { ResolvedModel } from "./model";

/**
 * 利用量の表示の行(仕様: docs/spec/behavior.md「利用量の表示」)。返答の末尾に、小さな文字で添える。
 * requestUsagesは、APIを1回呼ぶごとの使用量。トークン数は、その合計を書く。
 * 費用は、OpenRouterでは応答に含まれる費用を使う。Anthropicで直接呼ぶClaudeの候補は、
 * OpenRouterのモデル情報の単価(Anthropicと同じ単価)から計算する。分からなければ、トークン数だけを書く。
 */
export async function usageNote(
	requestUsages: readonly TokenUsage[],
	model: ResolvedModel,
	candidate: ModelCandidate | null,
): Promise<string> {
	const usage = sumUsage(requestUsages);
	const cost =
		usage.costUsd ??
		(model.provider === "anthropic" && candidate !== null
			? await claudeCost(candidate.openRouterId, requestUsages)
			: null);
	const cached =
		usage.cacheReadTokens > 0
			? `(うちキャッシュ ${formatCount(usage.cacheReadTokens)})`
			: "";
	const parts = [
		`入力 ${formatCount(usage.inputTokens)}トークン${cached}`,
		`出力 ${formatCount(usage.outputTokens)}トークン`,
		...(usage.webSearchRequests > 0
			? [`Web検索 ${usage.webSearchRequests}回`]
			: []),
		...(cost === null ? [] : [`約$${formatCost(cost)}`]),
	];
	return `-# ${parts.join("・")}`;
}

/**
 * APIを1回呼んだ分の費用(USD)を、単価から計算する。
 * 入力が多いと単価が上がるモデルは、その回の入力のトークン数(キャッシュの分を含む)で段階を選ぶ。
 * Web検索の費用も足す。
 */
export function costFromPricing(
	pricing: ModelPricing,
	usage: TokenUsage,
): number {
	const tier = pricing.tiers
		.filter((candidate) => usage.inputTokens >= candidate.minPromptTokens)
		.sort((a, b) => b.minPromptTokens - a.minPromptTokens)[0];
	const prices = tier?.prices ?? pricing.base;
	const uncached =
		usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens;
	return (
		uncached * prices.prompt +
		usage.cacheReadTokens * (prices.cacheRead ?? prices.prompt) +
		usage.cacheWriteTokens * (prices.cacheWrite ?? prices.prompt) +
		usage.outputTokens * prices.completion +
		usage.webSearchRequests * (prices.webSearch ?? 0)
	);
}

/**
 * APIを呼んだ分の費用(USD)。寄付から差し引くのに使う(仕様: docs/spec/llm-cost.md「クレジットの寄付」)。
 * 利用量の表示と同じ計算にし、それでも分からない回(単価を取得できなかったときなど)は、候補の一覧の単価で見積もる。
 * 寄付は候補のモデルにしか使わないので、候補が必ずある
 */
export async function chargeableCost(
	requestUsages: readonly TokenUsage[],
	model: ResolvedModel,
	candidate: ModelCandidate,
): Promise<number> {
	const pricing =
		model.provider === "anthropic" &&
		requestUsages.some((usage) => usage.costUsd === null)
			? await claudePricing(candidate.openRouterId)
			: null;
	return requestUsages.reduce(
		(sum, usage) =>
			sum +
			(usage.costUsd ??
				(pricing === null
					? listPriceCost(candidate, usage)
					: costFromPricing(pricing, usage))),
		0,
	);
}

/** Web検索の1回の単価の見積もり(USD)。AnthropicのWeb検索の単価(1,000回あたり$10) */
const WEB_SEARCH_LIST_PRICE = 0.01;

/**
 * 候補の一覧の単価(100万トークンあたりの入力と出力)での見積もり。
 * キャッシュの割引と、入力が多いときの単価は数えない
 */
function listPriceCost(candidate: ModelCandidate, usage: TokenUsage): number {
	return (
		(usage.inputTokens * candidate.price.input +
			usage.outputTokens * candidate.price.output) /
			1_000_000 +
		usage.webSearchRequests * WEB_SEARCH_LIST_PRICE
	);
}

/**
 * Anthropicで直接呼んだときの費用。単価の段階は1回ごとに決まるので、1回ずつ計算して足す。
 * 単価を取得できなければnull
 */
async function claudeCost(
	openRouterId: string,
	requestUsages: readonly TokenUsage[],
): Promise<number | null> {
	const pricing = await claudePricing(openRouterId);
	return pricing
		? requestUsages.reduce(
				(sum, usage) => sum + costFromPricing(pricing, usage),
				0,
			)
		: null;
}

/** Claudeの単価。OpenRouterのモデル情報の単価(Anthropicと同じ単価)を使う。取得できなければnull */
async function claudePricing(
	openRouterId: string,
): Promise<ModelPricing | null> {
	try {
		return (await findOpenRouterModel(openRouterId))?.pricing ?? null;
	} catch {
		return null;
	}
}

/** トークン数を、3桁ごとにカンマで区切って書く */
function formatCount(count: number): string {
	return count.toLocaleString("en-US");
}

/** 費用の書き方。1ドル以上は小数点以下2桁、それより小さければ、上から2桁まで書く(0.0021、0.12) */
export function formatCost(usd: number): string {
	if (usd >= 1) {
		return usd.toFixed(2);
	}
	if (usd <= 0) {
		return "0";
	}
	return usd.toFixed(Math.max(2, 1 - Math.floor(Math.log10(usd))));
}
