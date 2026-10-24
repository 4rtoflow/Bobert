import type {
	APIInteraction,
	APIInteractionResponse,
} from "discord-api-types/v10";
import {
	ComponentType,
	InteractionResponseType,
	InteractionType,
	MessageFlags,
} from "../discord/constants";
import { confirmDelete, DELETE_CONFIRM_ID, deleteCommand } from "./delete";
import { EFFORT_SELECT_ID, effortCommand, selectEffort } from "./effort";
import {
	MODEL_CUSTOM_ID,
	MODEL_SELECT_ID,
	modelCommand,
	selectModel,
	submitCustomModel,
} from "./model";
import {
	anthropicKeyModal,
	SETUP_ANTHROPIC_ID,
	setupCommand,
	submitAnthropicKey,
} from "./setup";
import { verifyDiscordRequest } from "./verify";

/**
 * Discord Interactions(スラッシュコマンド、ボタン、モーダル)の受け口。
 * 最初の応答は3秒以内に返す必要がある。時間のかかる処理は、保留の応答を返してから続ける。
 *
 * これから実装すること(仕様: docs/spec/behavior.md「スラッシュコマンド」):
 * /feat、/prompt、/settings、/compact、/help と、
 * 右クリックメニューの「Bobertに聞く」
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
	// OpenRouterのOAuthのコールバック先に、このWorkerのURLを使う
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
	switch (interaction.type) {
		case InteractionType.ApplicationCommand:
			if (interaction.data.name === "setup") {
				return setupCommand(env, origin, user);
			}
			if (interaction.data.name === "model") {
				return modelCommand(env, user.id);
			}
			if (interaction.data.name === "effort") {
				return effortCommand(interaction, env, ctx, user.id);
			}
			if (interaction.data.name === "delete") {
				return deleteCommand();
			}
			break;
		case InteractionType.MessageComponent:
			if (interaction.data.custom_id === SETUP_ANTHROPIC_ID) {
				return anthropicKeyModal();
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
				return confirmDelete(env, user.id);
			}
			break;
		case InteractionType.ModalSubmit:
			if (interaction.data.custom_id === SETUP_ANTHROPIC_ID) {
				return submitAnthropicKey(interaction, env, ctx, user.id);
			}
			if (interaction.data.custom_id === MODEL_CUSTOM_ID) {
				return submitCustomModel(interaction, env, ctx, user.id);
			}
			break;
	}
	return notReady();
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
