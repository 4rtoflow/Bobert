import type {
	APIButtonComponent,
	APIChatInputApplicationCommandInteraction,
	APIInteractionResponse,
	APIMessageComponentInteraction,
	APIUser,
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
import {
	type AllowedRepositories,
	findAllowedRepository,
	listAllowedRepositories,
	type RepositoryLookup,
} from "../github/account";
import { type MessageEdit, respondLater } from "../interactions/deferred";
import { logEvent } from "../log";
import { createGitHubAuthLink } from "../oauth/github";
import { LLM_ERROR_TEXT } from "../respond/replies";
import { listSkills } from "../store/skills";
import {
	type Credential,
	getUserSettings,
	loadCredential,
} from "../store/users";
import { firstMessage } from "./first-message";
import {
	agentClient,
	agentEffort,
	agentModel,
	deleteSession,
	describeAgentError,
	repositoryMountPath,
	startSession,
} from "./managed";
import {
	AGENT_ALLOW_PREFIX,
	AGENT_DELETE_CONFIRM_ID,
	AGENT_DELETE_ID,
	AGENT_DENY_PREFIX,
	AGENT_END_CONFIRM_ID,
	AGENT_END_ID,
	AGENT_GITHUB_ID,
	AGENT_PR_CANCEL_PREFIX,
	AGENT_PR_CREATE_PREFIX,
	AGENT_STOP_ID,
	REPOSITORY_TOKEN_VALIDITY_MS,
	repositoryName,
} from "./relay";
import {
	AGENT_GITHUB_START_ID,
	AGENT_REPOSITORY_SELECT_ID,
	AGENT_START_PLAIN_ID,
	linkFirstMessage,
	linkOpenedComponents,
	NO_REPOSITORY_VALUE,
	repositorySelectMessage,
	startWithoutRepositoryRow,
} from "./repository-menu";
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
	CHOOSE_REPOSITORY,
	createdMessage,
	DELETE_CHANNEL_FAILED,
	DELETE_CONFIRM,
	DELETE_CONFIRM_BUTTON_LABEL,
	END_CONFIRM,
	END_CONFIRM_BUTTON_LABEL,
	END_FAILED,
	ENDED,
	GITHUB_LINK_PROMPT,
	GITHUB_LOOKUP_FAILED,
	GITHUB_OPEN_BUTTON_LABEL,
	KEY_MISSING,
	NO_MANAGE_CHANNELS,
	NOT_AGENT_CHANNEL,
	OPERATION_FAILED,
	OWNER_ONLY_BUTTON,
	OWNER_ONLY_END,
	repositoryNotUsable,
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

/** /agent の返事や、その中のボタンとセレクトメニューのInteractionのうち、セッションを始めるのに使う部分 */
interface StartContext {
	application_id: string;
	/** Bobertがそのチャンネルで持つ権限 */
	app_permissions?: string;
}

/**
 * /agent: 本人にだけ見える返事で、セッションにつなぐGitHubのリポジトリを選んでもらう(仕様: docs/spec/behavior.md「エージェント」)。
 * 連携していない人には、先に連携のボタンを出す。選んだら、本人専用のチャンネルを作り、Managed Agentsのセッションを始める。
 * GitHubを読むのに時間がかかるので、保留の応答を返してから続ける
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
		() => agentStartMenu(interaction, env, user, guildId),
		{ content: startFailed(LLM_ERROR_TEXT), components: [] },
	);
}

/**
 * /agent の返事。始められなければ(キーがない、セッションが多すぎる、権限がない)、その理由を返す。
 * 連携していれば、リポジトリを選ぶセレクトメニューを、していなければ、連携のボタンを返す
 */
async function agentStartMenu(
	context: StartContext,
	env: Env,
	user: APIUser,
	guildId: string,
): Promise<MessageEdit> {
	const checked = await precheck(env, user.id, guildId, context);
	if ("reply" in checked) {
		return checked.reply;
	}
	let allowed: AllowedRepositories;
	try {
		allowed = await listAllowedRepositories(env, user.id);
	} catch (error) {
		// GitHubとのやり取りに失敗しても、リポジトリを使わずには始められるようにする
		log("github_lookup_failed", user.id, error);
		return {
			content: GITHUB_LOOKUP_FAILED,
			components: [startWithoutRepositoryRow()],
		};
	}
	return allowed.status === "unlinked"
		? linkFirstMessage()
		: repositorySelectMessage(CHOOSE_REPOSITORY, allowed.repositories);
}

/**
 * セッションを始められるかを確かめる(/agent の返事を出すときと、リポジトリを選んだときの両方で確かめる)。
 * 始められれば本人のキーを、始められなければ、その理由の返事を返す
 */
async function precheck(
	env: Env,
	userId: string,
	guildId: string,
	context: StartContext,
): Promise<{ credential: Credential } | { reply: MessageEdit }> {
	const credential = await loadCredential(env, userId, "anthropic");
	if (credential === null) {
		return { reply: { content: KEY_MISSING, components: [] } };
	}
	const active = await activeAgentChannels(env.DB, guildId, userId);
	if (active.length >= MAX_ACTIVE_SESSIONS) {
		return {
			reply: {
				content: tooManySessions(active.map((channel) => channel.channelId)),
				components: [],
			},
		};
	}
	const permissions = BigInt(context.app_permissions ?? "0");
	if (!hasPermission(permissions, PermissionFlags.ManageChannels)) {
		return { reply: { content: NO_MANAGE_CHANNELS, components: [] } };
	}
	return { credential };
}

/**
 * /agent の返事のセレクトメニューで選んだリポジトリ(か、「リポジトリを使わない」)で、セッションを始める。
 * 選ぶ間に、リポジトリが使えなくなっていたり、連携が外されていたりしたら、その返事を返す
 */
async function startFromMenu(
	context: StartContext,
	env: Env,
	user: APIUser,
	guildId: string,
	value: string,
): Promise<MessageEdit> {
	if (value === NO_REPOSITORY_VALUE) {
		return startAgent(context, env, user, guildId, null);
	}
	const chosen = await chooseRepository(env, user.id, value);
	if (chosen.status === "reply") {
		return chosen.reply;
	}
	return startAgent(context, env, user, guildId, chosen.repository);
}

/** 本人専用のチャンネルを作り、セッションを始める。repositoryを渡すと、セッションを作るときにつなぐ */
async function startAgent(
	context: StartContext,
	env: Env,
	user: APIUser,
	guildId: string,
	repository: ChosenRepository | null,
): Promise<MessageEdit> {
	const db = env.DB;
	const checked = await precheck(env, user.id, guildId, context);
	if ("reply" in checked) {
		return checked.reply;
	}
	const { credential } = checked;
	const permissions = BigInt(context.app_permissions ?? "0");

	const settings = await getUserSettings(db, user.id);
	const model = agentModel(settings);
	const effort = agentEffort(settings);
	const number = await nextAgentNumber(db, guildId, user.id);
	const name = agentChannelName(user.username, number);
	const client = agentClient(credential);
	let sessionId: string;
	let repositoryResourceId: string | null;
	try {
		const skills = await listSkills(db, guildId);
		const started = await startSession(db, user.id, client, {
			skills,
			model,
			effort,
			title: `#${name}`,
			repository:
				repository === null
					? null
					: {
							fullName: repository.fullName,
							mountPath: repository.mountPath,
							token: repository.token,
						},
		});
		sessionId = started.sessionId;
		repositoryResourceId = started.repositoryResourceId;
	} catch (error) {
		log("session_start_failed", user.id, error);
		return {
			content: startFailed(describeAgentError(error, model)),
			components: [],
		};
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
					id: context.application_id,
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
				return { content: NO_MANAGE_CHANNELS, components: [] };
			}
			if (error.code === MAX_GUILD_CHANNELS) {
				return { content: CHANNEL_LIMIT_REACHED, components: [] };
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
			...(repository === null || repositoryResourceId === null
				? {}
				: {
						repositories: [
							{
								fullName: repository.fullName,
								resourceId: repositoryResourceId,
								mountPath: repository.mountPath,
							},
						],
						repositoryTokenVersion: repository.tokenVersion,
					}),
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
		withRepository: repository !== null,
	});
	return { content: createdMessage(channelId), components: [] };
}

/** /agent で選んだGitHubのリポジトリ。セッションにつなぐ名前と場所、本人のトークンと、その記録の番号 */
interface ChosenRepository {
	fullName: string;
	mountPath: string;
	token: string;
	tokenVersion: number;
}

/**
 * /agent で選んだリポジトリを、本人が連携で許可したリポジトリの中から探す(選ぶ間に、外されていることがある)。
 * 見つからなければ、本人に見せる返事を返す。トークンは、セッションの最初の作業の間に切れないよう、
 * 残りの有効期間が足りなければ更新しておく(その後は、作業を始めるたびにBobertが入れ替える)
 */
async function chooseRepository(
	env: Env,
	userId: string,
	input: string,
): Promise<
	| { status: "found"; repository: ChosenRepository }
	| { status: "reply"; reply: MessageEdit }
> {
	const fullName = repositoryName(input);
	if (fullName === null) {
		return {
			status: "reply",
			reply: { content: repositoryNotUsable(input), components: [] },
		};
	}
	let lookup: RepositoryLookup;
	try {
		lookup = await findAllowedRepository(
			env,
			userId,
			fullName,
			REPOSITORY_TOKEN_VALIDITY_MS,
		);
	} catch (error) {
		log("github_lookup_failed", userId, error);
		return {
			status: "reply",
			reply: {
				content: GITHUB_LOOKUP_FAILED,
				components: [startWithoutRepositoryRow()],
			},
		};
	}
	switch (lookup.status) {
		case "unlinked":
			// 選ぶ間に、GitHubでアプリが外された。連携のボタンから出し直す
			return { status: "reply", reply: linkFirstMessage() };
		case "not_allowed":
			return {
				status: "reply",
				reply: {
					content: repositoryNotUsable(fullName),
					components: [startWithoutRepositoryRow()],
				},
			};
		case "found":
			return {
				status: "found",
				repository: {
					fullName: lookup.repository.fullName,
					mountPath: repositoryMountPath(lookup.repository.fullName),
					token: lookup.token.value,
					tokenVersion: lookup.token.version,
				},
			};
	}
}

/** 管理者か、その権限を持っているか */
function hasPermission(permissions: bigint, flag: bigint): boolean {
	return (
		(permissions & PermissionFlags.Administrator) !== 0n ||
		(permissions & flag) !== 0n
	);
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

/**
 * エージェントのボタン。エージェントのボタンでなければnull。
 * originは、このWorkerのURL(GitHubとの連携のコールバック先に使う)
 */
export async function agentComponent(
	interaction: APIMessageComponentInteraction,
	env: Env,
	ctx: ExecutionContext,
	userId: string,
	origin: string,
): Promise<APIInteractionResponse | null> {
	const customId = interaction.data.custom_id;
	if (!customId.startsWith("agent:")) {
		return null;
	}
	// /agent の返事(本人にだけ見える。エージェントのチャンネルの外)のボタンとセレクトメニューは、チャンネルを確かめる前に扱う
	if (customId === AGENT_GITHUB_START_ID) {
		// 連携のリンクは10分で使えなくなるので、押したときに作る。連携できたら、同じメッセージをセレクトメニューに書き換える
		const link = await createGitHubAuthLink(
			env,
			origin,
			userId,
			interaction.token,
			"agent",
		);
		return {
			type: InteractionResponseType.UpdateMessage,
			data: {
				content: GITHUB_LINK_PROMPT,
				components: linkOpenedComponents(link),
			},
		};
	}
	if (
		customId === AGENT_START_PLAIN_ID ||
		customId === AGENT_REPOSITORY_SELECT_ID
	) {
		const user = interaction.member?.user ?? interaction.user;
		const guildId = interaction.guild_id;
		if (user === undefined || guildId === undefined) {
			return { type: InteractionResponseType.DeferredMessageUpdate };
		}
		const value =
			interaction.data.component_type === ComponentType.StringSelect
				? (interaction.data.values[0] ?? NO_REPOSITORY_VALUE)
				: NO_REPOSITORY_VALUE;
		return respondLater(
			ctx,
			interaction,
			userId,
			"update",
			() => startFromMenu(interaction, env, user, guildId, value),
			{ content: startFailed(LLM_ERROR_TEXT), components: [] },
		);
	}
	// 「GitHubと連携」(エージェントのチャンネルで、連携が外されていたときの知らせ)は、押した人が自分のGitHubと連携するボタン。
	// 連携のリンクは10分で使えなくなるので、押したときに作る
	if (customId === AGENT_GITHUB_ID) {
		const link = await createGitHubAuthLink(
			env,
			origin,
			userId,
			interaction.token,
			"link",
		);
		return ephemeral(GITHUB_LINK_PROMPT, [
			{
				type: ComponentType.Button,
				style: ButtonStyle.Link,
				label: GITHUB_OPEN_BUTTON_LABEL,
				url: link,
			},
		]);
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
	const createPullRequest = customId.startsWith(AGENT_PR_CREATE_PREFIX);
	if (createPullRequest || customId.startsWith(AGENT_PR_CANCEL_PREFIX)) {
		const toolUseId = customId.slice(
			(createPullRequest ? AGENT_PR_CREATE_PREFIX : AGENT_PR_CANCEL_PREFIX)
				.length,
		);
		ctx.waitUntil(
			reportFailure(
				interaction,
				() => stub.answerPullRequest(toolUseId, createPullRequest),
				channel.ownerId,
			),
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
	buttons: APIButtonComponent[] = [],
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
