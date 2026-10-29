import {
	type DiscordChannel,
	isThreadType,
	type RoleInfo,
	toChannelInfo,
} from "../discord/channels";
import type { ChannelSyncJob } from "../queue/messages";

/** 1つの仕事に入れるチャンネルの大きさの目安(バイト)。Queuesの1件の大きさの上限(128KB)に、余裕を持って収める */
const MAX_JOB_BYTES = 96 * 1024;

/** サーバーの情報(GUILD_CREATE)のうち、Bobertが使う部分 */
interface GatewayGuild {
	id: string;
	unavailable?: boolean;
	roles?: RoleInfo[];
	/** GUILD_PRESENCESのインテントがなければ、Bot自身と、ボイスチャンネルにいる人だけが入る */
	members?: GatewayMember[];
	channels?: DiscordChannel[];
	threads?: DiscordChannel[];
}

/** サーバーのメンバーのうち、Bobertが使う部分 */
interface GatewayMember {
	user?: { id: string };
	roles: string[];
}

/**
 * チャンネル・スレッド・ロール・Bot自身のメンバーの通知を、記録の仕事にする
 * (仕様: docs/spec/architecture.md「サーバー全体の共有チャンネル」)。
 * 関係のない通知なら、空の配列を返す。nowは、通知を受け取った時刻。botUserIdは、READYで分かったBotのユーザーID
 */
export function channelSyncJobs(
	event: string,
	data: unknown,
	now: number,
	botUserId: string | null,
): ChannelSyncJob[] {
	switch (event) {
		case "GUILD_CREATE": {
			const guild = data as GatewayGuild;
			if (guild.unavailable) {
				return [];
			}
			const channels = guild.channels ?? [];
			const infos = [...channels, ...(guild.threads ?? [])].map((channel) =>
				toChannelInfo(channel, guild.id),
			);
			const jobs = chunkBySize(infos, MAX_JOB_BYTES).map((chunk) =>
				syncJob(guild.id, now, { channels: chunk }),
			);
			const bot = guild.members?.find(
				(member) => botUserId !== null && member.user?.id === botUserId,
			);
			// ロールの一覧とBotのロール、サーバーの全チャンネルの一覧は、最後の仕事に入れる。
			// 保存してあるのに一覧にないものは、削除されたとみなす
			jobs.push(
				syncJob(guild.id, now, {
					roles: (guild.roles ?? []).map(roleInfo),
					allRoles: true,
					...(bot === undefined ? {} : { botRoleIds: bot.roles }),
					allChannelIds: channels
						.filter((channel) => !isThreadType(channel.type))
						.map((channel) => channel.id),
				}),
			);
			return jobs;
		}
		case "GUILD_ROLE_CREATE":
		case "GUILD_ROLE_UPDATE": {
			const { guild_id: guildId, role } = data as {
				guild_id: string;
				role: RoleInfo;
			};
			return [syncJob(guildId, now, { roles: [roleInfo(role)] })];
		}
		case "GUILD_ROLE_DELETE": {
			const { guild_id: guildId, role_id: roleId } = data as {
				guild_id: string;
				role_id: string;
			};
			return [syncJob(guildId, now, { deletedRoleIds: [roleId] })];
		}
		case "GUILD_MEMBER_UPDATE": {
			// GUILD_MEMBERSのインテントがなくても、Bot自身の分は届く。ほかの人の分は使わない
			const member = data as GatewayMember & { guild_id: string };
			return botUserId !== null && member.user?.id === botUserId
				? [syncJob(member.guild_id, now, { botRoleIds: member.roles })]
				: [];
		}
		case "CHANNEL_CREATE":
		case "CHANNEL_UPDATE":
		case "THREAD_CREATE":
		case "THREAD_UPDATE": {
			const channel = data as DiscordChannel & { guild_id?: string };
			return channel.guild_id
				? [
						syncJob(channel.guild_id, now, {
							channels: [toChannelInfo(channel, channel.guild_id)],
						}),
					]
				: [];
		}
		case "CHANNEL_DELETE":
		case "THREAD_DELETE": {
			const channel = data as { id: string; guild_id?: string };
			return channel.guild_id
				? [syncJob(channel.guild_id, now, { deleted: [channel.id] })]
				: [];
		}
		case "THREAD_LIST_SYNC": {
			const sync = data as { guild_id: string; threads: DiscordChannel[] };
			return chunkBySize(
				sync.threads.map((thread) => toChannelInfo(thread, sync.guild_id)),
				MAX_JOB_BYTES,
			).map((chunk) => syncJob(sync.guild_id, now, { channels: chunk }));
		}
	}
	return [];
}

/** ロールの情報のうち、Bobertが使う部分(IDと権限)だけにする */
function roleInfo(role: RoleInfo): RoleInfo {
	return { id: role.id, permissions: role.permissions };
}

/** JSONにしたときの大きさで、配列を分ける。1つだけで目安を超えるものは、それだけで1つにする */
export function chunkBySize<T>(items: readonly T[], maxBytes: number): T[][] {
	const encoder = new TextEncoder();
	const result: T[][] = [];
	let current: T[] = [];
	let size = 0;
	for (const item of items) {
		const itemSize = encoder.encode(JSON.stringify(item)).length;
		if (current.length > 0 && size + itemSize > maxBytes) {
			result.push(current);
			current = [];
			size = 0;
		}
		current.push(item);
		size += itemSize;
	}
	if (current.length > 0) {
		result.push(current);
	}
	return result;
}

function syncJob(
	guildId: string,
	syncedAt: number,
	fields: Omit<ChannelSyncJob, "kind" | "guildId" | "syncedAt">,
): ChannelSyncJob {
	return { kind: "channels", guildId, syncedAt, ...fields };
}
