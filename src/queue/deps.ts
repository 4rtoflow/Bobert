import { fetchChannelInfo, fetchGuildRoles } from "../discord/channels";
import { workersAiEmbedder } from "../store/embedding";
import type { IngestDeps } from "./ingest";

/** 保存とベクトル化、チャンネルの記録に使うもの(本物のD1、Vectorize、Workers AI、DiscordのAPI) */
export function ingestDeps(env: Env): IngestDeps {
	const token = env.DISCORD_BOT_TOKEN;
	// BotのユーザーIDは、アプリケーションのIDと同じ
	const botUserId = env.DISCORD_APPLICATION_ID;
	return {
		db: env.DB,
		vectors: env.VECTORIZE,
		embed: workersAiEmbedder(env.AI),
		botUserId,
		fetchChannel: (channelId, guildId) =>
			fetchChannelInfo(token, channelId, guildId),
		fetchGuildRoles: (guildId) => fetchGuildRoles(token, guildId, botUserId),
	};
}
