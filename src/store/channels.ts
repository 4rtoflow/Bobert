import {
	type ChannelInfo,
	isPublicChannel,
	isThreadType,
} from "../discord/channels";

/**
 * サーバーのチャンネルとスレッドの記録(仕様: docs/spec/architecture.md「サーバー全体の公開チャンネル」)。
 * 公開チャンネルのメッセージだけを保存し、AIが読めるのも公開チャンネルと今いるチャンネルだけにするため
 */

/** 1つの問い合わせに入れるIDの数の上限(D1は、1つの問い合わせの値を100個までにしている) */
const MAX_IDS_PER_QUERY = 50;

/** 記録したチャンネル。publicは、最後に判定したときの、公開チャンネルかどうか */
export interface ChannelRecord extends ChannelInfo {
	public: boolean;
}

interface ChannelRow {
	channel_id: string;
	guild_id: string;
	parent_id: string | null;
	type: number;
	name: string;
	nsfw: number;
	everyone_allow: string | null;
	everyone_deny: string | null;
	public: number;
}

/** サーバーの@everyoneの権限を記録する。古い通知で上書きしないよう、受け取った時刻が新しいときだけ書き換える */
export async function saveEveryonePermissions(
	db: D1Database,
	guildId: string,
	permissions: string,
	syncedAt: number,
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO guild_everyone (guild_id, permissions, synced_at) VALUES (?, ?, ?)
			ON CONFLICT (guild_id) DO UPDATE SET
				permissions = excluded.permissions,
				synced_at = excluded.synced_at
			WHERE excluded.synced_at >= guild_everyone.synced_at`,
		)
		.bind(guildId, permissions, syncedAt)
		.run();
}

/** サーバーの@everyoneの権限。まだ分からなければnull */
export async function loadEveryonePermissions(
	db: D1Database,
	guildId: string,
): Promise<string | null> {
	return db
		.prepare("SELECT permissions FROM guild_everyone WHERE guild_id = ?")
		.bind(guildId)
		.first<string>("permissions");
}

/**
 * チャンネルとスレッドを記録する。古い通知で上書きしないよう、受け取った時刻が新しいときだけ書き換える。
 * 公開かどうかは、recomputeVisibilityで決め直す(新しく記録したものは、決まるまで権限付きとして扱う)
 */
export async function saveChannels(
	db: D1Database,
	channels: readonly ChannelInfo[],
	syncedAt: number,
): Promise<void> {
	if (channels.length === 0) {
		return;
	}
	await db.batch(
		channels.map((channel) =>
			db
				.prepare(
					`INSERT INTO channels (
						channel_id, guild_id, parent_id, type, name, nsfw, everyone_allow, everyone_deny, public, synced_at
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
					ON CONFLICT (channel_id) DO UPDATE SET
						guild_id = excluded.guild_id,
						parent_id = excluded.parent_id,
						type = excluded.type,
						name = excluded.name,
						nsfw = excluded.nsfw,
						everyone_allow = excluded.everyone_allow,
						everyone_deny = excluded.everyone_deny,
						synced_at = excluded.synced_at
					WHERE excluded.synced_at >= channels.synced_at`,
				)
				.bind(
					channel.channelId,
					channel.guildId,
					channel.parentId,
					channel.type,
					channel.name,
					channel.nsfw ? 1 : 0,
					channel.everyoneAllow,
					channel.everyoneDeny,
					syncedAt,
				),
		),
	);
}

/**
 * サーバーのチャンネルとスレッドが公開かどうかを、@everyoneの権限から決め直す。権限付きのもののIDを返す。
 * @everyoneの権限がまだ分からなければ、何もせずにnullを返す(分かるまで、新しく記録したものは権限付きのまま)
 */
export async function recomputeVisibility(
	db: D1Database,
	guildId: string,
): Promise<string[] | null> {
	const everyone = await loadEveryonePermissions(db, guildId);
	if (everyone === null) {
		return null;
	}
	const records = await guildChannels(db, guildId);
	const byId = new Map(records.map((record) => [record.channelId, record]));
	const restricted: string[] = [];
	const updates: D1PreparedStatement[] = [];
	for (const record of records) {
		const parent =
			record.parentId === null ? undefined : byId.get(record.parentId);
		const visible = isPublicChannel(record, parent, everyone);
		if (!visible) {
			restricted.push(record.channelId);
		}
		if (visible !== record.public) {
			updates.push(
				db
					.prepare("UPDATE channels SET public = ? WHERE channel_id = ?")
					.bind(visible ? 1 : 0, record.channelId),
			);
		}
	}
	if (updates.length > 0) {
		await db.batch(updates);
	}
	return restricted;
}

/** サーバーの、記録したチャンネルとスレッド */
export async function guildChannels(
	db: D1Database,
	guildId: string,
): Promise<ChannelRecord[]> {
	const { results } = await db
		.prepare("SELECT * FROM channels WHERE guild_id = ?")
		.bind(guildId)
		.all<ChannelRow>();
	return results.map(fromRow);
}

/** 記録したチャンネルとスレッドを、IDを指定して読む。記録にないものは含まない */
export async function loadChannels(
	db: D1Database,
	channelIds: readonly string[],
): Promise<Map<string, ChannelRecord>> {
	const found = new Map<string, ChannelRecord>();
	for (const ids of chunks([...new Set(channelIds)], MAX_IDS_PER_QUERY)) {
		const { results } = await db
			.prepare(
				`SELECT * FROM channels WHERE channel_id IN (${ids.map(() => "?").join(", ")})`,
			)
			.bind(...ids)
			.all<ChannelRow>();
		for (const row of results) {
			found.set(row.channel_id, fromRow(row));
		}
	}
	return found;
}

/** サーバーの公開チャンネル(スレッドを除く)。名前の順 */
export async function publicChannelsOf(
	db: D1Database,
	guildId: string,
): Promise<ChannelRecord[]> {
	const { results } = await db
		.prepare(
			`SELECT * FROM channels WHERE guild_id = ? AND public = 1 AND parent_id IS NULL
			ORDER BY name, channel_id`,
		)
		.bind(guildId)
		.all<ChannelRow>();
	return results.map(fromRow);
}

/**
 * 名前から、サーバーの公開チャンネル(スレッドを含む)を探す。大文字と小文字は区別しない。
 * スレッドでないチャンネルを先に、古い(IDが小さい)ものから並べる
 */
export async function findPublicChannelsByName(
	db: D1Database,
	guildId: string,
	name: string,
): Promise<ChannelRecord[]> {
	const { results } = await db
		.prepare(
			`SELECT * FROM channels
			WHERE guild_id = ? AND public = 1 AND name = ? COLLATE NOCASE
			ORDER BY parent_id IS NOT NULL, length(channel_id), channel_id`,
		)
		.bind(guildId, name)
		.all<ChannelRow>();
	return results.map(fromRow);
}

/** 親のチャンネルを指定して、その中のスレッドのIDを読む */
export async function threadIdsOf(
	db: D1Database,
	parentIds: readonly string[],
): Promise<string[]> {
	const found: string[] = [];
	for (const ids of chunks([...new Set(parentIds)], MAX_IDS_PER_QUERY)) {
		const { results } = await db
			.prepare(
				`SELECT channel_id FROM channels WHERE parent_id IN (${ids.map(() => "?").join(", ")})`,
			)
			.bind(...ids)
			.all<{ channel_id: string }>();
		found.push(...results.map((row) => row.channel_id));
	}
	return found;
}

/** チャンネルとスレッドの記録を消す */
export async function deleteChannelRecords(
	db: D1Database,
	channelIds: readonly string[],
): Promise<void> {
	for (const ids of chunks([...new Set(channelIds)], MAX_IDS_PER_QUERY)) {
		await db
			.prepare(
				`DELETE FROM channels WHERE channel_id IN (${ids.map(() => "?").join(", ")})`,
			)
			.bind(...ids)
			.run();
	}
}

/** メッセージを保存しているのに、記録がないチャンネル(この仕組みの前に保存したものなど) */
export async function unrecordedMessageChannels(
	db: D1Database,
	guildId: string,
): Promise<string[]> {
	const { results } = await db
		.prepare(
			`SELECT DISTINCT channel_id FROM messages
			WHERE guild_id = ? AND channel_id NOT IN (SELECT channel_id FROM channels)`,
		)
		.bind(guildId)
		.all<{ channel_id: string }>();
	return results.map((row) => row.channel_id);
}

/** スレッドでないチャンネルのうち、記録にあるもの(サーバーの全チャンネルの一覧と比べるため) */
export async function recordedChannelIds(
	db: D1Database,
	guildId: string,
): Promise<string[]> {
	return (await guildChannels(db, guildId))
		.filter((record) => !isThreadType(record.type))
		.map((record) => record.channelId);
}

function fromRow(row: ChannelRow): ChannelRecord {
	return {
		channelId: row.channel_id,
		guildId: row.guild_id,
		parentId: row.parent_id,
		type: row.type,
		name: row.name,
		nsfw: row.nsfw === 1,
		everyoneAllow: row.everyone_allow,
		everyoneDeny: row.everyone_deny,
		public: row.public === 1,
	};
}

function chunks<T>(items: readonly T[], size: number): T[][] {
	const result: T[][] = [];
	for (let i = 0; i < items.length; i += size) {
		result.push(items.slice(i, i + size));
	}
	return result;
}
