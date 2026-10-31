import type { ReactionJob } from "../queue/messages";

/**
 * メッセージに付いたリアクションの記録(仕様: docs/spec/architecture.md「リアクション」)。
 * 付け外しの通知は、Queueのやり直しなどで順番が入れ替わることがある。通知を受け取った時刻を比べ、古い通知で上書きしない。
 * そのため、外したリアクションと、全部外した・絵文字ごとに外した印も、1日だけ残す
 */

/** 外したリアクションと、外した印を残す時間。やり直しの間だけ要る */
const REMOVED_RETENTION_MS = 24 * 60 * 60 * 1000;

/** 全部外した印と、絵文字ごとに外した印の、人(と、全部外した印の絵文字) */
const EVERYONE = "*";

/** 1つの問い合わせに入れるIDの数の上限(D1は、1つの問い合わせの値を100個までにしている) */
const MAX_IDS_PER_QUERY = 50;

/** メッセージに付いている、1つの絵文字のリアクション */
export interface MessageReaction {
	/** 絵文字。Unicodeの絵文字はその文字、カスタム絵文字は「名前:ID」 */
	emoji: string;
	/** 付けた人。付けた順 */
	userIds: string[];
}

/** リアクションの付け外しを、記録に反映する */
export async function applyReactionJobs(
	db: D1Database,
	jobs: readonly ReactionJob[],
	now = Date.now(),
): Promise<void> {
	const statements = jobs.flatMap((job) => reactionStatements(db, job));
	if (statements.length === 0) {
		return;
	}
	await db.batch([
		...statements,
		db
			.prepare(
				"DELETE FROM message_reactions WHERE present = 0 AND updated_at < ?",
			)
			.bind(now - REMOVED_RETENTION_MS),
	]);
}

function reactionStatements(
	db: D1Database,
	job: ReactionJob,
): D1PreparedStatement[] {
	switch (job.action) {
		case "add":
		case "remove": {
			if (job.userId === undefined || job.emoji === undefined) {
				return [];
			}
			// 付けるときは、後から届いた「外した」通知や、消えたメッセージには付け直さない
			return [
				db
					.prepare(
						`INSERT INTO message_reactions (message_id, channel_id, emoji, user_id, burst, present, updated_at)
						SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
						WHERE NOT EXISTS (
							SELECT 1 FROM message_reactions
							WHERE message_id = ?1 AND user_id = '${EVERYONE}' AND emoji IN ('${EVERYONE}', ?3) AND updated_at >= ?7
						) AND NOT EXISTS (SELECT 1 FROM deleted_messages WHERE message_id = ?1)
						ON CONFLICT (message_id, emoji, user_id, burst) DO UPDATE SET
							present = excluded.present,
							updated_at = excluded.updated_at
						WHERE excluded.updated_at > message_reactions.updated_at`,
					)
					.bind(
						job.messageId,
						job.channelId,
						job.emoji,
						job.userId,
						job.burst ? 1 : 0,
						job.action === "add" ? 1 : 0,
						job.at,
					),
			];
		}
		case "remove_emoji":
			if (job.emoji === undefined) {
				return [];
			}
			return removeAll(db, job, job.emoji);
		case "remove_all":
			return removeAll(db, job, null);
	}
}

/** メッセージのリアクションを、全部(emojiがnull)か、絵文字ごとに外す。外した印も残す */
function removeAll(
	db: D1Database,
	job: ReactionJob,
	emoji: string | null,
): D1PreparedStatement[] {
	const marker = emoji ?? EVERYONE;
	return [
		db
			.prepare(
				`UPDATE message_reactions SET present = 0, updated_at = ?1
				WHERE message_id = ?2 AND user_id != '${EVERYONE}' AND updated_at < ?1
					AND (?3 IS NULL OR emoji = ?3)`,
			)
			.bind(job.at, job.messageId, emoji),
		db
			.prepare(
				`INSERT INTO message_reactions (message_id, channel_id, emoji, user_id, burst, present, updated_at)
				VALUES (?, ?, ?, '${EVERYONE}', 0, 0, ?)
				ON CONFLICT (message_id, emoji, user_id, burst) DO UPDATE SET updated_at = excluded.updated_at
				WHERE excluded.updated_at > message_reactions.updated_at`,
			)
			.bind(job.messageId, job.channelId, marker, job.at),
	];
}

/**
 * メッセージに付いているリアクション(メッセージIDごと)。絵文字は最初に付いた順、人は付けた順。
 * ふつうのリアクションとスーパーリアクションは、まとめる
 */
export async function loadReactions(
	db: D1Database,
	messageIds: readonly string[],
): Promise<Map<string, MessageReaction[]>> {
	const found = new Map<string, MessageReaction[]>();
	for (const ids of chunks([...new Set(messageIds)], MAX_IDS_PER_QUERY)) {
		const { results } = await db
			.prepare(
				`SELECT message_id, emoji, user_id FROM message_reactions
				WHERE present = 1 AND message_id IN (${ids.map(() => "?").join(", ")})
				ORDER BY message_id, updated_at, user_id`,
			)
			.bind(...ids)
			.all<{ message_id: string; emoji: string; user_id: string }>();
		for (const row of results) {
			const reactions = found.get(row.message_id) ?? [];
			let reaction = reactions.find(
				(candidate) => candidate.emoji === row.emoji,
			);
			if (reaction === undefined) {
				reaction = { emoji: row.emoji, userIds: [] };
				reactions.push(reaction);
			}
			if (!reaction.userIds.includes(row.user_id)) {
				reaction.userIds.push(row.user_id);
			}
			found.set(row.message_id, reactions);
		}
	}
	return found;
}

/** 削除されたメッセージのリアクションの記録を消す */
export async function deleteMessageReactions(
	db: D1Database,
	messageIds: readonly string[],
): Promise<void> {
	const statements = chunks([...new Set(messageIds)], MAX_IDS_PER_QUERY).map(
		(ids) =>
			db
				.prepare(
					`DELETE FROM message_reactions WHERE message_id IN (${ids.map(() => "?").join(", ")})`,
				)
				.bind(...ids),
	);
	if (statements.length > 0) {
		await db.batch(statements);
	}
}

/** チャンネル(スレッドを含む)のリアクションの記録を、まとめて消す。共有しなくなったチャンネルや、削除されたチャンネルの分 */
export async function deleteChannelReactions(
	db: D1Database,
	channelIds: readonly string[],
): Promise<void> {
	const statements = chunks([...new Set(channelIds)], MAX_IDS_PER_QUERY).map(
		(ids) =>
			db
				.prepare(
					`DELETE FROM message_reactions WHERE channel_id IN (${ids.map(() => "?").join(", ")})`,
				)
				.bind(...ids),
	);
	if (statements.length > 0) {
		await db.batch(statements);
	}
}

function chunks<T>(items: readonly T[], size: number): T[][] {
	const result: T[][] = [];
	for (let i = 0; i < items.length; i += size) {
		result.push(items.slice(i, i + size));
	}
	return result;
}
