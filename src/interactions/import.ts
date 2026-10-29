import type {
	APIApplicationCommandInteraction,
	APIInteractionResponse,
} from "discord-api-types/v10";
import { InteractionResponseType } from "../discord/constants";
import type { QueueMessage } from "../queue/messages";

/**
 * `/import`(仕様: docs/spec/architecture.md「過去ログの取り込み」)。共有チャンネルの過去ログの取り込みを、応答用のQueueで始める。
 * 進み具合は、実行したチャンネルの全員に見える保留の応答で見せる。
 * 実行した人にだけ見えるメッセージは、実行から15分までしか書き換えられず、取り込みは15分を超えることがあるため。
 * 実行できる人は、コマンドの権限の既定(サーバー管理)で決める
 */
export async function importCommand(
	interaction: APIApplicationCommandInteraction,
	env: Env,
	guildId: string,
	userId: string,
): Promise<APIInteractionResponse> {
	await env.RESPOND_QUEUE.send({
		kind: "import_command",
		interactionId: interaction.id,
		interactionToken: interaction.token,
		guildId,
		channelId: interaction.channel?.id ?? interaction.channel_id ?? "",
		userId,
		requestedAt: Date.now(),
	} satisfies QueueMessage);
	return { type: InteractionResponseType.DeferredChannelMessageWithSource };
}
