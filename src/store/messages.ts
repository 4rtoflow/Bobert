import type { StoredMessageInput, UserName } from "../queue/messages";

/** 削除したメッセージのIDを残しておく時間。保存のやり直しの間だけ要る */
const DELETED_RETENTION_MS = 24 * 60 * 60 * 1000;

/** 1つの問い合わせに入れるメッセージIDの数の上限(D1は、1つの問い合わせの値を100個までにしている) */
const MAX_IDS_PER_QUERY = 50;

/**
 * 応答を始める前に、このメッセージを処理中として記録する。
 * すでに記録があればfalseを返す。GatewayのResumeで同じイベントが届いても、2回返信しないため。
 */
export async function claimMessage(
	db: D1Database,
	messageId: string,
	now = Date.now(),
): Promise<boolean> {
	const result = await db
		.prepare(
			"INSERT OR IGNORE INTO handled_messages (message_id, handled_at) VALUES (?, ?)",
		)
		.bind(messageId, now)
		.run();
	return result.meta.changes === 1;
}

/** 応答に失敗してQueueでやり直すときは、記録を消しておく */
export async function releaseMessage(
	db: D1Database,
	messageId: string,
): Promise<void> {
	await db
		.prepare("DELETE FROM handled_messages WHERE message_id = ?")
		.bind(messageId)
		.run();
}

/** メッセージの版。編集されていれば編集時刻、なければ投稿時刻 */
export function messageVersion(
	message: Pick<StoredMessageInput, "createdAt" | "editedAt">,
): number {
	return message.editedAt ?? message.createdAt;
}

/**
 * メッセージを保存する(仕様: docs/spec/architecture.md「会話の文脈と過去の発言の保存」)。
 * - メッセージIDで上書きする。編集が作成より先に処理されても(やり直しで順番が入れ替わる)、古い版では上書きしない
 * - 削除済みのメッセージは保存しない
 * - 本文が変わったら、ベクトルを入れ直すため、embedded_atを消す
 * あわせて、サーバーで見えている名前を、人ごとに記録する。
 */
export async function saveMessages(
	db: D1Database,
	messages: readonly StoredMessageInput[],
): Promise<void> {
	const statements = messages.flatMap((message) => {
		const { guildId } = message;
		return [
			db
				.prepare(
					`INSERT INTO messages (
					message_id, guild_id, channel_id, author_id, author_name, author_is_bot,
					content, reply_to_id, mentions, attachments, created_at, edited_at
				)
				SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12
				WHERE NOT EXISTS (SELECT 1 FROM deleted_messages WHERE message_id = ?1)
				ON CONFLICT (message_id) DO UPDATE SET
					author_name = excluded.author_name,
					content = excluded.content,
					reply_to_id = excluded.reply_to_id,
					mentions = excluded.mentions,
					attachments = excluded.attachments,
					edited_at = excluded.edited_at,
					embedded_at = CASE
						WHEN messages.content = excluded.content THEN messages.embedded_at
						ELSE NULL
					END
				WHERE COALESCE(excluded.edited_at, excluded.created_at)
					>= COALESCE(messages.edited_at, messages.created_at)`,
				)
				.bind(
					message.messageId,
					message.guildId,
					message.channelId,
					message.authorId,
					message.authorName,
					message.authorIsBot ? 1 : 0,
					message.content,
					message.replyToId,
					JSON.stringify(message.mentions),
					JSON.stringify(message.attachments),
					message.createdAt,
					message.editedAt,
				),
			...(guildId === null
				? []
				: message.members.map((member) =>
						saveMemberName(db, guildId, member, message),
					)),
		];
	});
	if (statements.length > 0) {
		await db.batch(statements);
	}
}

/** サーバーで見えている名前を記録する。名前が変わっていて、より新しいメッセージで分かったときだけ書き換える */
function saveMemberName(
	db: D1Database,
	guildId: string,
	member: UserName,
	message: StoredMessageInput,
): D1PreparedStatement {
	return db
		.prepare(
			`INSERT INTO guild_members (guild_id, user_id, name, updated_at) VALUES (?, ?, ?, ?)
			ON CONFLICT (guild_id, user_id) DO UPDATE SET
				name = excluded.name,
				updated_at = excluded.updated_at
			WHERE excluded.updated_at > guild_members.updated_at
				AND excluded.name != guild_members.name`,
		)
		.bind(guildId, member.id, member.name, messageVersion(message));
}

/** ベクトルを入れるメッセージ */
export interface MessageToEmbed {
	messageId: string;
	channelId: string;
	authorId: string;
	content: string;
	mentions: UserName[];
	createdAt: number;
	editedAt: number | null;
}

/** 指定したメッセージのうち、保存されていて、まだベクトルを入れていないもの */
export async function findMessagesToEmbed(
	db: D1Database,
	messageIds: readonly string[],
): Promise<MessageToEmbed[]> {
	const found: MessageToEmbed[] = [];
	for (const ids of chunks(messageIds, MAX_IDS_PER_QUERY)) {
		const { results } = await db
			.prepare(
				`SELECT message_id, channel_id, author_id, content, mentions, created_at, edited_at
				FROM messages
				WHERE embedded_at IS NULL AND message_id IN (${ids.map(() => "?").join(", ")})`,
			)
			.bind(...ids)
			.all<{
				message_id: string;
				channel_id: string;
				author_id: string;
				content: string;
				mentions: string | null;
				created_at: number;
				edited_at: number | null;
			}>();
		for (const row of results) {
			found.push({
				messageId: row.message_id,
				channelId: row.channel_id,
				authorId: row.author_id,
				content: row.content,
				mentions: row.mentions ? (JSON.parse(row.mentions) as UserName[]) : [],
				createdAt: row.created_at,
				editedAt: row.edited_at,
			});
		}
	}
	return found;
}

/** ベクトルを入れたことを記録する。その間に編集されていたら(版が違えば)、記録しない */
export async function markEmbedded(
	db: D1Database,
	messages: readonly MessageToEmbed[],
	now = Date.now(),
): Promise<void> {
	if (messages.length === 0) {
		return;
	}
	await db.batch(
		messages.map((message) =>
			db
				.prepare(
					`UPDATE messages SET embedded_at = ?
					WHERE message_id = ? AND COALESCE(edited_at, created_at) = ?`,
				)
				.bind(now, message.messageId, messageVersion(message)),
		),
	);
}

/**
 * 削除されたメッセージを、保存分から消す。削除が保存より先に処理されても保存し直さないよう、IDを1日だけ残す。
 * 古くなったIDも、ここで消す。
 */
export async function deleteStoredMessages(
	db: D1Database,
	messageIds: readonly string[],
	now = Date.now(),
): Promise<void> {
	await db.batch([
		...messageIds.flatMap((messageId) => [
			db
				.prepare(
					"INSERT OR IGNORE INTO deleted_messages (message_id, deleted_at) VALUES (?, ?)",
				)
				.bind(messageId, now),
			db.prepare("DELETE FROM messages WHERE message_id = ?").bind(messageId),
		]),
		db
			.prepare("DELETE FROM deleted_messages WHERE deleted_at < ?")
			.bind(now - DELETED_RETENTION_MS),
	]);
}

function chunks<T>(items: readonly T[], size: number): T[][] {
	const result: T[][] = [];
	for (let i = 0; i < items.length; i += size) {
		result.push(items.slice(i, i + size));
	}
	return result;
}
