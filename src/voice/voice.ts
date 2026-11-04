import type { AttachmentInfo } from "../queue/messages";

/**
 * 音声メッセージの文字起こし(仕様: docs/spec/architecture.md「音声メッセージ」)。
 * Discordの音声メッセージ(OGG/Opus)を、Workers AIのWhisperで文字にする。
 */

/**
 * 文字にするのに使う、Workers AIのモデル。日本語の聞き取りが、ほかのモデル(古いWhisper、Deepgram Nova-3)より正確だった。
 * OGG/Opusのまま(base64で)渡せる
 */
export const TRANSCRIPTION_MODEL = "@cf/openai/whisper-large-v3-turbo";

/** モデルに渡すヒント。Bobertの名前を正しく書けるようにする(日本語の音声でも、英語の音声でも効いた) */
const INITIAL_PROMPT = "Bobert(ボバート)";

/** 1つの音声メッセージの長さの上限(秒)。Discordの音声メッセージの上限(20分) */
export const MAX_VOICE_SECS = 20 * 60;

/** 1回の返答で、新しく文字にする音声の長さの合計の上限(秒)。返答の処理の上限(15分)に収めるため(20分の音声で約4分かかる) */
export const VOICE_BUDGET_SECS = 20 * 60;

/** 音声のファイルの大きさの上限。20分の音声メッセージで約5MB。Workersのメモリーに読み込むので、余裕を持たせた上限にする */
export const MAX_VOICE_BYTES = 25 * 1024 * 1024;

/** Discordの音声メッセージの印(メッセージのflagsのIS_VOICE_MESSAGE) */
export const VOICE_MESSAGE_FLAG = 1 << 13;

/** Discordの音声メッセージの音声のビットレート(32kbps)を、1秒あたりのバイト数にしたもの。長さが分からないときの見積もりに使う */
const VOICE_BYTES_PER_SEC = 32_000 / 8;

/** 音声メッセージのメッセージか(flagsに印があるか) */
export function isVoiceMessageFlags(flags: number | undefined): boolean {
	return ((flags ?? 0) & VOICE_MESSAGE_FLAG) !== 0;
}

/**
 * 音声メッセージの添付ファイルの長さ(秒)。Discordが長さを付けていなければ、大きさから見積もる。
 * 音声メッセージのメッセージの添付ファイルにだけ付ける(仕様: AttachmentInfoのvoiceDurationSecs)
 */
export function voiceDurationOf(attachment: {
	duration_secs?: number;
	size: number;
}): number {
	return attachment.duration_secs ?? attachment.size / VOICE_BYTES_PER_SEC;
}

/**
 * 音声メッセージの添付ファイルか。
 * この仕組みを入れる前に保存したものには印がないので、Discordが付ける名前(voice-message.ogg)と形式で見分ける
 */
export function isVoiceAttachment(attachment: AttachmentInfo): boolean {
	if (attachment.voiceDurationSecs !== undefined) {
		return true;
	}
	const type =
		attachment.contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
	return attachment.filename === "voice-message.ogg" && type === "audio/ogg";
}

/** 音声メッセージの長さ(秒)。分からなければ(印のない、前に保存したもの)、大きさから見積もる */
export function voiceSeconds(attachment: AttachmentInfo): number {
	return attachment.voiceDurationSecs ?? attachment.size / VOICE_BYTES_PER_SEC;
}

/**
 * AIに見せる、音声メッセージの呼び方。長さが分かれば添える(例: 「音声メッセージ(0:12)」)。
 * 前に保存したもの(長さが分からない)は、「音声メッセージ」だけ
 */
export function voiceLabel(attachment: AttachmentInfo): string {
	const secs = attachment.voiceDurationSecs;
	return secs === undefined
		? "音声メッセージ"
		: `音声メッセージ(${formatVoiceDuration(secs)})`;
}

/** 音声の長さの書き方。分と秒(例: 0:12、12:05)。1秒に満たない端数は切り上げる */
export function formatVoiceDuration(secs: number): string {
	const total = Math.max(0, Math.ceil(secs));
	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

/**
 * 音声メッセージを文字にした結果。AIに見せるときに、メッセージIDごとに使う
 * (仕様: docs/spec/architecture.md「音声メッセージ」)
 */
export type VoiceText =
	/** 文字にできた。空なら、声が入っていなかった */
	| { kind: "text"; text: string }
	/** 文字にできなかった(メッセージが消えた、ファイルが読めない、Workers AIの失敗など) */
	| { kind: "failed" }
	/** 1回の返答で新しく文字にする長さの上限を超えるので、この返答では文字にしていない */
	| { kind: "over_budget" };

/** Workers AIで文字にした結果 */
export interface Transcription {
	/** 文字にした内容。声が入っていなければ空 */
	text: string;
	/** 判定された言語(例: ja)。分からなければnull */
	language: string | null;
}

/**
 * 音声をWorkers AIで文字にする。言語は自動で判定させる。
 * 声のない部分は飛ばす(vad_filter)。飛ばさないと、無音や雑音から、ありもしない文(「www.youtube.com」など)ができることがあるため
 */
export async function transcribeAudio(
	ai: Ai,
	audio: Uint8Array,
): Promise<Transcription> {
	const output = await ai.run(TRANSCRIPTION_MODEL, {
		audio: toBase64(audio),
		initial_prompt: INITIAL_PROMPT,
		vad_filter: true,
	});
	return {
		text: normalizeTranscript(output.text ?? ""),
		language: output.transcription_info?.language ?? null,
	};
}

/** 文字にした内容の、改行と続く空白を、1つの空白にする(区切りごとに空白や改行が入るため) */
export function normalizeTranscript(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** バイト列をbase64にする */
function toBase64(bytes: Uint8Array): string {
	let binary = "";
	// 一度に文字にする数を区切る(引数が多すぎると、関数を呼べないため)
	for (let i = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	return btoa(binary);
}
