import type {
	APIButtonComponentWithCustomId,
	APIChatInputApplicationCommandInteraction,
	APIEmbed,
	APIInteractionResponse,
	APIMessageComponentInteraction,
	APIUser,
	RESTPostAPIChannelMessageJSONBody,
} from "discord-api-types/v10";
import {
	createFollowupMessage,
	createGuildChannel,
	createMessage,
	DiscordApiError,
	deleteChannel,
	pinMessage,
} from "../discord/api";
import {
	ButtonStyle,
	ComponentType,
	InteractionResponseType,
	MessageFlags,
	OverwriteType,
	PermissionFlags,
} from "../discord/constants";
import { type MessageEdit, respondLater } from "../interactions/deferred";
import { logEvent } from "../log";
import { LLM_ERROR_TEXT } from "../respond/replies";
import { listSkills } from "../store/skills";
import { getUserSettings, loadCredential } from "../store/users";
import {
	agentClient,
	agentEffort,
	agentModel,
	deleteSession,
	describeAgentError,
	startSession,
} from "./managed";
import {
	AGENT_ALLOW_PREFIX,
	AGENT_DELETE_CONFIRM_ID,
	AGENT_DELETE_ID,
	AGENT_DENY_PREFIX,
	AGENT_END_CONFIRM_ID,
	AGENT_END_ID,
	AGENT_STOP_ID,
} from "./relay";
import type { EndResult } from "./session-object";
import {
	type AgentChannel,
	activeAgentChannels,
	deleteAgentChannel,
	getAgentChannel,
	insertAgentChannel,
	nextAgentNumber,
	setFirstMessage,
} from "./store";
import { agentSessionStub, gatewayStub } from "./stubs";
import {
	ALREADY_ENDED,
	agentChannelName,
	CHANNEL_LIMIT_REACHED,
	createdMessage,
	DELETE_CHANNEL_FAILED,
	DELETE_CONFIRM,
	DELETE_CONFIRM_BUTTON_LABEL,
	END_BUTTON_LABEL,
	END_CONFIRM,
	END_CONFIRM_BUTTON_LABEL,
	END_FAILED,
	ENDED,
	effortLine,
	FIRST_MESSAGE_NOTES,
	FIRST_MESSAGE_TITLE,
	firstMessageContent,
	KEY_MISSING,
	modelLine,
	NO_MANAGE_CHANNELS,
	NOT_AGENT_CHANNEL,
	OPERATION_FAILED,
	OWNER_ONLY_BUTTON,
	OWNER_ONLY_END,
	startFailed,
	tooManySessions,
} from "./texts";

/** 1人が1つのサーバーで持てる、終えていないセッションの数 */
export const MAX_ACTIVE_SESSIONS = 3;

/** Discordのエラーコード: 権限が足りない、サーバーのチャンネルが上限 */
const MISSING_PERMISSIONS = 50013;
const MAX_GUILD_CHANNELS = 30013;

/** チャンネルで、本人とBobertに付ける権限(見る、書く、履歴を読む) */
const MEMBER_ALLOW =
	PermissionFlags.ViewChannel |
	PermissionFlags.SendMessages |
	PermissionFlags.ReadMessageHistory;

/**
 * /agent: 本人専用のチャンネルを作り、Managed Agentsのセッションを始める(仕様: docs/spec/behavior.md「エージェント」)。
 * 時間がかかるので、本人にだけ見える保留の応答を返してから続ける
 */
export function agentCommand(
	interaction: APIChatInputApplicationCommandInteraction,
	env: Env,
	ctx: ExecutionContext,
	user: APIUser,
	guildId: string,
): APIInteractionResponse {
	return respondLater(
		ctx,
		interaction,
		user.id,
		"reply",
		() => startAgent(interaction, env, user, guildId),
		{ content: startFailed(LLM_ERROR_TEXT), components: [] },
	);
}

async function startAgent(
	interaction: APIChatInputApplicationCommandInteraction,
	env: Env,
	user: APIUser,
	guildId: string,
): Promise<MessageEdit> {
	const db = env.DB;
	const credential = await loadCredential(env, user.id, "anthropic");
	if (credential === null) {
		return { content: KEY_MISSING };
	}
	const active = await activeAgentChannels(db, guildId, user.id);
	if (active.length >= MAX_ACTIVE_SESSIONS) {
		return {
			content: tooManySessions(active.map((channel) => channel.channelId)),
		};
	}
	const permissions = BigInt(interaction.app_permissions ?? "0");
	if (!hasPermission(permissions, PermissionFlags.ManageChannels)) {
		return { content: NO_MANAGE_CHANNELS };
	}

	const settings = await getUserSettings(db, user.id);
	const model = agentModel(settings);
	const effort = agentEffort(settings);
	const number = await nextAgentNumber(db, guildId, user.id);
	const name = agentChannelName(user.username, number);
	const client = agentClient(credential);
	let sessionId: string;
	try {
		const skills = await listSkills(db, guildId);
		sessionId = await startSession(db, user.id, client, {
			skills,
			model,
			effort,
			title: `#${name}`,
		});
	} catch (error) {
		log("session_start_failed", user.id, error);
		return { content: startFailed(describeAgentError(error, model)) };
	}

	let channelId: string;
	try {
		const channel = await createGuildChannel(env.DISCORD_BOT_TOKEN, guildId, {
			name,
			type: 0,
			permission_overwrites: [
				{
					id: guildId,
					type: OverwriteType.Role,
					deny: String(PermissionFlags.ViewChannel),
				},
				{
					id: user.id,
					type: OverwriteType.Member,
					allow: String(MEMBER_ALLOW),
				},
				{
					id: interaction.application_id,
					type: OverwriteType.Member,
					allow: String(MEMBER_ALLOW),
				},
			],
		});
		channelId = channel.id;
	} catch (error) {
		await deleteSession(client, sessionId).catch((cleanup: unknown) => {
			log("session_cleanup_failed", user.id, cleanup);
		});
		if (error instanceof DiscordApiError) {
			if (error.code === MISSING_PERMISSIONS) {
				return { content: NO_MANAGE_CHANNELS };
			}
			if (error.code === MAX_GUILD_CHANNELS) {
				return { content: CHANNEL_LIMIT_REACHED };
			}
		}
		throw error;
	}

	try {
		await insertAgentChannel(db, {
			channelId,
			guildId,
			ownerId: user.id,
			number,
			sessionId,
			createdAt: Date.now(),
		});
		await agentSessionStub(env, channelId).setup({
			channelId,
			guildId,
			ownerId: user.id,
			sessionId,
			model,
		});
		await gatewayStub(env)
			.addAgentChannel(channelId, guildId, user.id)
			.catch((error: unknown) => {
				// Gatewayは、記録を定期的に読み直すので、知らせられなくても、いずれ本人の発言を送り始める
				log("gateway_notify_failed", user.id, error);
			});
		const first = await createMessage(
			env.DISCORD_BOT_TOKEN,
			channelId,
			firstMessage(
				user.id,
				model.label,
				effort,
				hasPermission(permissions, PermissionFlags.EmbedLinks),
			),
		);
		await setFirstMessage(db, channelId, first.id);
		// ピン留めには、メッセージの管理の権限が要る。なければ、ピン留めしないまま使う
		await pinMessage(env.DISCORD_BOT_TOKEN, channelId, first.id).catch(
			(error: unknown) => {
				log("pin_failed", user.id, error);
			},
		);
	} catch (error) {
		// 途中で失敗したら、作ったチャンネルとセッションを消す
		await deleteChannel(env.DISCORD_BOT_TOKEN, channelId).catch(() => {});
		await deleteSession(client, sessionId).catch(() => {});
		await deleteAgentChannel(db, channelId).catch(() => {});
		throw error;
	}
	logEvent("agent", "session_started", {
		userId: user.id,
		model: model.id,
		effort,
	});
	return { content: createdMessage(channelId) };
}

/** 管理者か、その権限を持っているか */
function hasPermission(permissions: bigint, flag: bigint): boolean {
	return (
		(permissions & PermissionFlags.Administrator) !== 0n ||
		(permissions & flag) !== 0n
	);
}

/** チャンネルの最初のメッセージ。埋め込みリンクの権限がなければ、同じ内容を普通の文で書く */
export function firstMessage(
	ownerId: string,
	modelLabel: string,
	effort: string,
	embed: boolean,
): RESTPostAPIChannelMessageJSONBody {
	const details = [
		modelLine(modelLabel),
		effortLine(effort),
		"",
		...FIRST_MESSAGE_NOTES.map((note) => `- ${note}`),
	].join("\n");
	const content = firstMessageContent(ownerId);
	const embeds: APIEmbed[] = [
		{ title: FIRST_MESSAGE_TITLE, description: details },
	];
	return {
		content: embed
			? content
			: `${content}\n\n**${FIRST_MESSAGE_TITLE}**\n${details}`,
		...(embed ? { embeds } : {}),
		components: [
			{
				type: ComponentType.ActionRow,
				components: [
					{
						type: ComponentType.Button,
						style: ButtonStyle.Secondary,
						label: END_BUTTON_LABEL,
						custom_id: AGENT_END_ID,
					},
				],
			},
		],
		allowed_mentions: { users: [ownerId] },
	};
}

/** /endagent: エージェントのチャンネルの中で、セッションを終える確認を出す */
export async function endagentCommand(
	env: Env,
	channelId: string | undefined,
	userId: string,
): Promise<APIInteractionResponse> {
	const channel =
		channelId === undefined ? null : await getAgentChannel(env.DB, channelId);
	if (channel === null) {
		return ephemeral(NOT_AGENT_CHANNEL);
	}
	if (channel.ownerId !== userId) {
		return ephemeral(OWNER_ONLY_END);
	}
	return endConfirmation(channel);
}

/** エージェントのボタン。エージェントのボタンでなければnull */
export async function agentComponent(
	interaction: APIMessageComponentInteraction,
	env: Env,
	ctx: ExecutionContext,
	userId: string,
): Promise<APIInteractionResponse | null> {
	const customId = interaction.data.custom_id;
	if (!customId.startsWith("agent:")) {
		return null;
	}
	const channelId = interaction.channel?.id ?? interaction.channel_id;
	const channel =
		channelId === undefined ? null : await getAgentChannel(env.DB, channelId);
	if (channel === null) {
		// 記録がない(チャンネルが消えかけているなど)。何もしない
		return { type: InteractionResponseType.DeferredMessageUpdate };
	}
	if (channel.ownerId !== userId) {
		return ephemeral(OWNER_ONLY_BUTTON);
	}
	const stub = agentSessionStub(env, channel.channelId);
	if (customId === AGENT_END_ID) {
		return endConfirmation(channel);
	}
	if (customId === AGENT_END_CONFIRM_ID) {
		return respondLater(
			ctx,
			interaction,
			userId,
			"update",
			async () => ({
				content: endResultText(await stub.end()),
				components: [],
			}),
			{ content: END_FAILED, components: [] },
		);
	}
	if (customId === AGENT_DELETE_ID) {
		return ephemeral(DELETE_CONFIRM, [
			{
				type: ComponentType.Button,
				style: ButtonStyle.Danger,
				label: DELETE_CONFIRM_BUTTON_LABEL,
				custom_id: AGENT_DELETE_CONFIRM_ID,
			},
		]);
	}
	if (customId === AGENT_DELETE_CONFIRM_ID) {
		return respondLater(
			ctx,
			interaction,
			userId,
			"update",
			async () => {
				await deleteChannel(env.DISCORD_BOT_TOKEN, channel.channelId);
				// チャンネルが消えた通知を待たずに、セッションと記録を片付ける
				await stub.channelDeleted();
				await gatewayStub(env)
					.removeAgentChannel(channel.channelId)
					.catch(() => {});
				// チャンネルと一緒に、この確認も消える
				return { components: [] };
			},
			{ content: DELETE_CHANNEL_FAILED, components: [] },
		);
	}
	if (customId === AGENT_STOP_ID) {
		ctx.waitUntil(
			reportFailure(interaction, () => stub.stop(), channel.ownerId),
		);
		return { type: InteractionResponseType.DeferredMessageUpdate };
	}
	const allow = customId.startsWith(AGENT_ALLOW_PREFIX);
	if (allow || customId.startsWith(AGENT_DENY_PREFIX)) {
		const eventId = customId.slice(
			(allow ? AGENT_ALLOW_PREFIX : AGENT_DENY_PREFIX).length,
		);
		ctx.waitUntil(
			reportFailure(
				interaction,
				() => stub.answer(eventId, allow),
				channel.ownerId,
			),
		);
		return { type: InteractionResponseType.DeferredMessageUpdate };
	}
	return null;
}

/** ボタンの操作をセッションに伝え、伝えられなければ、本人にだけ見える文で知らせる */
async function reportFailure(
	interaction: APIMessageComponentInteraction,
	work: () => Promise<"ok" | "stale" | "failed">,
	userId: string,
): Promise<void> {
	let result: "ok" | "stale" | "failed";
	try {
		result = await work();
	} catch (error) {
		log("button_failed", userId, error);
		result = "failed";
	}
	if (result === "failed") {
		await createFollowupMessage(interaction.application_id, interaction.token, {
			content: OPERATION_FAILED,
			flags: MessageFlags.Ephemeral,
		}).catch(() => {});
	}
}

function endConfirmation(channel: AgentChannel): APIInteractionResponse {
	if (channel.sessionId === null) {
		return ephemeral(ALREADY_ENDED);
	}
	return ephemeral(END_CONFIRM, [
		{
			type: ComponentType.Button,
			style: ButtonStyle.Danger,
			label: END_CONFIRM_BUTTON_LABEL,
			custom_id: AGENT_END_CONFIRM_ID,
		},
	]);
}

function endResultText(result: EndResult): string {
	switch (result) {
		case "ended":
			return ENDED;
		case "already":
			return ALREADY_ENDED;
		case "failed":
			return END_FAILED;
	}
}

function ephemeral(
	content: string,
	buttons: APIButtonComponentWithCustomId[] = [],
): APIInteractionResponse {
	return {
		type: InteractionResponseType.ChannelMessageWithSource,
		data: {
			flags: MessageFlags.Ephemeral,
			content,
			...(buttons.length > 0
				? {
						components: [
							{ type: ComponentType.ActionRow, components: buttons },
						],
					}
				: {}),
		},
	};
}

function log(event: string, userId: string, error: unknown): void {
	logEvent("agent", event, {
		userId,
		error: error instanceof Error ? error.message : String(error),
	});
}
