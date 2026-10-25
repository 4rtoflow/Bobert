import type { ModelCandidate } from "../config/models";
import { findOpenRouterModel, type ModelPricing } from "../llm/model-info";
import type { TokenUsage } from "../llm/types";
import type { ResolvedModel } from "./model";

/**
 * 利用量の表示の行(仕様: docs/spec/behavior.md「利用量の表示」)。返答の末尾に、小さな文字で添える。
 * 費用は、OpenRouterでは応答に含まれる費用を使う。Anthropicで直接呼ぶClaudeの候補は、
 * OpenRouterのモデル情報の単価(Anthropicと同じ単価)から計算する。分からなければ、トークン数だけを書く。
 */
export async function usageNote(
	usage: TokenUsage,
	model: ResolvedModel,
	candidate: ModelCandidate | null,
): Promise<string> {
	const cost =
		usage.costUsd ??
		(model.provider === "anthropic" && candidate !== null
			? await claudeCost(candidate.openRouterId, usage)
			: null);
	const cached =
		usage.cacheReadTokens > 0
			? `(うちキャッシュ ${formatCount(usage.cacheReadTokens)})`
			: "";
	const parts = [
		`入力 ${formatCount(usage.inputTokens)}トークン${cached}`,
		`出力 ${formatCount(usage.outputTokens)}トークン`,
		...(cost === null ? [] : [`約$${formatCost(cost)}`]),
	];
	return `-# ${parts.join("・")}`;
}

/**
 * 単価から費用(USD)を計算する。入力が多いと単価が上がるモデルは、入力のトークン数(キャッシュの分を含む)で段階を選ぶ。
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
		usage.outputTokens * prices.completion
	);
}

/** Anthropicで直接呼んだときの費用。単価を取得できなければnull */
async function claudeCost(
	openRouterId: string,
	usage: TokenUsage,
): Promise<number | null> {
	try {
		const pricing = (await findOpenRouterModel(openRouterId))?.pricing;
		return pricing ? costFromPricing(pricing, usage) : null;
	} catch {
		return null;
	}
}

/** トークン数を、3桁ごとにカンマで区切って書く */
function formatCount(count: number): string {
	return count.toLocaleString("en-US");
}

/** 費用の書き方。1ドル以上は小数点以下2桁、それより小さければ、上から2桁まで書く(0.0021、0.12) */
function formatCost(usd: number): string {
	if (usd >= 1) {
		return usd.toFixed(2);
	}
	if (usd <= 0) {
		return "0";
	}
	return usd.toFixed(Math.max(2, 1 - Math.floor(Math.log10(usd))));
}
