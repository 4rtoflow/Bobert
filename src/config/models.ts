/**
 * /model のセレクトメニューに並べるモデルの候補。
 * 仕様: docs/spec/llm-cost.md「モデルの候補」(価格は2026-10-23時点)。
 * モデルの入れ替わりが速いので、定期的に見直す。
 */
export interface ModelCandidate {
	/** Bobertの中での識別子 */
	key: string;
	/** セレクトメニューに出す名前 */
	label: string;
	group: "claude" | "upper" | "budget";
	/** Anthropicのキーで直接呼ぶときのID(Claudeだけ) */
	anthropicId?: string;
	/** OpenRouterで呼ぶときのID */
	openRouterId: string;
	/** 100万トークンあたりの価格(USD) */
	price: { input: number; output: number };
	supportsImages: boolean;
	/** 入力がこのトークン数を超えると単価が上がる(要約を勧める案内の境目) */
	priceIncreaseAboveTokens?: number;
	note?: string;
}

export const MODEL_CANDIDATES: readonly ModelCandidate[] = [
	{
		key: "claude-haiku-5.5",
		label: "Claude Haiku 5.5",
		group: "claude",
		anthropicId: "claude-haiku-5-5",
		openRouterId: "anthropic/claude-haiku-5.5",
		price: { input: 0.1, output: 0.5 },
		supportsImages: true,
		priceIncreaseAboveTokens: 100_000,
		note: "入力が10万トークンを超えると 0.50 / 2.50",
	},
	{
		key: "claude-sonnet-5.5",
		label: "Claude Sonnet 5.5",
		group: "claude",
		anthropicId: "claude-sonnet-5-5",
		openRouterId: "anthropic/claude-sonnet-5.5",
		price: { input: 2, output: 10 },
		supportsImages: true,
	},
	{
		key: "claude-opus-5.5",
		label: "Claude Opus 5.5",
		group: "claude",
		anthropicId: "claude-opus-5-5",
		openRouterId: "anthropic/claude-opus-5.5",
		price: { input: 4, output: 20 },
		supportsImages: true,
	},
	{
		key: "claude-fable-5.1",
		label: "Claude Fable 5.1",
		group: "claude",
		anthropicId: "claude-fable-5-1",
		openRouterId: "anthropic/claude-fable-5.1",
		price: { input: 10, output: 50 },
		supportsImages: true,
	},
	{
		key: "gpt-6-astra",
		label: "GPT-6 Astra",
		group: "upper",
		openRouterId: "openai/gpt-6-astra",
		price: { input: 10, output: 50 },
		supportsImages: true,
		priceIncreaseAboveTokens: 272_000,
	},
	{
		key: "gemini-4-argon",
		label: "Gemini 4 Argon",
		group: "upper",
		openRouterId: "google/gemini-4-argon",
		price: { input: 2, output: 10 },
		supportsImages: true,
		note: "2026-12-01に約2倍へ値上げ予定",
	},
	{
		key: "gpt-6.1-sol",
		label: "GPT-6.1 Sol",
		group: "upper",
		openRouterId: "openai/gpt-6.1-sol",
		price: { input: 2, output: 10 },
		supportsImages: true,
		priceIncreaseAboveTokens: 272_000,
	},
	{
		key: "grok-4.7",
		label: "Grok 4.7",
		group: "upper",
		openRouterId: "x-ai/grok-4.7",
		price: { input: 2, output: 6 },
		supportsImages: true,
		priceIncreaseAboveTokens: 200_000,
	},
	{
		key: "qwen3.8-max",
		label: "Qwen3.8 Max",
		group: "upper",
		openRouterId: "qwen/qwen3.8-max-0902",
		price: { input: 2, output: 6 },
		supportsImages: true,
	},
	{
		key: "kimi-k3",
		label: "Kimi K3",
		group: "upper",
		openRouterId: "moonshotai/kimi-k3",
		price: { input: 3, output: 15 },
		supportsImages: true,
	},
	{
		key: "muse-spark-1.3",
		label: "Meta Muse Spark 1.3",
		group: "upper",
		openRouterId: "meta/muse-spark-1.3",
		price: { input: 1.25, output: 4.25 },
		supportsImages: true,
	},
	{
		key: "mistral-large-4",
		label: "Mistral Large 4",
		group: "upper",
		openRouterId: "mistralai/mistral-large-4-0",
		price: { input: 1.36, output: 4.18 },
		supportsImages: true,
	},
	{
		key: "glm-5.3",
		label: "GLM 5.3",
		group: "upper",
		openRouterId: "z-ai/glm-5.3",
		price: { input: 1.4, output: 4.4 },
		supportsImages: false,
		note: "画像を読めない",
	},
	{
		key: "gemini-3.8-flash",
		label: "Gemini 3.8 Flash",
		group: "budget",
		openRouterId: "google/gemini-3.8-flash",
		price: { input: 0.75, output: 3.75 },
		supportsImages: true,
		note: "2027-01-01に約2倍へ値上げ予定",
	},
	{
		key: "mimo-v2.6-pro",
		label: "MiMo-V2.6-Pro",
		group: "budget",
		openRouterId: "xiaomi/mimo-v2.6-pro",
		price: { input: 0.435, output: 0.87 },
		supportsImages: true,
	},
	{
		key: "gemini-3.5-flash-lite",
		label: "Gemini 3.5 Flash-Lite",
		group: "budget",
		openRouterId: "google/gemini-3.5-flash-lite",
		price: { input: 0.3, output: 2.5 },
		supportsImages: true,
	},
	{
		key: "deepseek-v4.1-flash",
		label: "DeepSeek V4.1 Flash",
		group: "budget",
		openRouterId: "deepseek/deepseek-v4.1-flash-1017",
		price: { input: 0.3, output: 1.2 },
		supportsImages: true,
		note: "DeepSeek自身の窓口は学習に使うため除外され、他社の提供分だけを使う",
	},
	{
		key: "minimax-m3.1-flash",
		label: "MiniMax M3.1 Flash",
		group: "budget",
		openRouterId: "minimax/minimax-m3.1-flash",
		price: { input: 0.15, output: 0.6 },
		supportsImages: true,
	},
	{
		key: "glm-5.3-flash",
		label: "GLM 5.3 Flash",
		group: "budget",
		openRouterId: "z-ai/glm-5.3-flash",
		price: { input: 0.15, output: 0.5 },
		supportsImages: true,
	},
	{
		key: "gpt-6-luna",
		label: "GPT-6 Luna",
		group: "budget",
		openRouterId: "openai/gpt-6-luna",
		price: { input: 0.1, output: 0.5 },
		supportsImages: true,
	},
];

/** 既定のモデル */
export const DEFAULT_MODEL_KEY = "claude-haiku-5.5";

/** 1回の返答で、Web検索を使える回数の上限(費用を抑えるため) */
export const MAX_WEB_SEARCHES = 5;

/** 思考の深さ(effort)を設定していない人に使う段階。モデルが選べなければ、いちばん近い段階を使う */
export const DEFAULT_EFFORT = "low";

/** 「その他」で入力したモデルを使うときの、users.model_key の値 */
export const CUSTOM_MODEL_KEY = "custom";

/** 候補をキーで探す */
export function findModelCandidate(
	key: string | null,
): ModelCandidate | undefined {
	return MODEL_CANDIDATES.find((candidate) => candidate.key === key);
}
