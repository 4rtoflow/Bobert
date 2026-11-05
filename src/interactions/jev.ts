import type {
	APIChatInputApplicationCommandInteraction,
	APIInteractionResponse,
	APIMessageApplicationCommandInteraction,
	APIUser,
} from "discord-api-types/v10";
import {
	ApplicationCommandOptionType,
	InteractionResponseType,
	MessageFlags,
} from "../discord/constants";
import {
	JEV_QUESTION_MAX_LENGTH,
	JEV_QUESTION_OPTION,
	type JevSource,
	typeSafeKeyRequired,
} from "../jev/texts";
import type { QueueMessage, StoredMessageInput } from "../queue/messages";
import { fromDiscord } from "../respond/history";
import { resolvePaidModel } from "../respond/payer";
import { hasTypeSafeKey } from "../store/typesafe";
import { getUserSettings } from "../store/users";

/** InteractionのうちJevの仕事に要るもの(右クリックメニューと`/jev`で共通) */
type JevInteraction =
	| APIMessageApplicationCommandInteraction
	| APIChatInputApplicationCommandInteraction;

/**
 * 右クリックメニューの「Jevに聞く」(仕様: docs/spec/behavior.md「スラッシュコマンド」の右クリックメニュー)。
 * 選んだメッセージを、Jevに聞く対象にする
 */
export async function jevFromMenu(
	interaction: APIMessageApplicationCommandInteraction,
	env: Env,
	user: APIUser,
): Promise<APIInteractionResponse> {
	const target = interaction.data.resolved.messages[interaction.data.target_id];
	if (!target) {
		throw new Error("The target message is missing from the interaction");
	}
	const guildId = interaction.guild_id ?? null;
	return startJev(env, interaction, user, "menu", () =>
		fromDiscord(target, guildId),
	);
}

/**
 * `/jev`(仕様: docs/spec/behavior.md「スラッシュコマンド」)。
 * 入力された「聞くこと」を、使った人の発言にして、右クリックメニューのときと同じくJevに聞く対象にする
 */
export async function jevFromCommand(
	interaction: APIChatInputApplicationCommandInteraction,
	env: Env,
	user: APIUser,
): Promise<APIInteractionResponse> {
	const question = questionOf(interaction);
	const guildId = interaction.guild_id ?? null;
	const channelId = interaction.channel?.id ?? interaction.channel_id;
	if (channelId === undefined) {
		throw new Error("The channel is missing from the interaction");
	}
	return startJev(
		env,
		interaction,
		user,
		"command",
		(): StoredMessageInput => ({
			// Discordにはないメッセージなので、ほかのメッセージと重ならないIDにする
			messageId: `jev-command:${interaction.id}`,
			guildId,
			channelId,
			authorId: user.id,
			authorName: displayName(interaction, user),
			authorIsBot: false,
			content: question,
			replyToId: null,
			mentions: [],
			attachments: [],
			embeds: [],
			command: null,
			members: [],
			createdAt: Date.now(),
			editedAt: null,
		}),
	);
}

/**
 * Jevに聞く仕事を始める。AIのキーを登録しておらず、サーバーに使える寄付もなければ、登録方法を本人にだけ見せる。
 * TypeSafeのキーを登録していなければ、その登録方法を本人にだけ見せる(Jevの費用は、寄付では払わないため)。
 * 使えれば、チャンネルに見える保留の応答を返し、応答用のQueueでJevに聞く。
 * 寄付した人がサーバーにいるかは、3秒以内に応答するため、ここでは確かめず、聞くときに確かめる
 */
async function startJev(
	env: Env,
	interaction: JevInteraction,
	user: APIUser,
	source: JevSource,
	target: () => StoredMessageInput,
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
		return ephemeral(typeSafeKeyRequired(source));
	}
	const message = target();
	await env.RESPOND_QUEUE.send({
		kind: "jev",
		source,
		interactionId: interaction.id,
		interactionToken: interaction.token,
		userId: user.id,
		userName: displayName(interaction, user),
		channelId: message.channelId,
		guildId,
		target: message,
		requestedAt: Date.now(),
	} satisfies QueueMessage);
	return { type: InteractionResponseType.DeferredChannelMessageWithSource };
}

/** 使った人の、サーバーで見えている名前。Interactionには、使った人のサーバーでの情報が付いている */
function displayName(interaction: JevInteraction, user: APIUser): string {
	return interaction.member?.nick ?? user.global_name ?? user.username;
}

/** `/jev`で入力された「聞くこと」。長さはDiscordが守るが、念のため上限で切り詰める */
function questionOf(
	interaction: APIChatInputApplicationCommandInteraction,
): string {
	const option = interaction.data.options?.find(
		(candidate) => candidate.name === JEV_QUESTION_OPTION,
	);
	if (option?.type !== ApplicationCommandOptionType.String) {
		throw new Error("The question option is missing from the interaction");
	}
	return option.value.trim().slice(0, JEV_QUESTION_MAX_LENGTH);
}

/** 本人にだけ見せる応答(コマンドのエラーは、本人にだけ見せる仕様のため) */
function ephemeral(content: string): APIInteractionResponse {
	return {
		type: InteractionResponseType.ChannelMessageWithSource,
		data: { content, flags: MessageFlags.Ephemeral },
	};
}
