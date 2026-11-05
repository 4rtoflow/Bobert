import type { StoredMessageInput } from "../queue/messages";
import { isVoiceAttachment, type VoiceText } from "../voice/voice";

/**
 * 音声メッセージを文字にした内容(仕様: docs/spec/architecture.md「音声メッセージ」)。
 * 音声メッセージは添付ファイルが1つだけなので、メッセージIDで見分ける。
 */

/** 1つの問い合わせに入れるメッセージIDの数の上限(D1は、1つの問い合わせの値を100個までにしている) */
const MAX_IDS_PER_QUERY = 50;

/** 文字にした内容 */
export interface VoiceTranscript {
	messageId: string;
	channelId: string;
	/** 文字にした内容。声が入っていなければ空 */
	text: string;
	/** 判定された言語(例: ja)。分からなければnull */
	language: string | null;
	/** 音声の長さ(秒) */
	durationSecs: number;
	/** 文字にしたモデル */
	model: string;
}

/**
 * 文字にした内容を保存する。同じメッセージの分があれば、置き換える。
 * メッセージを保存していれば(共有チャンネルの分)、文字にした内容でベクトルを入れ直すため、入れた記録を消す。
 * 消されたメッセージ(削除の記録があるもの)の分は保存しない
 */
export async function saveVoiceTranscript(
	db: D1Database,
	transcript: VoiceTranscript,
	now = Date.now(),
): Promise<void> {
	await db.batch([
		db
			.prepare(
				`INSERT INTO voice_transcripts (message_id, channel_id, text, language, duration_secs, model, created_at)
				SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
				WHERE NOT EXISTS (SELECT 1 FROM deleted_messages WHERE message_id = ?1)
				ON CONFLICT (message_id) DO UPDATE SET
					text = excluded.text,
					language = excluded.language,
					duration_secs = excluded.duration_secs,
					model = excluded.model,
					created_at = excluded.created_at`,
			)
			.bind(
				transcript.messageId,
				transcript.channelId,
				transcript.text,
				transcript.language,
				transcript.durationSecs,
				transcript.model,
				now,
			),
		db
			.prepare("UPDATE messages SET embedded_at = NULL WHERE message_id = ?")
			.bind(transcript.messageId),
	]);
}

/** 文字にした内容を、メッセージIDを指定して読む(メッセージIDごと)。ないものは入らない */
export async function loadVoiceTranscripts(
	db: D1Database,
	messageIds: readonly string[],
): Promise<Map<string, VoiceTranscript>> {
	const found = new Map<string, VoiceTranscript>();
	const unique = [...new Set(messageIds)];
	for (let i = 0; i < unique.length; i += MAX_IDS_PER_QUERY) {
		const ids = unique.slice(i, i + MAX_IDS_PER_QUERY);
		const { results } = await db
			.prepare(
				`SELECT message_id, channel_id, text, language, duration_secs, model
				FROM voice_transcripts WHERE message_id IN (${ids.map(() => "?").join(", ")})`,
			)
			.bind(...ids)
			.all<{
				message_id: string;
				channel_id: string;
				text: string;
				language: string | null;
				duration_secs: number;
				model: string;
			}>();
		for (const row of results) {
			found.set(row.message_id, {
				messageId: row.message_id,
				channelId: row.channel_id,
				text: row.text,
				language: row.language,
				durationSecs: row.duration_secs,
				model: row.model,
			});
		}
	}
	return found;
}

/**
 * メッセージのうち、音声メッセージを文字にした内容を保存してあるもの(メッセージIDごと)。
 * 文字にはしない(道具の結果や要約など、新しく文字にしない場面で使う)。音声メッセージのないメッセージは読まない
 */
export async function storedVoiceTexts(
	db: D1Database,
	messages: readonly Pick<StoredMessageInput, "messageId" | "attachments">[],
): Promise<Map<string, VoiceText>> {
	const ids = messages
		.filter((message) => message.attachments.some(isVoiceAttachment))
		.map((message) => message.messageId);
	if (ids.length === 0) {
		return new Map();
	}
	const stored = await loadVoiceTranscripts(db, ids);
	return new Map(
		[...stored].map(([messageId, transcript]): [string, VoiceText] => [
			messageId,
			{ kind: "text", text: transcript.text },
		]),
	);
}
