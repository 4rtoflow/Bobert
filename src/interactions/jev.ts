import type {
	APIInteractionResponse,
	APIMessageApplicationCommandInteraction,
	APIUser,
} from "discord-api-types/v10";
import { InteractionResponseType, MessageFlags } from "../discord/constants";
import { TYPESAFE_KEY_REQUIRED } from "../jev/texts";
import type { QueueMessage } from "../queue/messages";
import { fromDiscord } from "../respond/history";
import { resolvePaidModel } from "../respond/payer";
import { hasTypeSafeKey } from "../store/typesafe";
import { getUserSettings } from "../store/users";

/**
 * 右クリックメニューの「Jevに聞く」(仕様: docs/spec/behavior.md「スラッシュコマンド」の右クリックメニュー)。
 * AIのキーを登録しておらず、サーバーに使える寄付もなければ、登録方法を本人にだけ見せる。
 * TypeSafeのキーを登録していなければ、その登録方法を本人にだけ見せる(Jevの費用は、寄付では払わないため)。
 * 使えれば、チャンネルに見える保留の応答を返し、応答用のQueueでJevに聞く。
 * 寄付した人がサーバーにいるかは、3秒以内に応答するため、ここでは確かめず、聞くときに確かめる
 */
export async function jevFromMenu(
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
		return ephemeral(paid.guidance);
	}
	if (!(await hasTypeSafeKey(env.DB, user.id))) {
		return ephemeral(TYPESAFE_KEY_REQUIRED);
	}
	const target = interaction.data.resolved.messages[interaction.data.target_id];
	if (!target) {
		throw new Error("The target message is missing from the interaction");
	}
	await env.RESPOND_QUEUE.send({
		kind: "jev",
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

/** 本人にだけ見せる応答(コマンドのエラーは、本人にだけ見せる仕様のため) */
function ephemeral(content: string): APIInteractionResponse {
	return {
		type: InteractionResponseType.ChannelMessageWithSource,
		data: { content, flags: MessageFlags.Ephemeral },
	};
}
