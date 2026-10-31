import {
	type ChannelInfo,
	type GuildRoles,
	isSharedChannel,
	isThreadType,
	type PermissionOverwrite,
	type RoleInfo,
} from "../discord/channels";

/**
 * サーバーのチャンネルとスレッド、ロールの記録(仕様: docs/spec/architecture.md「サーバー全体の共有チャンネル」)。
 * 共有チャンネル(Botが見られて、年齢制限がないチャンネル)のメッセージだけを保存し、
 * AIが読めるのも共有チャンネルと今いるチャンネルだけにするため
 */

/** 1つの問い合わせに入れるIDの数の上限(D1は、1つの問い合わせの値を100個までにしている) */
const MAX_IDS_PER_QUERY = 50;

/** 記録したチャンネル。sharedは、最後に判定したときの、共有チャンネルかどうか */
export interface ChannelRecord extends ChannelInfo {
	shared: boolean;
}

interface ChannelRow {
	channel_id: string;
	guild_id: string;
	parent_id: string | null;
	type: number;
	name: string;
	nsfw: number;
	overwrites: string;
	shared: number;
}

/** サーバーのロールを記録する。古い通知で上書きしないよう、受け取った時刻が新しいときだけ書き換える */
export async function saveGuildRoles(
	db: D1Database,
	guildId: string,
	roles: readonly RoleInfo[],
	syncedAt: number,
): Promise<void> {
	if (roles.length === 0) {
		return;
	}
	await db.batch(roles.map((role) => saveRole(db, guildId, role, syncedAt)));
}

/**
 * サーバーの全ロールの一覧で、ロールの記録を置き換える。一覧にないロール(Botが止まっていた間に削除されたものなど)の記録は消す。
 * 一覧より新しい通知で記録したロールは、残す
 */
export async function replaceGuildRoles(
	db: D1Database,
	guildId: string,
	roles: readonly RoleInfo[],
	syncedAt: number,
): Promise<void> {
	await db.batch([
		...roles.map((role) => saveRole(db, guildId, role, syncedAt)),
		// 一覧にあるロールは、上で受け取った時刻(か、より新しい時刻)になっている
		db
			.prepare("DELETE FROM guild_roles WHERE guild_id = ? AND synced_at < ?")
			.bind(guildId, syncedAt),
	]);
}

function saveRole(
	db: D1Database,
	guildId: string,
	role: RoleInfo,
	syncedAt: number,
): D1PreparedStatement {
	return db
		.prepare(
			`INSERT INTO guild_roles (guild_id, role_id, permissions, synced_at) VALUES (?, ?, ?, ?)
			ON CONFLICT (guild_id, role_id) DO UPDATE SET
				permissions = excluded.permissions,
				synced_at = excluded.synced_at
			WHERE excluded.synced_at >= guild_roles.synced_at`,
		)
		.bind(guildId, role.id, role.permissions, syncedAt);
}

/** 削除されたロールの記録を消す。削除より新しい通知で記録し直したものは、残す */
export async function deleteGuildRoles(
	db: D1Database,
	guildId: string,
	roleIds: readonly string[],
	syncedAt: number,
): Promise<void> {
	for (const ids of chunks([...new Set(roleIds)], MAX_IDS_PER_QUERY)) {
		await db
			.prepare(
				`DELETE FROM guild_roles
				WHERE guild_id = ? AND synced_at <= ? AND role_id IN (${ids.map(() => "?").join(", ")})`,
			)
			.bind(guildId, syncedAt, ...ids)
			.run();
	}
}

/** Botが持つロールを記録する。古い通知で上書きしないよう、受け取った時刻が新しいときだけ書き換える */
export async function saveBotRoles(
	db: D1Database,
	guildId: string,
	roleIds: readonly string[],
	syncedAt: number,
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO bot_members (guild_id, role_ids, synced_at) VALUES (?, ?, ?)
			ON CONFLICT (guild_id) DO UPDATE SET
				role_ids = excluded.role_ids,
				synced_at = excluded.synced_at
			WHERE excluded.synced_at >= bot_members.synced_at`,
		)
		.bind(guildId, JSON.stringify(roleIds), syncedAt)
		.run();
}

/** サーバーのロールの権限と、Botのロール。Botのロールか、@everyoneのロールの権限が、まだ分からなければnull */
export async function loadGuildRoles(
	db: D1Database,
	guildId: string,
): Promise<GuildRoles | null> {
	const [roles, member] = await db.batch([
		db
			.prepare(
				"SELECT role_id, permissions FROM guild_roles WHERE guild_id = ? ORDER BY role_id",
			)
			.bind(guildId),
		db
			.prepare("SELECT role_ids FROM bot_members WHERE guild_id = ?")
			.bind(guildId),
	]);
	const roleRows = (roles?.results ?? []) as {
		role_id: string;
		permissions: string;
	}[];
	const memberRow = (member?.results ?? [])[0] as
		| { role_ids: string }
		| undefined;
	if (
		memberRow === undefined ||
		!roleRows.some((row) => row.role_id === guildId)
	) {
		return null;
	}
	return {
		roles: roleRows.map((row) => ({
			id: row.role_id,
			permissions: row.permissions,
		})),
		botRoleIds: parseStrings(memberRow.role_ids),
	};
}

/**
 * チャンネルとスレッドを記録する。古い通知で上書きしないよう、受け取った時刻が新しいときだけ書き換える。
 * 共有チャンネルかどうかは、recomputeVisibilityで決め直す(新しく記録したものは、決まるまで共有しない)
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
						channel_id, guild_id, parent_id, type, name, nsfw, overwrites, shared, synced_at
					) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
					ON CONFLICT (channel_id) DO UPDATE SET
						guild_id = excluded.guild_id,
						parent_id = excluded.parent_id,
						type = excluded.type,
						name = excluded.name,
						nsfw = excluded.nsfw,
						overwrites = excluded.overwrites,
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
					JSON.stringify(channel.overwrites),
					syncedAt,
				),
		),
	);
}

/**
 * サーバーのチャンネルとスレッドが共有チャンネルかどうかを、ロールの権限から決め直す。共有しないもののIDを返す。
 * Botのロールなどがまだ分からなければ、何もせずにnullを返す(分かるまで、新しく記録したものは共有しないまま)
 */
export async function recomputeVisibility(
	db: D1Database,
	guildId: string,
	botUserId: string,
): Promise<string[] | null> {
	const guild = await loadGuildRoles(db, guildId);
	if (guild === null) {
		return null;
	}
	const records = await guildChannels(db, guildId);
	const byId = new Map(records.map((record) => [record.channelId, record]));
	const restricted: string[] = [];
	const updates: D1PreparedStatement[] = [];
	for (const record of records) {
		const parent =
			record.parentId === null ? undefined : byId.get(record.parentId);
		const shared = isSharedChannel(record, parent, guild, botUserId);
		if (!shared) {
			restricted.push(record.channelId);
		}
		if (shared !== record.shared) {
			updates.push(
				db
					.prepare("UPDATE channels SET shared = ? WHERE channel_id = ?")
					.bind(shared ? 1 : 0, record.channelId),
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

/** サーバーの共有チャンネル(スレッドを除く)。名前の順 */
export async function sharedChannelsOf(
	db: D1Database,
	guildId: string,
): Promise<ChannelRecord[]> {
	const { results } = await db
		.prepare(
			`SELECT * FROM channels WHERE guild_id = ? AND shared = 1 AND parent_id IS NULL
			ORDER BY name, channel_id`,
		)
		.bind(guildId)
		.all<ChannelRow>();
	return results.map(fromRow);
}

/** 共有チャンネルのスレッドと、その中の、保存したメッセージのうち最後の発言の時刻 */
export interface ThreadActivity {
	thread: ChannelRecord;
	/** 最後の発言の時刻(UNIX時間のミリ秒)。保存したメッセージがなければnull */
	lastMessageAt: number | null;
}

/** サーバーの共有チャンネルの、スレッド(フォーラムの投稿を含む)と、最後の発言の時刻 */
export async function sharedThreadsOf(
	db: D1Database,
	guildId: string,
): Promise<ThreadActivity[]> {
	const { results } = await db
		.prepare(
			`SELECT c.*, (SELECT MAX(m.created_at) FROM messages m WHERE m.channel_id = c.channel_id) AS last_message_at
			FROM channels c
			WHERE c.guild_id = ? AND c.shared = 1 AND c.parent_id IS NOT NULL`,
		)
		.bind(guildId)
		.all<ChannelRow & { last_message_at: number | null }>();
	return results.map((row) => ({
		thread: fromRow(row),
		lastMessageAt: row.last_message_at,
	}));
}

/**
 * 名前から、サーバーの共有チャンネル(スレッドを含む)を探す。大文字と小文字は区別しない。
 * スレッドでないチャンネルを先に、古い(IDが小さい)ものから並べる
 */
export async function findSharedChannelsByName(
	db: D1Database,
	guildId: string,
	name: string,
): Promise<ChannelRecord[]> {
	const { results } = await db
		.prepare(
			`SELECT * FROM channels
			WHERE guild_id = ? AND shared = 1 AND name = ? COLLATE NOCASE
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
		overwrites: parseOverwrites(row.overwrites),
		shared: row.shared === 1,
	};
}

/** 記録した権限の上書き(JSON)を読む。読めなければ、上書きはないとみなす */
function parseOverwrites(json: string): PermissionOverwrite[] {
	try {
		const value: unknown = JSON.parse(json);
		return Array.isArray(value) ? (value as PermissionOverwrite[]) : [];
	} catch {
		return [];
	}
}

/** 記録した文字列の配列(JSON)を読む。読めなければ、空とみなす */
function parseStrings(json: string): string[] {
	try {
		const value: unknown = JSON.parse(json);
		return Array.isArray(value)
			? value.filter((item): item is string => typeof item === "string")
			: [];
	} catch {
		return [];
	}
}

function chunks<T>(items: readonly T[], size: number): T[][] {
	const result: T[][] = [];
	for (let i = 0; i < items.length; i += size) {
		result.push(items.slice(i, i + size));
	}
	return result;
}
