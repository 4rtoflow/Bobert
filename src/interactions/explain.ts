import type {
	APIInteractionResponse,
	APIMessageApplicationCommandInteraction,
	APIUser,
} from "discord-api-types/v10";
import { InteractionResponseType, MessageFlags } from "../discord/constants";
import type { QueueMessage } from "../queue/messages";
import { fromDiscord } from "../respond/history";
import { resolvePaidModel } from "../respond/payer";
import { getUserSettings } from "../store/users";

/** 右クリックメニュー(アプリ)の、メッセージの意味を聞く項目の名前 */
export const EXPLAIN_COMMAND_NAME = "Bobertに聞く";

/**
 * 右クリックメニューの「Bobertに聞く」(仕様: docs/spec/behavior.md「スラッシュコマンド」の右クリックメニュー)。
 * キーを登録しておらず、サーバーに使える寄付もなければ、登録方法を本人にだけ見せる(コマンドのエラーは本人にだけ見せる仕様のため)。
 * 使えれば、チャンネルに見える保留の応答を返し、応答用のQueueで説明してもらう。
 * 寄付した人がサーバーにいるかは、3秒以内に応答するため、ここでは確かめず、説明するときに確かめる
 */
export async function explainFromMenu(
	interaction: APIMessageApplicationCommandInteraction,
	env: Env,
	user: APIUser,
): Promise<APIInteractionResponse> {
	const guildId = interaction.guild_id ?? null;
	const paid = await resolvePaidModel(env, {
		userId: user.id,
		guildId,
		settings: await getUserSettings(env.DB, user.id),
		checkMembership: false,
	});
	if (!paid.ok) {
		return {
			type: InteractionResponseType.ChannelMessageWithSource,
			data: { content: paid.guidance, flags: MessageFlags.Ephemeral },
		};
	}
	const target = interaction.data.resolved.messages[interaction.data.target_id];
	if (!target) {
		throw new Error("The target message is missing from the interaction");
	}
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
