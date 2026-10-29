import type { ChannelInfo, GuildRoles, RoleInfo } from "../discord/channels";
import { logEvent } from "../log";
import {
	deleteChannelRecords,
	deleteGuildRoles,
	loadChannels,
	loadGuildRoles,
	recomputeVisibility,
	recordedChannelIds,
	replaceGuildRoles,
	saveBotRoles,
	saveChannels,
	saveGuildRoles,
	threadIdsOf,
	unrecordedMessageChannels,
} from "../store/channels";
import { deleteChannelImports } from "../store/imports";
import { deleteChannelMessages } from "../store/messages";
import type { ChannelSyncJob } from "./messages";

/** Vectorizeから1回に消すベクトルの数 */
const DELETE_BATCH_SIZE = 100;

/** チャンネルの記録に使うもの。テストでは偽物に差し替える */
export interface ChannelDeps {
	db: D1Database;
	vectors: { deleteByIds(ids: string[]): Promise<unknown> };
	/**
	 * Bobert自身のユーザーID。チャンネルの、Botへの権限の上書きを見分けるのと、
	 * 返答の末尾の注記を、ベクトルにする文から外すのに使う
	 */
	botUserId: string;
	/** チャンネル(スレッドを含む)の情報を、DiscordのAPIで取る。消えているか、Botが見られなければnull */
	fetchChannel: (
		channelId: string,
		guildId: string,
	) => Promise<ChannelInfo | null>;
	/** サーバーのロールの権限と、Botのロールを、DiscordのAPIで取る。取れなければnull */
	fetchGuildRoles: (guildId: string) => Promise<GuildRoles | null>;
}

/**
 * チャンネル・スレッド・ロール・Bot自身のメンバーの通知を、記録に反映する
 * (仕様: docs/spec/architecture.md「サーバー全体の共有チャンネル」)。
 * - 共有チャンネルかどうかを決め直し、共有しないチャンネルの保存分を消す
 * - 削除されたチャンネル(中のスレッドを含む)の、記録と保存分を消す
 * - サーバーの全チャンネルの一覧(GUILD_CREATE)なら、記録にあって一覧にないチャンネルは、Botが止まっていた間に
 *   削除されたとみなす。記録のないチャンネルの保存分(この仕組みの前に保存したもの)も、DiscordのAPIで確かめ直す
 */
export async function applyChannelSync(
	job: ChannelSyncJob,
	deps: ChannelDeps,
): Promise<void> {
	const { db } = deps;
	const roles: RoleInfo[] = [
		...(job.roles ?? []),
		// デプロイの前に入った仕事。@everyoneのロールのIDは、サーバーのIDと同じ
		...(job.everyonePermissions === undefined
			? []
			: [{ id: job.guildId, permissions: job.everyonePermissions }]),
	];
	if (job.allRoles) {
		await replaceGuildRoles(db, job.guildId, roles, job.syncedAt);
	} else {
		await saveGuildRoles(db, job.guildId, roles, job.syncedAt);
	}
	if (job.deletedRoleIds) {
		await deleteGuildRoles(db, job.guildId, job.deletedRoleIds, job.syncedAt);
	}
	if (job.botRoleIds) {
		await saveBotRoles(db, job.guildId, job.botRoleIds, job.syncedAt);
	}
	if (job.channels) {
		await saveChannels(db, job.channels.map(withOverwrites), job.syncedAt);
	}
	const removed = new Set(job.deleted ?? []);
	if (job.allChannelIds) {
		const listed = new Set(job.allChannelIds);
		for (const channelId of await recordedChannelIds(db, job.guildId)) {
			if (!listed.has(channelId)) {
				removed.add(channelId);
			}
		}
	}
	if (removed.size > 0) {
		await removeChannels([...removed], deps);
	}
	if (job.allChannelIds) {
		await recordUnknownChannels(job.guildId, deps);
	}
	const restricted = await recomputeVisibility(db, job.guildId, deps.botUserId);
	if (restricted !== null && restricted.length > 0) {
		await forgetChannels(restricted, deps);
	}
}

/**
 * デプロイの前に入った仕事のチャンネルは、権限の上書きを、@everyoneへの分だけ別の形で持つ。今の形に直す
 */
function withOverwrites(
	channel: ChannelInfo & {
		everyoneAllow?: string | null;
		everyoneDeny?: string | null;
	},
): ChannelInfo {
	if (channel.overwrites !== undefined) {
		return channel;
	}
	const { everyoneAllow, everyoneDeny, ...rest } = channel;
	return {
		...rest,
		overwrites:
			everyoneAllow == null && everyoneDeny == null
				? []
				: [
						{
							id: channel.guildId,
							type: 0,
							allow: everyoneAllow ?? "0",
							deny: everyoneDeny ?? "0",
						},
					],
	};
}

/**
 * 保存してよいチャンネル(共有チャンネル)のIDを返す。記録にないチャンネルと、Botのロールなどが分からないサーバーは、
 * DiscordのAPIで確かめて記録する。確かめられなかったチャンネル(Botが見られないか、消えた)は、共有しないとみなす
 */
export async function resolveSharedChannels(
	targets: readonly { channelId: string; guildId: string | null }[],
	deps: ChannelDeps,
	now = Date.now(),
): Promise<Set<string>> {
	const guildOf = new Map<string, string>();
	for (const target of targets) {
		if (target.guildId !== null) {
			guildOf.set(target.channelId, target.guildId);
		}
	}
	if (guildOf.size === 0) {
		return new Set();
	}
	const recorded = await loadChannels(deps.db, [...guildOf.keys()]);
	const fetched = new Map<string, ChannelInfo>();
	const touched = new Set<string>();
	for (const [channelId, guildId] of guildOf) {
		if (recorded.has(channelId)) {
			continue;
		}
		const info = await deps.fetchChannel(channelId, guildId);
		if (info === null) {
			continue;
		}
		fetched.set(channelId, info);
		touched.add(guildId);
		// スレッドは、親のチャンネルの情報も要る
		const { parentId } = info;
		if (
			parentId !== null &&
			!recorded.has(parentId) &&
			!fetched.has(parentId)
		) {
			const parent = await deps.fetchChannel(parentId, guildId);
			if (parent !== null) {
				fetched.set(parentId, parent);
			}
		}
	}
	if (fetched.size > 0) {
		await saveChannels(deps.db, [...fetched.values()], now);
	}
	for (const guildId of new Set(guildOf.values())) {
		if ((await loadGuildRoles(deps.db, guildId)) !== null) {
			continue;
		}
		const guild = await deps.fetchGuildRoles(guildId);
		if (guild !== null) {
			await replaceGuildRoles(deps.db, guildId, guild.roles, now);
			await saveBotRoles(deps.db, guildId, guild.botRoleIds, now);
			touched.add(guildId);
		}
	}
	for (const guildId of touched) {
		await recomputeVisibility(deps.db, guildId, deps.botUserId);
	}
	const records =
		touched.size > 0
			? await loadChannels(deps.db, [...guildOf.keys()])
			: recorded;
	return new Set(
		[...records.values()]
			.filter(
				(record) =>
					record.shared && guildOf.get(record.channelId) === record.guildId,
			)
			.map((record) => record.channelId),
	);
}

/** 削除されたチャンネル(中のスレッドを含む)の、記録と保存分を消す */
async function removeChannels(
	channelIds: readonly string[],
	deps: ChannelDeps,
): Promise<void> {
	const ids = [...channelIds, ...(await threadIdsOf(deps.db, channelIds))];
	await forgetChannels(ids, deps);
	await deleteChannelRecords(deps.db, ids);
}

/** チャンネルの保存したメッセージ(D1とVectorize)と、取り込みの記録を消す */
async function forgetChannels(
	channelIds: readonly string[],
	deps: ChannelDeps,
): Promise<void> {
	const messageIds = await deleteChannelMessages(deps.db, channelIds);
	for (let i = 0; i < messageIds.length; i += DELETE_BATCH_SIZE) {
		await deps.vectors.deleteByIds(messageIds.slice(i, i + DELETE_BATCH_SIZE));
	}
	await deleteChannelImports(deps.db, channelIds);
	if (messageIds.length > 0) {
		logEvent("queue", "channel_messages_deleted", {
			channels: channelIds.length,
			messages: messageIds.length,
		});
	}
}

/**
 * メッセージを保存しているのに記録がないチャンネル(この仕組みの前に保存したものなど)を、DiscordのAPIで確かめて記録する。
 * 確かめられなかったもの(消えたか、Botが見られない)は、保存分を消す
 */
async function recordUnknownChannels(
	guildId: string,
	deps: ChannelDeps,
): Promise<void> {
	const unknown = await unrecordedMessageChannels(deps.db, guildId);
	if (unknown.length === 0) {
		return;
	}
	const found: ChannelInfo[] = [];
	const gone: string[] = [];
	for (const channelId of unknown) {
		const info = await deps.fetchChannel(channelId, guildId);
		if (info === null) {
			gone.push(channelId);
		} else {
			found.push(info);
		}
	}
	// スレッドの親が記録になければ、それも確かめる
	const recorded = await loadChannels(
		deps.db,
		found.flatMap((info) => (info.parentId === null ? [] : [info.parentId])),
	);
	for (const info of [...found]) {
		const { parentId } = info;
		if (
			parentId !== null &&
			!recorded.has(parentId) &&
			!found.some((other) => other.channelId === parentId)
		) {
			const parent = await deps.fetchChannel(parentId, guildId);
			if (parent !== null) {
				found.push(parent);
			}
		}
	}
	await saveChannels(deps.db, found, Date.now());
	if (gone.length > 0) {
		await forgetChannels(gone, deps);
	}
}
