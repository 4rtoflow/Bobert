import type {
	APIChatInputApplicationCommandInteraction,
	APIInteractionResponse,
	APIMessageComponentInteraction,
} from "discord-api-types/v10";
import {
	ApplicationCommandOptionType,
	ButtonStyle,
	ChannelType,
} from "../discord/constants";
import {
	KNOWLEDGE_CHANNEL_OPTION,
	KNOWLEDGE_LIST_EMPTY,
	KNOWLEDGE_LIST_TITLE,
	KNOWLEDGE_LOAD_FAILED,
	KNOWLEDGE_SAVE_FAILED,
	KNOWLEDGE_UNSET_LABEL,
	knowledgeDesignated,
	knowledgeListLine,
	knowledgeNotEligible,
	knowledgeUnset,
	knowledgeUnsetConfirm,
} from "../knowledge/texts";
import { logEvent } from "../log";
import { button, row } from "../memory/screen";
import { resolveSharedChannels } from "../queue/channels";
import { ingestDeps } from "../queue/deps";
import { loadChannels } from "../store/channels";
import {
	countKnowledgeFiles,
	designateKnowledgeChannel,
	getKnowledgeChannel,
	listKnowledgeChannels,
	removeKnowledgeChannel,
} from "../store/knowledge";
import { type MessageEdit, respondLater } from "./deferred";

/*
 * /knowledge(知識チャンネルの指定と解除。仕様: docs/spec/behavior.md「知識チャンネル」)。結果は本人にだけ見せる。
 * 使えるのは、サーバー管理の権限を持つ人(コマンドの権限の既定。サーバー設定の「連携サービス」で変えられる)
 */

/** /knowledge のボタンのIDの頭 */
export const KNOWLEDGE_ID_PREFIX = "knowledge:";
/** 「解除する」のボタンのIDの頭。続けて、解除するチャンネルのIDを付ける */
const UNSET_ID_PREFIX = "knowledge:unset:";

/** 知識チャンネルにできるチャンネルの種類(テキスト、アナウンス、フォーラム)。コマンドの欄でも、これだけを選べるようにする */
export const KNOWLEDGE_CHANNEL_TYPES = [
	ChannelType.GuildText,
	ChannelType.GuildAnnouncement,
	ChannelType.GuildForum,
] as const;

/** Discordのメッセージの長さの上限 */
const MAX_CONTENT_LENGTH = 2000;

/**
 * /knowledge: チャンネルを省けば、今の知識チャンネルの一覧を見せる。
 * チャンネルを選べば、まだ知識チャンネルでなければ指定し、すでに知識チャンネルなら、解除してよいかを確かめる。
 * 共有チャンネルかどうかを確かめるのに、DiscordのAPIを呼ぶことがあるので、保留の応答を返してから結果を書く
 */
export function knowledgeCommand(
	interaction: APIChatInputApplicationCommandInteraction,
	env: Env,
	ctx: ExecutionContext,
	guildId: string,
	userId: string,
): APIInteractionResponse {
	const option = interaction.data.options?.find(
		(candidate) => candidate.name === KNOWLEDGE_CHANNEL_OPTION,
	);
	const channelId =
		option?.type === ApplicationCommandOptionType.Channel ? option.value : null;
	if (channelId === null) {
		return respondLater(
			ctx,
			interaction,
			userId,
			"reply",
			() => channelList(env.DB, guildId),
			{ content: KNOWLEDGE_LOAD_FAILED },
		);
	}
	const type = interaction.data.resolved?.channels?.[channelId]?.type;
	return respondLater(
		ctx,
		interaction,
		userId,
		"reply",
		() => chooseChannel(env, { guildId, channelId, type, userId }),
		{ content: KNOWLEDGE_SAVE_FAILED },
	);
}

/** 「解除する」のボタン。知らないボタンならnull */
export function knowledgeComponent(
	interaction: APIMessageComponentInteraction,
	env: Env,
	ctx: ExecutionContext,
	guildId: string,
	userId: string,
): APIInteractionResponse | null {
	const customId = interaction.data.custom_id;
	if (!customId.startsWith(UNSET_ID_PREFIX)) {
		return null;
	}
	const channelId = customId.slice(UNSET_ID_PREFIX.length);
	return respondLater(
		ctx,
		interaction,
		userId,
		"update",
		async () => {
			// 確かめている間に、ほかの人が解除していたら、解除したときと同じ文にする
			const current = await getKnowledgeChannel(env.DB, channelId);
			if (current !== null && current.guildId === guildId) {
				const files = await removeKnowledgeChannel(env.DB, channelId);
				log("unset", { userId, guildId, channelId, files });
			}
			return { content: knowledgeUnset(channelId), components: [] };
		},
		// 解除できなかったときは、ボタンを残す(もう一度押せるように)
		{ content: KNOWLEDGE_SAVE_FAILED },
	);
}

/** 今の知識チャンネルの一覧(チャンネルごとの、知識のファイルの数) */
async function channelList(
	db: D1Database,
	guildId: string,
): Promise<MessageEdit> {
	const channels = await listKnowledgeChannels(db, guildId);
	if (channels.length === 0) {
		return { content: KNOWLEDGE_LIST_EMPTY };
	}
	const lines: string[] = [KNOWLEDGE_LIST_TITLE];
	for (const channel of channels) {
		const line = knowledgeListLine(channel.channelId, channel.files);
		// 1通に収まらないほど多ければ、後ろを省く
		if ([...lines, line, "…"].join("\n").length > MAX_CONTENT_LENGTH) {
			lines.push("…");
			break;
		}
		lines.push(line);
	}
	return { content: lines.join("\n") };
}

/**
 * 選んだチャンネルを、知識チャンネルにするか、解除してよいかを確かめる。
 * 指定できるのは、共有チャンネル(Botが見られて、年齢制限のないチャンネル)のうち、テキスト、アナウンス、フォーラムだけ。
 * エージェントのチャンネルも選べない(共有チャンネルにしないため)
 */
async function chooseChannel(
	env: Env,
	choice: {
		guildId: string;
		channelId: string;
		/** コマンドの欄で選ばれたチャンネルの種類(Discordが添えたもの) */
		type: number | undefined;
		userId: string;
	},
): Promise<MessageEdit> {
	const { guildId, channelId, userId } = choice;
	let files: number | null;
	try {
		const current = await getKnowledgeChannel(env.DB, channelId);
		files =
			current !== null && current.guildId === guildId
				? await countKnowledgeFiles(env.DB, channelId)
				: null;
	} catch (error) {
		log("load_failed", { userId, guildId, error: errorName(error) });
		return { content: KNOWLEDGE_LOAD_FAILED };
	}
	if (files !== null) {
		return {
			content: knowledgeUnsetConfirm(channelId, files),
			components: [
				row(
					button(
						KNOWLEDGE_UNSET_LABEL,
						`${UNSET_ID_PREFIX}${channelId}`,
						ButtonStyle.Danger,
					),
				),
			],
		};
	}
	if (!(await canDesignate(env, choice))) {
		log("not_eligible", { userId, guildId, channelId });
		return { content: knowledgeNotEligible(channelId) };
	}
	try {
		await designateKnowledgeChannel(env.DB, {
			channelId,
			guildId,
			designatedBy: userId,
		});
	} catch (error) {
		log("save_failed", { userId, guildId, error: errorName(error) });
		return { content: KNOWLEDGE_SAVE_FAILED };
	}
	log("designated", { userId, guildId, channelId });
	return { content: knowledgeDesignated(channelId) };
}

/**
 * 知識チャンネルにできるか。共有チャンネルかどうかは、チャンネルの記録で確かめる。
 * 記録がなければ(作ったばかりのチャンネルなど)、DiscordのAPIで確かめて記録する
 */
async function canDesignate(
	env: Env,
	choice: { guildId: string; channelId: string; type: number | undefined },
): Promise<boolean> {
	const { guildId, channelId, type } = choice;
	if (type !== undefined && !isKnowledgeChannelType(type)) {
		return false;
	}
	const shared = await resolveSharedChannels(
		[{ channelId, guildId }],
		ingestDeps(env),
	);
	if (!shared.has(channelId)) {
		return false;
	}
	const record = (await loadChannels(env.DB, [channelId])).get(channelId);
	return (
		record !== undefined &&
		record.parentId === null &&
		isKnowledgeChannelType(record.type)
	);
}

function isKnowledgeChannelType(type: number): boolean {
	return (KNOWLEDGE_CHANNEL_TYPES as readonly number[]).includes(type);
}

function errorName(error: unknown): string {
	return error instanceof Error ? error.name : "unknown";
}

function log(event: string, detail: Record<string, unknown>): void {
	logEvent("knowledge", event, detail);
}
