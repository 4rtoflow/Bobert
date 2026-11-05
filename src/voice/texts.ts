/**
 * 音声メッセージについて、Discordに表示する文言と、AIに渡す文(仕様: docs/spec/behavior.md「音声メッセージ」)。
 * 表示する文言は、2026-11-05に承認されたもの(issue #91)
 */

/** 聞き取った内容の行で、文字にした内容を出す長さの上限(文字数)。超える分は「…」で省く */
export const HEARD_NOTE_MAX_CHARS = 200;

/**
 * 聞き取った内容の行。普通のBobertは返答の末尾(利用量や寄付の行より上)に、エージェントは音声メッセージへの返信で示す。
 * 小さな文字の1行にするので、Discordの書式になる文字は、そのまま見えるようにする
 */
export function heardNote(text: string): string {
	const chars = [...text];
	const shown =
		chars.length > HEARD_NOTE_MAX_CHARS
			? `${chars.slice(0, HEARD_NOTE_MAX_CHARS).join("")}…`
			: text;
	return `-# 聞き取った内容: 「${escapeMarkdown(shown)}」`;
}

/** エージェントのチャンネルで、音声メッセージを文字にできなかった(その音声メッセージへの返信) */
export const AGENT_VOICE_FAILED =
	"-# 音声メッセージを文字にできなかったので、エージェントに送っていません。もう一度送るか、文字で送ってください。";

/** /help の使い方に足す1行(「メッセージに返信しながら…」の行の次) */
export const VOICE_HELP =
	"- Bobertの返答に音声メッセージで返信すると、音声を文字にしてから答えます。チャンネルの音声メッセージも文字にしておき、ほかのメッセージと同じように探して使います。";

/** エージェントに、音声メッセージを文字にしたものを送るときに、前に付ける文(Discordには表示しない) */
export const AGENT_VOICE_INTRO =
	"(音声メッセージを自動で文字にしたものです。聞き間違いがあるかもしれません)";

/** Discordの書式になる文字を、そのまま見えるようにする */
function escapeMarkdown(text: string): string {
	return text.replace(/[\\*_~`|]/g, "\\$&");
}
