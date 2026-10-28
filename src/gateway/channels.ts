import {
	type DiscordChannel,
	everyonePermissionsOf,
	isThreadType,
	toChannelInfo,
} from "../discord/channels";
import type { ChannelSyncJob } from "../queue/messages";

/** 1つの仕事に入れるチャンネルの数。Queuesの1件の大きさの上限(128KB)に収めるため */
const CHANNELS_PER_JOB = 200;

/** サーバーの情報(GUILD_CREATE)のうち、Bobertが使う部分 */
interface GatewayGuild {
	id: string;
	unavailable?: boolean;
	roles?: { id: string; permissions: string }[];
	channels?: DiscordChannel[];
	threads?: DiscordChannel[];
}

/**
 * チャンネル・スレッド・ロールの通知を、記録の仕事にする(仕様: docs/spec/architecture.md「サーバー全体の公開チャンネル」)。
 * 関係のない通知なら、空の配列を返す。nowは、通知を受け取った時刻
 */
export function channelSyncJobs(
	event: string,
	data: unknown,
	now: number,
): ChannelSyncJob[] {
	switch (event) {
		case "GUILD_CREATE": {
			const guild = data as GatewayGuild;
			if (guild.unavailable) {
				return [];
			}
			const channels = guild.channels ?? [];
			const everyone = everyonePermissionsOf(guild.roles ?? [], guild.id);
			const infos = [...channels, ...(guild.threads ?? [])].map((channel) =>
				toChannelInfo(channel, guild.id),
			);
			const jobs: ChannelSyncJob[] = [];
			for (let i = 0; i < infos.length; i += CHANNELS_PER_JOB) {
				jobs.push(
					syncJob(guild.id, now, {
						channels: infos.slice(i, i + CHANNELS_PER_JOB),
					}),
				);
			}
			// サーバーの全チャンネルの一覧は、最後の仕事に入れる。保存してあるのに一覧にないものは、削除されたとみなす
			jobs.push(
				syncJob(guild.id, now, {
					...(everyone === null ? {} : { everyonePermissions: everyone }),
					allChannelIds: channels
						.filter((channel) => !isThreadType(channel.type))
						.map((channel) => channel.id),
				}),
			);
			return jobs;
		}
		case "GUILD_ROLE_UPDATE": {
			const { guild_id: guildId, role } = data as {
				guild_id: string;
				role: { id: string; permissions: string };
			};
			// @everyoneのロールのIDは、サーバーのIDと同じ
			return role.id === guildId
				? [syncJob(guildId, now, { everyonePermissions: role.permissions })]
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
			return [
				syncJob(sync.guild_id, now, {
					channels: sync.threads.map((thread) =>
						toChannelInfo(thread, sync.guild_id),
					),
				}),
			];
		}
	}
	return [];
}

function syncJob(
	guildId: string,
	syncedAt: number,
	fields: Omit<ChannelSyncJob, "kind" | "guildId" | "syncedAt">,
): ChannelSyncJob {
	return { kind: "channels", guildId, syncedAt, ...fields };
}
