import type {
	APIInteractionResponse,
	APIMessage,
	APIMessageApplicationCommandInteraction,
	APIMessageComponentInteraction,
} from "discord-api-types/v10";
import { InteractionResponseType, MessageFlags } from "../discord/constants";
import type { QueueMessage } from "../queue/messages";
import { fromDiscord } from "../respond/history";

/**
 * 会話の要約(仕様: docs/spec/architecture.md「長い会話の自動要約」)。
 * 要約は長い会話で時間がかかるので、押した人(選んだ人)にだけ見える保留の応答を返し、応答用のQueueで要約する
 */

/** 要約を勧める案内の「今すぐ要約」ボタン。ボタンのあるメッセージ(Bobertの返答)までの会話を要約する */
export async function compactFromButton(
	interaction: APIMessageComponentInteraction,
	env: Env,
	userId: string,
): Promise<APIInteractionResponse> {
	return enqueueCompact(env, interaction, userId, interaction.message, true);
}

/** 右クリックメニュー(アプリ)の「会話を要約」。選んだメッセージまでの会話を要約する */
export async function compactFromMenu(
	interaction: APIMessageApplicationCommandInteraction,
	env: Env,
	userId: string,
): Promise<APIInteractionResponse> {
	const target = interaction.data.resolved.messages[interaction.data.target_id];
	if (!target) {
		throw new Error("The target message is missing from the interaction");
	}
	return enqueueCompact(env, interaction, userId, target, false);
}

async function enqueueCompact(
	env: Env,
	interaction:
		| APIMessageComponentInteraction
		| APIMessageApplicationCommandInteraction,
	userId: string,
	start: APIMessage,
	fromButton: boolean,
): Promise<APIInteractionResponse> {
	const guildId = interaction.guild_id ?? null;
	await env.RESPOND_QUEUE.send({
		kind: "compact",
		interactionToken: interaction.token,
		userId,
		channelId: start.channel_id,
		guildId,
		start: fromDiscord(start, guildId),
		buttonMessageId: fromButton ? start.id : null,
	} satisfies QueueMessage);
	return {
		type: InteractionResponseType.DeferredChannelMessageWithSource,
		data: { flags: MessageFlags.Ephemeral },
	};
}
