import type {
	APIApplicationCommandAutocompleteInteraction,
	APIChatInputApplicationCommandInteraction,
	APIInteraction,
	APIInteractionResponse,
	APIMessageApplicationCommandInteraction,
} from "discord-api-types/v10";
import {
	agentAutocomplete,
	agentCommand,
	agentComponent,
	endagentCommand,
} from "../agent/interactions";
import { getAgentChannel } from "../agent/store";
import {
	AGENT_COMMAND_NAME,
	COMPACT_UNAVAILABLE,
	ENDAGENT_COMMAND_NAME,
} from "../agent/texts";
import {
	ApplicationCommandType,
	ComponentType,
	InteractionResponseType,
	InteractionType,
	MessageFlags,
} from "../discord/constants";
import { IMPORT_COMMAND_NAME } from "../import/progress";
import {
	COMPACT_BUTTON_ID,
	COMPACT_COMMAND_NAME,
} from "../respond/compact-button";
import { compactFromButton, compactFromMenu } from "./compact";
import { confirmDelete, DELETE_CONFIRM_ID, deleteCommand } from "./delete";
import {
	DONATE_GIVE_ID,
	DONATE_MODAL_ID,
	DONATE_STOP_ID,
	donateCommand,
	donationModal,
	stopDonation,
	submitDonation,
} from "./donate";
import { EFFORT_SELECT_ID, effortCommand, selectEffort } from "./effort";
import { EXPLAIN_COMMAND_NAME, explainFromMenu } from "./explain";
import { FEAT_BUTTON_PREFIX, featCommand, toggleFeature } from "./feat";
import { helpCommand } from "./help";
import { importCommand } from "./import";
import {
	MODEL_CUSTOM_ID,
	MODEL_SELECT_ID,
	modelCommand,
	selectModel,
	submitCustomModel,
} from "./model";
import { PROMPT_MODAL_ID, promptCommand, submitPrompt } from "./prompt";
import { settingsCommand } from "./settings";
import {
	anthropicKeyModal,
	SETUP_ANTHROPIC_ID,
	setupCommand,
	submitAnthropicKey,
} from "./setup";
import {
	REGSKILLS_COMMAND_NAME,
	regskillsCommand,
	SKILLS_COMMAND_NAME,
	SKILLS_ID_PREFIX,
	skillComponent,
	skillsCommand,
	submitSkillModal,
} from "./skills";
import { verifyDiscordRequest } from "./verify";

/**
 * Discord Interactions(スラッシュコマンド、右クリックメニュー、ボタン、モーダル)の受け口。
 * 最初の応答は3秒以内に返す必要がある。時間のかかる処理は、保留の応答を返してから続ける。
 */
export async function handleInteraction(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
): Promise<Response> {
	const body = await verifyDiscordRequest(request, env.DISCORD_PUBLIC_KEY);
	if (body === null) {
		return new Response("Bad request signature", { status: 401 });
	}

	const interaction = JSON.parse(body) as APIInteraction;
	if (interaction.type === InteractionType.Ping) {
		return Response.json({ type: InteractionResponseType.Pong });
	}
	// OpenRouterとGitHubのOAuthのコールバック先に、このWorkerのURLを使う
	const origin = new URL(request.url).origin;
	return Response.json(await route(interaction, env, ctx, origin));
}

async function route(
	interaction: APIInteraction,
	env: Env,
	ctx: ExecutionContext,
	origin: string,
): Promise<APIInteractionResponse> {
	const user = interaction.member?.user ?? interaction.user;
	if (!user) {
		return notReady();
	}
	// 寄付とスキルは、サーバーごと。
	// 操作した人の名前は、サーバーで見えている名前(寄付した人や、スキルを登録・編集した人として見せる)
	const guildId = interaction.guild_id;
	const actor = {
		id: user.id,
		name: interaction.member?.nick ?? user.global_name ?? user.username,
	};
	switch (interaction.type) {
		case InteractionType.ApplicationCommand:
			if (
				interaction.data.type === ApplicationCommandType.Message &&
				interaction.data.name === EXPLAIN_COMMAND_NAME
			) {
				return explainFromMenu(
					interaction as APIMessageApplicationCommandInteraction,
					env,
					user,
				);
			}
			if (
				interaction.data.type === ApplicationCommandType.Message &&
				interaction.data.name === COMPACT_COMMAND_NAME
			) {
				// エージェントのチャンネルでは、要約(D1に保存する)を作らない
				if (await isAgentChannel(env, channelIdOf(interaction))) {
					return ephemeral(COMPACT_UNAVAILABLE);
				}
				return compactFromMenu(
					interaction as APIMessageApplicationCommandInteraction,
					env,
					user.id,
				);
			}
			if (
				interaction.data.type === ApplicationCommandType.ChatInput &&
				interaction.data.name === AGENT_COMMAND_NAME &&
				guildId
			) {
				return agentCommand(
					interaction as APIChatInputApplicationCommandInteraction,
					env,
					ctx,
					user,
					guildId,
				);
			}
			if (interaction.data.name === ENDAGENT_COMMAND_NAME) {
				return endagentCommand(env, channelIdOf(interaction), user.id);
			}
			if (interaction.data.name === "setup") {
				return setupCommand(env, origin, user, interaction.token);
			}
			if (interaction.data.name === "model") {
				return modelCommand(env, user.id);
			}
			if (interaction.data.name === "effort") {
				return effortCommand(interaction, env, ctx, user.id);
			}
			if (interaction.data.name === "feat") {
				return featCommand(env, user.id);
			}
			if (interaction.data.name === "prompt") {
				return promptCommand(env, user.id);
			}
			if (interaction.data.name === SKILLS_COMMAND_NAME && guildId) {
				return skillsCommand(env, guildId);
			}
			if (
				interaction.data.type === ApplicationCommandType.ChatInput &&
				interaction.data.name === REGSKILLS_COMMAND_NAME &&
				guildId
			) {
				return regskillsCommand(
					interaction as APIChatInputApplicationCommandInteraction,
					env,
					ctx,
					guildId,
					actor,
				);
			}
			if (interaction.data.name === "settings") {
				return settingsCommand(interaction, env, ctx, user.id);
			}
			if (interaction.data.name === "donate" && guildId) {
				return donateCommand(env, guildId, actor);
			}
			if (interaction.data.name === IMPORT_COMMAND_NAME && guildId) {
				return importCommand(interaction, env, guildId, user.id);
			}
			if (interaction.data.name === "delete") {
				return deleteCommand(env, user.id);
			}
			if (interaction.data.name === "help") {
				return helpCommand();
			}
			break;
		case InteractionType.ApplicationCommandAutocomplete:
			// 入力の候補を出すのは、/agent の repository の欄だけ
			if (interaction.data.name === AGENT_COMMAND_NAME) {
				return agentAutocomplete(
					interaction as APIApplicationCommandAutocompleteInteraction,
					env,
					user.id,
				);
			}
			return {
				type: InteractionResponseType.ApplicationCommandAutocompleteResult,
				data: { choices: [] },
			};
		case InteractionType.MessageComponent: {
			const agentResponse = await agentComponent(
				interaction,
				env,
				ctx,
				user.id,
				origin,
			);
			if (agentResponse) {
				return agentResponse;
			}
			if (interaction.data.custom_id === COMPACT_BUTTON_ID) {
				return compactFromButton(interaction, env, user.id);
			}
			if (interaction.data.custom_id === SETUP_ANTHROPIC_ID) {
				return anthropicKeyModal();
			}
			if (interaction.data.custom_id.startsWith(FEAT_BUTTON_PREFIX)) {
				const toggled = await toggleFeature(
					env,
					user.id,
					interaction.data.custom_id,
				);
				if (toggled) {
					return toggled;
				}
			}
			if (interaction.data.custom_id.startsWith(SKILLS_ID_PREFIX) && guildId) {
				const response = await skillComponent(
					interaction,
					env,
					ctx,
					guildId,
					actor,
				);
				if (response) {
					return response;
				}
			}
			if (interaction.data.component_type === ComponentType.StringSelect) {
				const value = interaction.data.values[0] ?? "";
				if (interaction.data.custom_id === MODEL_SELECT_ID) {
					return selectModel(interaction, env, ctx, user.id, value);
				}
				if (interaction.data.custom_id === EFFORT_SELECT_ID) {
					return selectEffort(interaction, env, ctx, user.id, value);
				}
			}
			if (interaction.data.custom_id === DELETE_CONFIRM_ID) {
				return confirmDelete(env, ctx, user.id);
			}
			if (interaction.data.custom_id === DONATE_GIVE_ID) {
				return donationModal(env, user.id);
			}
			if (interaction.data.custom_id === DONATE_STOP_ID && guildId) {
				return stopDonation(env, guildId, actor);
			}
			break;
		}
		case InteractionType.ModalSubmit:
			if (interaction.data.custom_id === SETUP_ANTHROPIC_ID) {
				return submitAnthropicKey(interaction, env, ctx, user.id);
			}
			if (interaction.data.custom_id === MODEL_CUSTOM_ID) {
				return submitCustomModel(interaction, env, ctx, user.id);
			}
			if (interaction.data.custom_id === PROMPT_MODAL_ID) {
				return submitPrompt(interaction, env, user.id);
			}
			if (interaction.data.custom_id === DONATE_MODAL_ID && guildId) {
				return submitDonation(interaction, env, guildId, actor);
			}
			if (interaction.data.custom_id.startsWith(SKILLS_ID_PREFIX) && guildId) {
				const response = await submitSkillModal(
					interaction,
					env,
					ctx,
					guildId,
					actor,
				);
				if (response) {
					return response;
				}
			}
			break;
	}
	return notReady();
}

/** Interactionが起きたチャンネルのID */
export function channelIdOf(interaction: APIInteraction): string | undefined {
	return interaction.channel?.id ?? interaction.channel_id;
}

async function isAgentChannel(
	env: Env,
	channelId: string | undefined,
): Promise<boolean> {
	return (
		channelId !== undefined &&
		(await getAgentChannel(env.DB, channelId)) !== null
	);
}

function ephemeral(content: string): APIInteractionResponse {
	return {
		type: InteractionResponseType.ChannelMessageWithSource,
		data: { content, flags: MessageFlags.Ephemeral },
	};
}

function notReady(): APIInteractionResponse {
	return {
		type: InteractionResponseType.ChannelMessageWithSource,
		data: {
			content: "この機能はまだ準備中です。",
			flags: MessageFlags.Ephemeral,
		},
	};
}
