import type {
	APIInteractionResponse,
	APIMessageApplicationCommandInteraction,
	APIUser,
} from "discord-api-types/v10";
import { InteractionResponseType, MessageFlags } from "../discord/constants";
import type { QueueMessage } from "../queue/messages";
import { fromDiscord } from "../respond/history";
import { resolveModel } from "../respond/model";
import { setupGuidance } from "../respond/replies";
import { getRegisteredProviders, getUserSettings } from "../store/users";

/** 右クリックメニュー(アプリ)の、メッセージの意味を聞く項目の名前 */
export const EXPLAIN_COMMAND_NAME = "Bobertに聞く";

/**
 * 右クリックメニューの「Bobertに聞く」(仕様: docs/spec/behavior.md「スラッシュコマンド」の右クリックメニュー)。
 * キーを登録していなければ、登録方法を本人にだけ見せる(コマンドのエラーは本人にだけ見せる仕様のため)。
 * 登録していれば、チャンネルに見える保留の応答を返し、応答用のQueueで説明してもらう
 */
export async function explainFromMenu(
	interaction: APIMessageApplicationCommandInteraction,
	env: Env,
	user: APIUser,
): Promise<APIInteractionResponse> {
	const [providers, settings] = await Promise.all([
		getRegisteredProviders(env.DB, user.id),
		getUserSettings(env.DB, user.id),
	]);
	const resolution = resolveModel(settings, providers);
	if (!resolution.ok) {
		return {
			type: InteractionResponseType.ChannelMessageWithSource,
			data: {
				content: setupGuidance(resolution),
				flags: MessageFlags.Ephemeral,
			},
		};
	}
	const target = interaction.data.resolved.messages[interaction.data.target_id];
	if (!target) {
		throw new Error("The target message is missing from the interaction");
	}
	const guildId = interaction.guild_id ?? null;
	await env.RESPOND_QUEUE.send({
		kind: "explain",
		interactionId: interaction.id,
		interactionToken: interaction.token,
		userId: user.id,
		// サーバーで見えている名前。Interactionには、選んだ人のサーバーでの情報が付いている
		userName: interaction.member?.nick ?? user.global_name ?? user.username,
		channelId: target.channel_id,
		guildId,
		target: fromDiscord(target, guildId),
		requestedAt: Date.now(),
	} satisfies QueueMessage);
	return { type: InteractionResponseType.DeferredChannelMessageWithSource };
}
