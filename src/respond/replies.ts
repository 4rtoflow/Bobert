import type { ChatResult, LlmError } from "../llm/types";
import type { Provider } from "../store/users";
import type { ModelResolution, ResolvedModel } from "./model";

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
			return "AIの呼び出しでエラーが起きました。少し待ってから、もう一度試してください。";
	}
}

/** 登録したキー(OpenRouterとの連携)が無効になっているときの案内 */
export function invalidKeyMessage(provider: Provider): string {
	return provider === "anthropic"
		? "AnthropicのAPIキーが無効です。`/setup` から登録し直してください。"
		: "OpenRouterとの連携が無効になっています。`/setup` から連携し直してください。";
}

/** AIの返答に、必要な注記を添えて投稿する本文にする */
export function formatReply(
	result: ChatResult,
	imagesSkipped: boolean,
): string {
	if (result.stopReason === "refusal") {
		return "この内容には答えられません。";
	}
	const notes: string[] = [];
	if (result.stopReason === "max_tokens") {
		notes.push("-# 返答が長すぎるため、途中で切れました");
	}
	if (imagesSkipped) {
		notes.push("-# このモデルは画像を読めません");
	}
	const text = result.text.trim() || "(返答が空でした)";
	return [text, ...notes].join("\n");
}
