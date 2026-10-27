import { afterEach, describe, expect, it, vi } from "vitest";
import { findModelCandidate } from "../src/config/models";
import { clearModelInfoCache } from "../src/llm/model-info";
import type { TokenUsage } from "../src/llm/types";
import type { ResolvedModel } from "../src/respond/model";
import { costFromPricing, usageNote } from "../src/respond/usage";
import { mockFetch } from "./helpers";

afterEach(() => {
	vi.restoreAllMocks();
	clearModelInfoCache();
});

/** 入力12,345トークン(うちキャッシュから10,000)、出力678トークン */
function usage(overrides: Partial<TokenUsage> = {}): TokenUsage {
	return {
		inputTokens: 12_345,
		outputTokens: 678,
		cacheReadTokens: 10_000,
		cacheWriteTokens: 0,
		webSearchRequests: 0,
		costUsd: null,
		...overrides,
	};
}

const HAIKU = findModelCandidate("claude-haiku-5.5") ?? null;

/** Anthropicで直接呼ぶClaude Haiku 5.5 */
const HAIKU_DIRECT: ResolvedModel = {
	provider: "anthropic",
	modelId: "claude-haiku-5-5",
	label: "Claude Haiku 5.5",
	supportsImages: true,
};

/** OpenRouterのモデル一覧に載っている、Claude Haiku 5.5の単価(1トークンあたりのUSD) */
function mockHaikuPricing() {
	return mockFetch(() =>
		Response.json({
			data: [
				{
					id: "anthropic/claude-haiku-5.5",
					pricing: {
						prompt: "0.0000001",
						completion: "0.0000005",
						input_cache_read: "0.00000001",
						input_cache_write: "0.000000125",
						overrides: [
							{
								min_prompt_tokens: 100000,
								prompt: "0.0000005",
								completion: "0.0000025",
								input_cache_read: "0.00000005",
								input_cache_write: "0.000000625",
							},
						],
					},
				},
			],
		}),
	);
}

describe("利用量の表示", () => {
	it("OpenRouter経由なら、応答に含まれる費用を書く", async () => {
		const note = await usageNote(
			[usage({ costUsd: 0.0021 })],
			{
				provider: "openrouter",
				modelId: "openai/gpt-6-luna",
				label: "GPT-6 Luna",
				supportsImages: true,
			},
			findModelCandidate("gpt-6-luna") ?? null,
		);

		expect(note).toBe(
			"-# 入力 12,345トークン(うちキャッシュ 10,000)・出力 678トークン・約$0.0021",
		);
	});

	it("Anthropicで直接呼ぶClaudeは、OpenRouterのモデル情報の単価から費用を計算する", async () => {
		mockHaikuPricing();

		const note = await usageNote([usage()], HAIKU_DIRECT, HAIKU);

		// 2,345×$0.1 + 10,000×$0.01(キャッシュ) + 678×$0.5(100万トークンあたり) = 約$0.00067
		expect(note).toBe(
			"-# 入力 12,345トークン(うちキャッシュ 10,000)・出力 678トークン・約$0.00067",
		);
	});

	it("Web検索をしたら、回数を書き、検索の費用も足す", async () => {
		mockFetch(() =>
			Response.json({
				data: [
					{
						id: "anthropic/claude-haiku-5.5",
						pricing: {
							prompt: "0.0000001",
							completion: "0.0000005",
							input_cache_read: "0.00000001",
							web_search: "0.01",
						},
					},
				],
			}),
		);

		const note = await usageNote(
			[usage({ webSearchRequests: 2 })],
			HAIKU_DIRECT,
			HAIKU,
		);

		// トークンの分(約$0.00067)に、検索2回の$0.02を足す
		expect(note).toBe(
			"-# 入力 12,345トークン(うちキャッシュ 10,000)・出力 678トークン・Web検索 2回・約$0.021",
		);
	});

	it("入力が多くて単価が上がるときは、上がった単価で計算する", async () => {
		mockHaikuPricing();

		const note = await usageNote(
			[
				usage({
					inputTokens: 150_000,
					cacheReadTokens: 100_000,
					cacheWriteTokens: 50_000,
					outputTokens: 1_000,
				}),
			],
			HAIKU_DIRECT,
			HAIKU,
		);

		// 100,000×$0.05(キャッシュから) + 50,000×$0.625(キャッシュに書く) + 1,000×$2.5 = 約$0.039
		expect(note).toBe(
			"-# 入力 150,000トークン(うちキャッシュ 100,000)・出力 1,000トークン・約$0.039",
		);
	});

	it("何回かに分けて呼んだときは、1回ごとの入力で単価の段階を選ぶ", async () => {
		mockHaikuPricing();
		const request = usage({
			inputTokens: 60_000,
			cacheReadTokens: 0,
			outputTokens: 100,
		});

		const note = await usageNote([request, request], HAIKU_DIRECT, HAIKU);

		// 合計の12万トークンは境目(10万)を超えるが、1回ごとには超えないので、ふだんの単価で計算する
		// 2回 ×(60,000×$0.1 + 100×$0.5)(100万トークンあたり) = 約$0.012
		expect(note).toBe("-# 入力 120,000トークン・出力 200トークン・約$0.012");
	});

	it("キャッシュから読んだ分がなければ括弧を書かず、単価が分からなければ費用を書かない", async () => {
		// 「その他」で入力したClaudeは、単価が分からない
		const note = await usageNote(
			[usage({ cacheReadTokens: 0 })],
			{
				provider: "anthropic",
				modelId: "claude-sonnet-4-6",
				label: "claude-sonnet-4-6",
				supportsImages: true,
			},
			null,
		);

		expect(note).toBe("-# 入力 12,345トークン・出力 678トークン");
	});

	it("単価を取得できなければ、費用を書かない", async () => {
		mockFetch(() => new Response(null, { status: 503 }));

		const note = await usageNote([usage()], HAIKU_DIRECT, HAIKU);

		expect(note).toBe(
			"-# 入力 12,345トークン(うちキャッシュ 10,000)・出力 678トークン",
		);
	});

	it("段階ごとの単価がなければ、ふだんの単価で計算する", () => {
		const cost = costFromPricing(
			{
				base: {
					prompt: 0.000002,
					completion: 0.00001,
					cacheRead: null,
					cacheWrite: null,
					webSearch: null,
				},
				tiers: [],
			},
			usage(),
		);

		// キャッシュの単価がないモデルは、キャッシュの分も入力の単価で数える
		expect(cost).toBeCloseTo(12_345 * 0.000002 + 678 * 0.00001, 10);
	});
});
