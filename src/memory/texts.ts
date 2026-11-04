/**
 * 記憶の、表示する文言(仕様: docs/spec/behavior.md「記憶」。2026-11-01に承認)
 */

/** /memory の名前と説明 */
export const MEMORY_COMMAND_NAME = "memory";
export const MEMORY_COMMAND_DESCRIPTION =
	"AIが覚えている、あなたのこと(このサーバーでの記憶)の確認と設定";

/** OFFのときの画面 */
export const MEMORY_OFF_TITLE = "**記憶**: OFF";
export const MEMORY_OFF_EXPLANATION =
	"ONにすると、このサーバーでのあなたの発言から、AIが「あなたについて覚えておくこと」をまとめて、あなたへの返答に使います。会話で「覚えて」「忘れて」と頼むこともできます。";
export const MEMORY_COST_NOTE =
	"-# まとめる費用は、あなたのキーにかかります(Claude Haiku 5.5。よく話す人でも月5セントほど)。";
export const MEMORY_DONATION_NOTE =
	"-# 寄付されたクレジットで答えるときは、記憶も、寄付した人のアカウントに送られます。";
/** 一覧を残したままOFFにしているとき、最後に足す行 */
export const MEMORY_KEPT_NOTE =
	"-# 一覧は残しています。ONに戻すと、また使います。";

/** ONのときの画面 */
export const MEMORY_ON_TITLE = "**記憶**: ON";
export const MEMORY_EMPTY = "まだ覚えていることはありません。";
export function memoryUpdatedLine(time: string): string {
	return `-# 最後の更新: ${time}`;
}
export function memoryFailureLine(reason: string): string {
	return `-# 前回の更新に失敗しました。${reason}`;
}

/** ボタン */
export const MEMORY_ON_LABEL = "ONにする";
export const MEMORY_EDIT_LABEL = "直す";
export const MEMORY_CLEAR_LABEL = "全部消す";
export const MEMORY_OFF_LABEL = "OFFにする";
export const MEMORY_CLEAR_CONFIRM_LABEL = "消す";

/** キーがない人が「ONにする」を押したとき(本人にだけ見える) */
export const MEMORY_KEY_REQUIRED =
	"記憶を使うには、AIのキーの登録が必要です。`/setup` から登録してください。";

/** 「ONにする」を押した直後(まとめ終わったら、ONの画面に書き換える) */
export const MEMORY_BUILDING =
	"記憶をまとめています。終わったら、このメッセージに一覧を書きます。";

/** 「直す」の入力画面 */
export const MEMORY_EDIT_TITLE = "記憶を直す";
export const MEMORY_EDIT_LABEL_TEXT = "覚えておくこと";
export const MEMORY_EDIT_DESCRIPTION =
	"1行に1つ。1つ100文字まで、全体で1500文字まで";

/** 「直す」で長すぎたとき(書いた内容をコードブロックで付ける) */
export function memoryItemTooLong(line: number, length: number): string {
	return `1つの項目は100文字までにしてください(${line}行目が${length.toLocaleString("ja-JP")}文字です)。書いた内容を下に付けます。`;
}
export function memoryTotalTooLong(length: number): string {
	return `全体で1500文字までにしてください(いまは${length.toLocaleString("ja-JP")}文字です)。書いた内容を下に付けます。`;
}

/** 「全部消す」 */
export const MEMORY_CLEAR_CONFIRM =
	"このサーバーでの記憶を、すべて消します。よろしいですか?";
export const MEMORY_CLEARED = "記憶を消しました。";

/** 会話で記憶を直したときに、返答の末尾に足す行 */
export const MEMORY_UPDATED_NOTE =
	"-# 記憶を更新しました(`/memory` で確認できます)";

/** /settings の行 */
export function memorySettingLine(enabled: boolean): string {
	return `- 記憶: ${enabled ? "ON" : "OFF"}`;
}

/** /help の使い方 */
export const MEMORY_HELP =
	"- `/memory` で記憶をONにすると、このサーバーでのあなたの発言から、AIがあなたのことを覚えて、返答に使います。会話で「覚えて」「忘れて」と頼むこともできます。";

/** /delete の確認に足す文(記憶がある人だけ) */
export const DELETE_MEMORY_NOTE = "記憶も、すべてのサーバーの分を消します。";
