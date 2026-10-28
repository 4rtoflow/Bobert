/**
 * AIの呼び出しで使う、プロバイダに依存しない形。
 * AnthropicとOpenRouterの呼び出しは、それぞれこの形から自分の形式に変換する。
 */

/** AIに渡す会話の1件 */
export interface ChatMessage {
	role: "user" | "assistant";
	parts: ChatPart[];
}

export type ChatPart =
	| { type: "text"; text: string }
	| { type: "image"; url: string };

export interface ChatRequest {
	/** プロバイダでのモデルID */
	model: string;
	/**
	 * 共通の指示と本人の指示(この順に並べる)。
	 * プロンプトキャッシュが効くよう、日時などの毎回変わる内容は入れない
	 */
	system: string[];
	messages: ChatMessage[];
	/** 思考の深さ。nullならモデルの既定 */
	effort: string | null;
	/** Web検索を使うか。使えるモデルのときだけtrueにする */
	webSearch: boolean;
	/** AIに渡す、Bobertが処理する道具。道具を使えないモデルには渡さない */
	tools: ChatTool[];
	maxTokens: number;
}

/**
 * AIに渡す、Bobertが処理する道具(仕様: docs/spec/architecture.md「過去メッセージを参照する道具」)。
 * AIが呼ぶとrunで結果の文を作り、AIはそれを踏まえて続ける。
 */
export interface ChatTool {
	/** 道具の名前(英数字、_、-) */
	name: string;
	/** AIに見せる、道具の説明 */
	description: string;
	/** 入力の形(JSON Schema) */
	inputSchema: {
		type: "object";
		properties: Record<string, unknown>;
		required?: string[];
	};
	/** AIが呼んだときに、結果の文を作る。入力は、AIが送ったものなので、確かめてから使う */
	run: (input: Record<string, unknown>) => Promise<string>;
	/**
	 * falseなら、道具の呼び出しの上限(MAX_TOOL_CALLS)に数えない。その道具は、自分で回数を数える(スキルを読む道具)。
	 * 省けば数える
	 */
	countsTowardLimit?: boolean;
}

export interface ChatResult {
	text: string;
	/** 返答が終わった理由。end以外は、返答に注記する */
	stopReason: "end" | "max_tokens" | "refusal";
	/** 使ったトークン数と費用の合計 */
	usage: TokenUsage;
	/**
	 * APIを1回呼ぶごとの使用量(呼んだ順)。道具やWeb検索の続きで、何回かに分けて呼ぶことがある。
	 * 入力が多いときの単価は1回ごとの入力で決まるので、費用の計算に使う
	 */
	requestUsages: TokenUsage[];
	/** 返答が引用したWebページ(出典)。引用した順 */
	sources: Source[];
	/** Bobertの道具を呼んだ回数。上限に数えない道具(スキルを読む道具)の分は含まない */
	toolCalls: number;
}

/** 返答が引用したWebページ */
export interface Source {
	url: string;
	title: string | null;
}

/** 使ったトークン数と費用 */
export interface TokenUsage {
	/** 入力のトークン数。キャッシュから読んだ分と、キャッシュに書いた分を含む */
	inputTokens: number;
	/** 出力のトークン数。考えた分(thinking)を含む */
	outputTokens: number;
	/** 入力のうち、キャッシュから読んだ分 */
	cacheReadTokens: number;
	/** 入力のうち、キャッシュに書いた分 */
	cacheWriteTokens: number;
	/** Web検索の回数 */
	webSearchRequests: number;
	/** 費用(USD)。プロバイダが応答で返したときだけ(OpenRouter)。分からなければnull */
	costUsd: number | null;
}

/** 何回かに分けて呼んだときの合計。費用は分かる分だけを足し、どれも分からなければnull */
export function sumUsage(usages: readonly TokenUsage[]): TokenUsage {
	const costs = usages.flatMap((usage) =>
		usage.costUsd === null ? [] : [usage.costUsd],
	);
	const total = (pick: (usage: TokenUsage) => number) =>
		usages.reduce((sum, usage) => sum + pick(usage), 0);
	return {
		inputTokens: total((usage) => usage.inputTokens),
		outputTokens: total((usage) => usage.outputTokens),
		cacheReadTokens: total((usage) => usage.cacheReadTokens),
		cacheWriteTokens: total((usage) => usage.cacheWriteTokens),
		webSearchRequests: total((usage) => usage.webSearchRequests),
		costUsd:
			costs.length === 0 ? null : costs.reduce((sum, cost) => sum + cost, 0),
	};
}

/** 失敗の種類。ユーザーに見せる理由はこれで決める */
export type LlmErrorKind =
	| "invalid_key"
	| "insufficient_credit"
	| "forbidden"
	| "model_not_found"
	| "no_provider"
	| "rate_limited"
	| "unavailable"
	| "too_large"
	| "bad_request"
	| "unknown";

/** AIの呼び出しの失敗 */
export class LlmError extends Error {
	constructor(
		readonly kind: LlmErrorKind,
		/** HTTPのステータス。通信の失敗などで分からなければnull */
		readonly status: number | null,
		message: string,
		/** 原因の調査のための説明(describeErrorで作る)。ステータスが分からない失敗のときに付ける */
		readonly detail: string | null = null,
	) {
		super(message);
		this.name = "LlmError";
	}
}

/** キーの確認の結果。確かめられなかったときは、原因の説明を付ける */
export type KeyCheckResult =
	| { status: "valid" }
	| { status: "invalid" }
	/** ワークスペースに属さないキーなのに、ワークスペースIDがない */
	| { status: "needs_workspace" }
	/** 入力されたワークスペースIDが正しくないか、このキーでは使えない */
	| { status: "workspace_not_found" }
	| { status: "unavailable"; detail: string };

/** 「その他」で入力されたモデルの確認の結果。確かめられなかったときは、原因の説明を付ける */
export type ModelCheckResult =
	/**
	 * effortsは、選べる思考の深さ(浅い順)。空なら選べない。webSearchは、Web検索を使えるか。
	 * maxInputTokensは、入力の上限(分からなければnull)
	 */
	| {
			status: "found";
			efforts: string[];
			webSearch: boolean;
			maxInputTokens: number | null;
	  }
	| { status: "not_found" }
	/** 登録したキーが無効になっている */
	| { status: "invalid_key" }
	| { status: "unavailable"; detail: string };

/**
 * 例外を、ログに残せる短い説明にする(種類、ステータス、メッセージ、原因)。
 * キーのような文字列は伏せる。会話の本文を含みうるリクエストの失敗には使わない。
 */
export function describeError(error: unknown): string {
	if (!(error instanceof Error)) {
		return "non-Error value thrown";
	}
	const status =
		"status" in error && typeof error.status === "number"
			? ` ${error.status}`
			: "";
	const cause =
		error.cause instanceof Error
			? ` (cause: ${error.cause.name}: ${error.cause.message})`
			: "";
	return `${error.name}${status}: ${error.message}${cause}`
		.replace(/sk-[A-Za-z0-9_-]{6,}/g, "sk-[redacted]")
		.slice(0, 300);
}
