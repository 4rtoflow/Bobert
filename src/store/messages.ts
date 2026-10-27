import type {
	EmbedInfo,
	StoredMessageInput,
	UserName,
} from "../queue/messages";

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
 * - 本文かEmbedが変わったら、ベクトルを入れ直すため、embedded_atを消す。
 *   リンクのプレビューは、投稿の後に編集の通知で届くので、本文が同じでもEmbedは変わる
 * - 発言者の名前は、サーバーでの情報が付いているとき(Gatewayで届いたとき)だけ書き換える。
 *   Discordから読み直したメッセージには、ニックネームが含まれないため
 * あわせて、サーバーで見えている名前を、人ごとに記録する。
 */
export async function saveMessages(
	db: D1Database,
	messages: readonly StoredMessageInput[],
): Promise<void> {
	const statements = messages.flatMap((message) => {
		const { guildId } = message;
		const nameFromMember = message.members.some(
			(member) => member.id === message.authorId,
		);
		return [
			db
				.prepare(
					`INSERT INTO messages (
					message_id, guild_id, channel_id, author_id, author_name, author_is_bot,
					content, reply_to_id, mentions, attachments, created_at, edited_at,
					embeds, command
				)
				SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?14, ?15
				WHERE NOT EXISTS (SELECT 1 FROM deleted_messages WHERE message_id = ?1)
				ON CONFLICT (message_id) DO UPDATE SET
					author_name = CASE
						WHEN ?13 THEN excluded.author_name
						ELSE messages.author_name
					END,
					content = excluded.content,
					reply_to_id = excluded.reply_to_id,
					mentions = excluded.mentions,
					attachments = excluded.attachments,
					embeds = excluded.embeds,
					command = excluded.command,
					edited_at = excluded.edited_at,
					embedded_at = CASE
						WHEN messages.content = excluded.content
							AND COALESCE(messages.embeds, '[]') = excluded.embeds
						THEN messages.embedded_at
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
					nameFromMember ? 1 : 0,
					JSON.stringify(message.embeds),
					message.command === null ? null : JSON.stringify(message.command),
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

/** 保存したメッセージの行 */
interface MessageRow {
	message_id: string;
	guild_id: string | null;
	channel_id: string;
	author_id: string;
	author_name: string;
	author_is_bot: number;
	content: string;
	reply_to_id: string | null;
	mentions: string | null;
	attachments: string | null;
	embeds: string | null;
	command: string | null;
	created_at: number;
	edited_at: number | null;
}

/**
 * 保存したメッセージを、指定したものから返信先へたどって読む。指定したものから古い方への順で返す。
 * 保存していないメッセージに行き当たったら、そこまでを返す。
 */
export async function loadStoredChain(
	db: D1Database,
	messageId: string,
	limit: number,
): Promise<StoredMessageInput[]> {
	if (limit <= 0) {
		return [];
	}
	const { results } = await db
		.prepare(
			`WITH RECURSIVE chain (message_id, depth) AS (
				SELECT ?1, 0
				UNION ALL
				SELECT messages.reply_to_id, chain.depth + 1
				FROM chain JOIN messages ON messages.message_id = chain.message_id
				WHERE messages.reply_to_id IS NOT NULL AND chain.depth + 1 < ?2
			)
			SELECT messages.*
			FROM chain JOIN messages ON messages.message_id = chain.message_id
			ORDER BY chain.depth`,
		)
		.bind(messageId, limit)
		.all<MessageRow>();
	return results.map(fromRow);
}

function fromRow(row: MessageRow): StoredMessageInput {
	return {
		messageId: row.message_id,
		guildId: row.guild_id,
		channelId: row.channel_id,
		authorId: row.author_id,
		authorName: row.author_name,
		authorIsBot: row.author_is_bot === 1,
		content: row.content,
		replyToId: row.reply_to_id,
		mentions: row.mentions ? JSON.parse(row.mentions) : [],
		attachments: row.attachments ? JSON.parse(row.attachments) : [],
		embeds: row.embeds ? JSON.parse(row.embeds) : [],
		command: row.command ? JSON.parse(row.command) : null,
		// サーバーで見えている名前は、guild_membersから読む
		members: [],
		createdAt: row.created_at,
		editedAt: row.edited_at,
	};
}

/** チャンネルの履歴を読む範囲。afterより後、beforeより前(どちらもUNIX時間のミリ秒。nullなら制限しない) */
export interface TimelineRange {
	after: number | null;
	before: number | null;
	/** 新しい方からlimit件を読む。違えば、古い方からlimit件を読む */
	newestFirst: boolean;
	limit: number;
}

/** 保存したチャンネルのメッセージを、範囲を指定して読む。返すのは、どちらの読み方でも古い順 */
export async function loadChannelMessages(
	db: D1Database,
	channelId: string,
	range: TimelineRange,
): Promise<StoredMessageInput[]> {
	const order = range.newestFirst ? "DESC" : "ASC";
	const { results } = await db
		.prepare(
			`SELECT * FROM messages
			WHERE channel_id = ?1 AND created_at > ?2 AND created_at < ?3
			ORDER BY created_at ${order}, message_id ${order}
			LIMIT ?4`,
		)
		.bind(
			channelId,
			range.after ?? -1,
			range.before ?? Number.MAX_SAFE_INTEGER,
			range.limit,
		)
		.all<MessageRow>();
	const messages = results.map(fromRow);
	return range.newestFirst ? messages.reverse() : messages;
}

/** 保存したメッセージを、IDを指定して読む。保存されていないもの(消されたものなど)は含まない。順番は決まっていない */
export async function loadMessagesByIds(
	db: D1Database,
	messageIds: readonly string[],
): Promise<StoredMessageInput[]> {
	const found: StoredMessageInput[] = [];
	for (const ids of chunks(messageIds, MAX_IDS_PER_QUERY)) {
		const { results } = await db
			.prepare(
				`SELECT * FROM messages WHERE message_id IN (${ids.map(() => "?").join(", ")})`,
			)
			.bind(...ids)
			.all<MessageRow>();
		found.push(...results.map(fromRow));
	}
	return found;
}

/**
 * 名前から、発言者のIDを探す(意味で検索の、発言者の指定)。
 * このチャンネルで、その名前で発言した人(前に使っていた名前でも)と、サーバーで今その名前の人。
 * 大文字と小文字は区別しない。先頭の「@」は外す。同じ名前の人が何人かいれば、全員を返す
 */
export async function findAuthorIds(
	db: D1Database,
	guildId: string | null,
	channelId: string,
	name: string,
): Promise<string[]> {
	const normalized = name.trim().replace(/^@/, "");
	if (normalized === "") {
		return [];
	}
	const { results } = await db
		.prepare(
			`SELECT author_id AS id FROM messages
			WHERE channel_id = ?1 AND author_name = ?2 COLLATE NOCASE
			UNION
			SELECT user_id AS id FROM guild_members
			WHERE guild_id = ?3 AND name = ?2 COLLATE NOCASE`,
		)
		.bind(channelId, normalized, guildId ?? "")
		.all<{ id: string }>();
	return results.map((row) => row.id);
}

/** サーバーで見えている名前(人ごとに、最後に分かったもの)。分からない人は含まない */
export async function loadMemberNames(
	db: D1Database,
	guildId: string,
	userIds: readonly string[],
): Promise<Map<string, string>> {
	const names = new Map<string, string>();
	for (const ids of chunks(userIds, MAX_IDS_PER_QUERY)) {
		const { results } = await db
			.prepare(
				`SELECT user_id, name FROM guild_members
				WHERE guild_id = ? AND user_id IN (${ids.map(() => "?").join(", ")})`,
			)
			.bind(guildId, ...ids)
			.all<{ user_id: string; name: string }>();
		for (const row of results) {
			names.set(row.user_id, row.name);
		}
	}
	return names;
}

/** ベクトルを入れるメッセージ */
export interface MessageToEmbed {
	messageId: string;
	channelId: string;
	authorId: string;
	content: string;
	mentions: UserName[];
	embeds: EmbedInfo[];
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
				`SELECT message_id, channel_id, author_id, content, mentions, embeds, created_at, edited_at
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
				embeds: string | null;
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
				embeds: row.embeds ? (JSON.parse(row.embeds) as EmbedInfo[]) : [],
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
