import type {
	APIApplicationCommandAutocompleteInteraction,
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
	ApplicationCommandOptionType,
	ButtonStyle,
	ComponentType,
	InteractionResponseType,
	MessageFlags,
	OverwriteType,
	PermissionFlags,
} from "../discord/constants";
import {
	findAllowedRepository,
	listAllowedRepositoryNames,
	type RepositoryLookup,
} from "../github/account";
import { type MessageEdit, respondLater } from "../interactions/deferred";
import { logEvent } from "../log";
import { createGitHubAuthLink } from "../oauth/github";
import { LLM_ERROR_TEXT } from "../respond/replies";
import { listSkills } from "../store/skills";
import { getUserSettings, loadCredential } from "../store/users";
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
	githubLinkRow,
	REPOSITORY_TOKEN_VALIDITY_MS,
	repositoryName,
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
	AGENT_REPOSITORY_OPTION_NAME,
	ALREADY_ENDED,
	agentChannelName,
	CHANNEL_LIMIT_REACHED,
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
	GITHUB_NOT_LINKED_FOR_AGENT,
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

/** /agent の repository の欄の候補を返すまでの時間の上限。Discordは3秒以内の返事を求めるため */
const AUTOCOMPLETE_TIMEOUT_MS = 2_500;

/** 候補の数と、候補の名前の長さの上限(Discordの決まり) */
const MAX_CHOICES = 25;
const MAX_CHOICE_LENGTH = 100;

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
	// GitHubのリポジトリを選んでいたら、連携と許可を確かめる。リポジトリは、セッションを作るときにしかつなげないため
	const repositoryInput = repositoryOption(interaction);
	let repository: ChosenRepository | null = null;
	if (repositoryInput !== null) {
		const chosen = await chooseRepository(env, user.id, repositoryInput);
		if (chosen.status === "reply") {
			return chosen.reply;
		}
		repository = chosen.repository;
	}

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
	return { content: createdMessage(channelId) };
}

/**
 * /agent の repository の欄の候補: 本人がGitHubで許可したリポジトリのうち、入力した文字を含むもの
 * (大文字と小文字は区別しない)。連携していないときや、時間内に読めなかったときは、候補を出さない
 */
export async function agentAutocomplete(
	interaction: APIApplicationCommandAutocompleteInteraction,
	env: Env,
	userId: string,
): Promise<APIInteractionResponse> {
	const focused = interaction.data.options.find(
		(option) => "focused" in option && option.focused === true,
	);
	const typed =
		focused?.type === ApplicationCommandOptionType.String
			? focused.value.trim().toLowerCase()
			: "";
	const names = await Promise.race([
		listAllowedRepositoryNames(env, userId).catch((error: unknown) => {
			log("repository_autocomplete_failed", userId, error);
			return [];
		}),
		new Promise<string[]>((resolve) =>
			setTimeout(() => resolve([]), AUTOCOMPLETE_TIMEOUT_MS),
		),
	]);
	const choices = names
		.filter(
			(name) =>
				name.length <= MAX_CHOICE_LENGTH && name.toLowerCase().includes(typed),
		)
		.slice(0, MAX_CHOICES)
		.map((name) => ({ name, value: name }));
	return {
		type: InteractionResponseType.ApplicationCommandAutocompleteResult,
		data: { choices },
	};
}

/** /agent で選んだGitHubのリポジトリ。セッションにつなぐ名前と場所、本人のトークンと、その記録の番号 */
interface ChosenRepository {
	fullName: string;
	mountPath: string;
	token: string;
	tokenVersion: number;
}

/** /agent の repository の欄の値。入れていなければnull */
function repositoryOption(
	interaction: APIChatInputApplicationCommandInteraction,
): string | null {
	const option = interaction.data.options?.find(
		(entry) => entry.name === AGENT_REPOSITORY_OPTION_NAME,
	);
	if (option?.type !== ApplicationCommandOptionType.String) {
		return null;
	}
	const value = option.value.trim();
	return value === "" ? null : value;
}

/**
 * /agent で入れたリポジトリを、本人が連携で許可したリポジトリの中から探す。
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
		return { status: "reply", reply: { content: repositoryNotUsable(input) } };
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
		return { status: "reply", reply: { content: GITHUB_LOOKUP_FAILED } };
	}
	switch (lookup.status) {
		case "unlinked":
			return {
				status: "reply",
				reply: {
					content: GITHUB_NOT_LINKED_FOR_AGENT,
					components: [githubLinkRow()],
				},
			};
		case "not_allowed":
			return {
				status: "reply",
				reply: { content: repositoryNotUsable(fullName) },
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
	// 「GitHubと連携」は、押した人が自分のGitHubと連携するボタン。/agent の返事(エージェントのチャンネルの外)にも付けるので、
	// チャンネルを確かめる前に扱う。連携のリンクは10分で使えなくなるので、押したときに作る
	if (customId === AGENT_GITHUB_ID) {
		const link = await createGitHubAuthLink(
			env,
			origin,
			userId,
			interaction.token,
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
