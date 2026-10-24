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
	maxTokens: number;
}

export interface ChatResult {
	text: string;
	/** 返答が終わった理由。end以外は、返答に注記する */
	stopReason: "end" | "max_tokens" | "refusal";
	usage: TokenUsage;
}

export interface TokenUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
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

/** モデルで選べる思考の深さ(effort) */
export interface EffortSupport {
	/** 選べる段階(浅い順)。空なら、思考の深さを選べないモデル */
	levels: string[];
	/** モデルの既定の段階。分からなければnull */
	defaultLevel: string | null;
}

/** 「その他」で入力されたモデルの確認の結果。確かめられなかったときは、原因の説明を付ける */
export type ModelCheckResult =
	| { status: "found"; efforts: EffortSupport }
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
