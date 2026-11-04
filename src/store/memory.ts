/**
 * 記憶(D1)。人とサーバーごとに、AIがその人について覚えておくことの一覧と、その設定を置く
 * (仕様: docs/spec/architecture.md「記憶」)。
 */

/** 1つの項目の長さの上限(文字数) */
export const MAX_MEMORY_ITEM_LENGTH = 100;
/** 一覧全体の長さの上限(文字数)。/memory の画面を1通(2000文字)で見せられるようにする */
export const MAX_MEMORY_TOTAL_LENGTH = 1500;

/** 更新は、前回の更新から1日以上たってから */
export const MEMORY_UPDATE_INTERVAL_MS = 24 * 60 * 60_000;
/** 更新を始めてから(失敗したときも)、次に試すまで空ける時間 */
export const MEMORY_RETRY_INTERVAL_MS = 60 * 60_000;

/** D1の1回のクエリに渡せる値の数(上限100)に収める */
const MAX_IDS_PER_QUERY = 90;
/** 1つの項目に記録する、もとの発言の数の上限(新しいものを残す) */
const MAX_SOURCES_PER_ITEM = 10;

/** 記憶の項目 */
export interface MemoryItem {
	text: string;
	/** 本人が書いた項目(/memory で直したものと、会話で頼まれたもの)。まとめ直しでは変えない */
	userWritten: boolean;
	/** もとになった発言のID。すべて消されたら、項目も消す(本人が書いた項目は除く) */
	sources: string[];
}

/** 人とサーバーごとの、記憶の設定と一覧 */
export interface MemoryState {
	enabled: boolean;
	/** この時刻までの発言を読み込んだ。nullなら、まだ最初の一覧を作っていない */
	readUntil: number | null;
	/** 最後に更新し終えた時刻 */
	updatedAt: number | null;
	/** 最後の更新に失敗した理由。成功したらnull */
	failure: string | null;
	items: MemoryItem[];
}

/** 記憶の設定と一覧。記憶を一度も使っていなければnull */
export async function loadMemory(
	db: D1Database,
	userId: string,
	guildId: string,
): Promise<MemoryState | null> {
	const settings = await db
		.prepare(
			`SELECT enabled, read_until, updated_at, failure FROM memory_settings
			WHERE user_id = ? AND guild_id = ?`,
		)
		.bind(userId, guildId)
		.first<{
			enabled: number;
			read_until: number | null;
			updated_at: number | null;
			failure: string | null;
		}>();
	if (settings === null) {
		return null;
	}
	return {
		enabled: settings.enabled === 1,
		readUntil: settings.read_until,
		updatedAt: settings.updated_at,
		failure: settings.failure,
		items: await loadMemoryItems(db, userId, guildId),
	};
}

/** 記憶の一覧(並び順) */
export async function loadMemoryItems(
	db: D1Database,
	userId: string,
	guildId: string,
): Promise<MemoryItem[]> {
	const { results } = await db
		.prepare(
			`SELECT i.id, i.text, i.user_written, s.message_id
			FROM memory_items i LEFT JOIN memory_item_sources s ON s.item_id = i.id
			WHERE i.user_id = ? AND i.guild_id = ?
			ORDER BY i.position, s.message_id`,
		)
		.bind(userId, guildId)
		.all<{
			id: string;
			text: string;
			user_written: number;
			message_id: string | null;
		}>();
	const items = new Map<string, MemoryItem>();
	for (const row of results) {
		let item = items.get(row.id);
		if (item === undefined) {
			item = {
				text: row.text,
				userWritten: row.user_written === 1,
				sources: [],
			};
			items.set(row.id, item);
		}
		if (row.message_id !== null) {
			item.sources.push(row.message_id);
		}
	}
	return [...items.values()];
}

/** 記憶を使うかを切り替える。記録がなければ作る */
export async function setMemoryEnabled(
	db: D1Database,
	userId: string,
	guildId: string,
	enabled: boolean,
	now = Date.now(),
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO memory_settings (user_id, guild_id, enabled, created_at) VALUES (?, ?, ?, ?)
			ON CONFLICT (user_id, guild_id) DO UPDATE SET enabled = excluded.enabled`,
		)
		.bind(userId, guildId, enabled ? 1 : 0, now)
		.run();
}

/**
 * 記憶の更新を始めてよいかを確かめ、始めた時刻を記録する(同じ人の更新を重ねないため)。
 * 記憶を使っていて、前回の更新から1日以上たち、前回始めてから1時間以上たっていれば始める。
 * forceなら(/memory でONにしたとき)、使っていれば、いつでも始める
 */
export async function claimMemoryUpdate(
	db: D1Database,
	userId: string,
	guildId: string,
	options: { force?: boolean; now?: number } = {},
): Promise<boolean> {
	const now = options.now ?? Date.now();
	const result = options.force
		? await db
				.prepare(
					`UPDATE memory_settings SET attempted_at = ?
					WHERE user_id = ? AND guild_id = ? AND enabled = 1`,
				)
				.bind(now, userId, guildId)
				.run()
		: await db
				.prepare(
					`UPDATE memory_settings SET attempted_at = ?
					WHERE user_id = ? AND guild_id = ? AND enabled = 1
						AND (updated_at IS NULL OR updated_at <= ?)
						AND (attempted_at IS NULL OR attempted_at <= ?)`,
				)
				.bind(
					now,
					userId,
					guildId,
					now - MEMORY_UPDATE_INTERVAL_MS,
					now - MEMORY_RETRY_INTERVAL_MS,
				)
				.run();
	return result.meta.changes > 0;
}

/** 更新し終えた。readUntilまでの発言を読み込んだことと、失敗の理由を消したことを記録する */
export async function recordMemoryUpdated(
	db: D1Database,
	userId: string,
	guildId: string,
	readUntil: number,
	now = Date.now(),
): Promise<void> {
	await db
		.prepare(
			`UPDATE memory_settings SET read_until = ?, updated_at = ?, failure = NULL
			WHERE user_id = ? AND guild_id = ?`,
		)
		.bind(readUntil, now, userId, guildId)
		.run();
}

/** 更新に失敗した理由を記録する(1時間たった後に、次に使ったときに試し直す) */
export async function recordMemoryFailure(
	db: D1Database,
	userId: string,
	guildId: string,
	failure: string,
): Promise<void> {
	await db
		.prepare(
			"UPDATE memory_settings SET failure = ? WHERE user_id = ? AND guild_id = ?",
		)
		.bind(failure, userId, guildId)
		.run();
}

/** 記憶の一覧を、まとめて置き換える(並び順は、渡した順) */
export async function saveMemoryItems(
	db: D1Database,
	userId: string,
	guildId: string,
	items: readonly MemoryItem[],
	now = Date.now(),
): Promise<void> {
	const statements = [
		db
			.prepare(
				`DELETE FROM memory_item_sources WHERE item_id IN
				(SELECT id FROM memory_items WHERE user_id = ? AND guild_id = ?)`,
			)
			.bind(userId, guildId),
		db
			.prepare("DELETE FROM memory_items WHERE user_id = ? AND guild_id = ?")
			.bind(userId, guildId),
	];
	for (const [position, item] of items.entries()) {
		const id = crypto.randomUUID();
		statements.push(
			db
				.prepare(
					`INSERT INTO memory_items (id, user_id, guild_id, position, text, user_written, created_at, updated_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.bind(
					id,
					userId,
					guildId,
					position,
					item.text,
					item.userWritten ? 1 : 0,
					now,
					now,
				),
			...[...new Set(item.sources)]
				.slice(-MAX_SOURCES_PER_ITEM)
				.map((messageId) =>
					db
						.prepare(
							"INSERT INTO memory_item_sources (item_id, message_id) VALUES (?, ?)",
						)
						.bind(id, messageId),
				),
		);
	}
	await db.batch(statements);
}

/** その人の、そのサーバーでの記憶の一覧を消す(設定は残す) */
export async function clearMemoryItems(
	db: D1Database,
	userId: string,
	guildId: string,
): Promise<void> {
	await saveMemoryItems(db, userId, guildId, []);
}

/** その人の記憶を、すべてのサーバーの分、設定ごと消す(/delete) */
export async function deleteUserMemory(
	db: D1Database,
	userId: string,
): Promise<void> {
	await db.batch([
		db
			.prepare(
				`DELETE FROM memory_item_sources WHERE item_id IN
				(SELECT id FROM memory_items WHERE user_id = ?)`,
			)
			.bind(userId),
		db.prepare("DELETE FROM memory_items WHERE user_id = ?").bind(userId),
		db.prepare("DELETE FROM memory_settings WHERE user_id = ?").bind(userId),
	]);
}

/** 記憶を使ったことがあるか(どこかのサーバーに、設定か一覧がある) */
export async function hasAnyMemory(
	db: D1Database,
	userId: string,
): Promise<boolean> {
	const row = await db
		.prepare(
			`SELECT 1 AS found FROM memory_settings WHERE user_id = ?
			UNION SELECT 1 FROM memory_items WHERE user_id = ? LIMIT 1`,
		)
		.bind(userId, userId)
		.first<{ found: number }>();
	return row !== null;
}

/**
 * 消された発言を、記憶の項目のもとから外す。もとの発言がすべて消された項目は、消す(本人が書いた項目は除く)。
 * Discordで発言が消されたときと、チャンネルの保存分を消したときに呼ぶ。消した項目の数を返す
 */
export async function forgetMemorySources(
	db: D1Database,
	messageIds: readonly string[],
): Promise<number> {
	let removed = 0;
	const ids = [...new Set(messageIds)];
	for (let i = 0; i < ids.length; i += MAX_IDS_PER_QUERY) {
		const chunk = ids.slice(i, i + MAX_IDS_PER_QUERY);
		const placeholders = chunk.map(() => "?").join(", ");
		const { results } = await db
			.prepare(
				`DELETE FROM memory_item_sources WHERE message_id IN (${placeholders})
				RETURNING item_id`,
			)
			.bind(...chunk)
			.all<{ item_id: string }>();
		const affected = [...new Set(results.map((row) => row.item_id))];
		if (affected.length === 0) {
			continue;
		}
		for (let j = 0; j < affected.length; j += MAX_IDS_PER_QUERY) {
			const items = affected.slice(j, j + MAX_IDS_PER_QUERY);
			const result = await db
				.prepare(
					`DELETE FROM memory_items WHERE id IN (${items.map(() => "?").join(", ")})
					AND user_written = 0
					AND id NOT IN (SELECT item_id FROM memory_item_sources)`,
				)
				.bind(...items)
				.run();
			removed += result.meta.changes;
		}
	}
	return removed;
}
