/**
 * 「Jevに聞く」の表示の文(仕様: docs/spec/behavior.md「スラッシュコマンド」の右クリックメニュー)。
 * 文言は、承認をもらったもの(AGENTS.md)。
 */

/** 右クリックメニュー(アプリ)の、Jevに聞く項目の名前 */
export const JEV_COMMAND_NAME = "Jevに聞く";

/** /help に書く行 */
export const JEV_HELP_LINE = `- メッセージの右クリックメニュー(アプリ)の「${JEV_COMMAND_NAME}」: AIがメッセージと前後の会話を読んで質問を作り、Jevが確率で答えます。TypeSafeのAPIキーの登録が必要です`;

/** TypeSafeのキーを登録していない人への案内(本人にだけ見せる) */
export const TYPESAFE_KEY_REQUIRED = `「${JEV_COMMAND_NAME}」を使うには、TypeSafeのAPIキーの登録が必要です。\`/setup\` から登録してください。費用は、登録した本人のアカウントに請求されます。`;

/** 登録したTypeSafeのキーが無効なときの返答(結果の代わりに投稿する) */
export const TYPESAFE_KEY_INVALID =
	"TypeSafeのAPIキーが無効です。`/setup` から登録し直してください。";

/** AIが、Jevに聞く質問を作らずに終えたときの返答 */
export const JEV_NO_QUESTION =
	"Jevに聞く質問を作れませんでした。もう一度試してください。";

/** 道具を使えないモデル(「その他」で入力したモデル)のときの返答 */
export const JEV_NO_TOOLS = `このモデルは道具を使えないため、「${JEV_COMMAND_NAME}」を使えません。\`/model\` で別のモデルを選んでください。`;

/** Jevの呼び出しで、原因の分からないエラーが起きたときの返答 */
export const JEV_ERROR =
	"Jevの呼び出しでエラーが起きました。少し待ってから、もう一度試してください。";

/** 結果の、質問ごとの見出し */
export function jevHeading(question: string): string {
	return `**Jevの回答**: ${question}`;
}

/** はい/いいえの質問の結果。確率の高い方を太字にする(同じなら、どちらも太字にしない) */
export function noulLine(yesPercent: number): string {
	const noPercent = 100 - yesPercent;
	const yes = `はい ${yesPercent}%`;
	const no = `いいえ ${noPercent}%`;
	if (yesPercent === noPercent) {
		return `${yes}・${no}`;
	}
	return yesPercent > noPercent ? `**${yes}**・${no}` : `${yes}・**${no}**`;
}

/** 段階の質問の結果の、スコアの行。scoreは確率で重み付けした位置、maxはいちばん上の段階の番号 */
export function scoreLine(score: string, max: number): string {
	return `スコア ${score}(0〜${max})`;
}
