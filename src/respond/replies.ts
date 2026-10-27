import type { ChatResult, LlmError } from "../llm/types";
import type { Provider } from "../store/users";
import type { ModelResolution, ResolvedModel } from "./model";
import { sourcesNote } from "./web-search";

/** キーを登録していない人などへの、登録方法の案内(仕様: docs/spec/architecture.md「決定事項」) */
export function setupGuidance(
	resolution: Extract<ModelResolution, { ok: false }>,
): string {
	switch (resolution.missing) {
		case "credentials":
			return "Bobertと話すには、AIのキーの登録が必要です。`/setup` から、AnthropicのAPIキーを登録するか、OpenRouterと連携してください。費用は、登録した本人のアカウントに請求されます。";
		case "anthropic":
			return `モデル「${resolution.label}」を使うには、AnthropicのAPIキーの登録が必要です。\`/setup\` から登録してください。`;
		case "openrouter":
			return `モデル「${resolution.label}」を使うには、OpenRouterとの連携が必要です。\`/setup\` から連携してください。`;
	}
}

/** AIに内容を断られたときの返答 */
export const REFUSAL_TEXT = "この内容には答えられません。";

/** AIの呼び出しで、原因の分からないエラーが起きたときの返答 */
export const LLM_ERROR_TEXT =
	"AIの呼び出しでエラーが起きました。少し待ってから、もう一度試してください。";

/** AIの呼び出しに失敗したときの、短い理由(仕様: docs/spec/behavior.md「エラー時の表示」) */
export function describeLlmError(
	error: LlmError,
	model: ResolvedModel,
): string {
	const anthropic = model.provider === "anthropic";
	switch (error.kind) {
		case "invalid_key":
			return invalidKeyMessage(model.provider);
		case "insufficient_credit":
			return anthropic
				? "Anthropicの残高が不足しています。Claude Consoleでクレジットを追加してください。"
				: "OpenRouterの残高が不足しています。OpenRouterでクレジットを追加してください。";
		case "forbidden":
			return "このキーではモデルを使えないか、提供元に内容を断られました。";
		case "model_not_found":
			return `モデル「${model.label}」が見つからないか、いまは使えません。`;
		case "no_provider":
			return `モデル「${model.label}」は、データを学習に使わない提供元では使えません。別のモデルを選んでください。`;
		case "rate_limited":
			return "利用の上限(レート制限)に達しました。少し待ってから、もう一度話しかけてください。";
		case "unavailable":
			return "AIのサーバーが混み合っているか、つながりません。少し待ってから、もう一度話しかけてください。";
		case "too_large":
			return "会話か添付ファイルが大きすぎて、AIに送れませんでした。";
		case "bad_request":
		case "unknown":
			return LLM_ERROR_TEXT;
	}
}

/** 登録したキー(OpenRouterとの連携)が無効になっているときの案内 */
export function invalidKeyMessage(provider: Provider): string {
	return provider === "anthropic"
		? "AnthropicのAPIキーが無効です。`/setup` から登録し直してください。"
		: "OpenRouterとの連携が無効になっています。`/setup` から連携し直してください。";
}

/** 返答に添える注記 */
export interface ReplyNotes {
	/** 話しかけたメッセージに画像があったのに、AIに渡さなかった */
	imagesSkipped: boolean;
	/** Web検索をONにしているのに、このモデルでは使えなかった */
	webSearchSkipped: boolean;
	/** 利用量の表示の行。表示しないならnull */
	usage: string | null;
	/**
	 * 要約を勧める案内を添えるなら、料金が上がる境目(入力のトークン数)。添えないならnull。
	 * 案内には「今すぐ要約」ボタンを付ける(投稿するときに付ける)
	 */
	compaction?: number | null;
}

/** AIの返答に、出典と必要な注記を添えて、投稿する本文にする */
export function formatReply(
	result: ChatResult,
	{ imagesSkipped, webSearchSkipped, usage, compaction = null }: ReplyNotes,
): string {
	if (result.stopReason === "refusal") {
		return [REFUSAL_TEXT, ...(usage === null ? [] : [usage])].join("\n");
	}
	const notes: string[] = [];
	if (result.stopReason === "max_tokens") {
		notes.push("-# 返答が長すぎるため、途中で切れました");
	}
	const sources = sourcesNote(result.sources);
	if (sources !== null) {
		notes.push(sources);
	}
	if (imagesSkipped) {
		notes.push("-# このモデルは画像を読めません");
	}
	if (webSearchSkipped) {
		notes.push("-# このモデルはWeb検索を使えません");
	}
	if (usage !== null) {
		notes.push(usage);
	}
	if (compaction !== null) {
		notes.push(compactionNote(compaction));
	}
	const text = result.text.trim() || "(返答が空でした)";
	return [text, ...notes].join("\n");
}

/**
 * 要約を勧める案内(仕様: docs/spec/architecture.md「長い会話の自動要約」の、単価が上がるモデルでの案内)。
 * 会話の履歴から外れるよう、小さな文字の行(「-# 」)にする
 */
export function compactionNote(threshold: number): string {
	return `-# 会話が長くなり、入力が${formatTenThousands(threshold)}トークンを超えました。このモデルは、ここから料金が上がります。「今すぐ要約」で古い部分を要約すると、次からの費用を抑えられます。`;
}

/** 万の単位で書く。例: 100000は「10万」、272000は「27.2万」 */
function formatTenThousands(count: number): string {
	return `${Number((count / 10_000).toFixed(1))}万`;
}
