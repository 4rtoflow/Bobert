import { fetchChannelInfo, fetchGuildRoles } from "../discord/channels";
import { discordProgressApi } from "../knowledge/progress";
import { workersAiEmbedder } from "../store/embedding";
import type { IngestDeps } from "./ingest";
import type { QueueMessage } from "./messages";

/**
 * 届いたばかりの音声メッセージを文字にする仕事を、Queueに入れてから始めるまでの時間(秒)。
 * Bobertへの返信なら、返答の処理が先に文字にするので、それを待って、二重に文字にしないようにする
 */
const TRANSCRIBE_DELAY_SECONDS = 60;

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
		knowledgeFiles: env.KNOWLEDGE_FILES,
		// 文字にするのに時間がかかることがあるので、1件ずつ処理するRESPOND_QUEUEで運ぶ
		transcribeLater: async (targets) => {
			// Queueに1回で入れられるのは、100件まで
			for (let i = 0; i < targets.length; i += 100) {
				await env.RESPOND_QUEUE.sendBatch(
					targets.slice(i, i + 100).map((target) => ({
						body: { kind: "transcribe", ...target } satisfies QueueMessage,
						delaySeconds: TRANSCRIBE_DELAY_SECONDS,
					})),
				);
			}
		},
		// 知識チャンネルに送られたファイルは、届いてすぐに読む(DiscordのファイルのURLは期限付きのため)
		knowledgeLater: async (jobs) => {
			// Queueに1回で入れられるのは、100件まで
			for (let i = 0; i < jobs.length; i += 100) {
				await env.RESPOND_QUEUE.sendBatch(
					jobs.slice(i, i + 100).map((job) => ({
						body: job satisfies QueueMessage,
					})),
				);
			}
		},
		knowledgeProgress: discordProgressApi(token),
	};
}
