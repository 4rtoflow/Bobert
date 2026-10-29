import type { APIMessage } from "discord-api-types/v10";
import { shouldStore, toStoredMessage } from "../gateway/messages";
import type { StoredMessageInput, UserName } from "../queue/messages";
import { findExplainTarget } from "../store/explain";
import { getChannelImport } from "../store/imports";
import {
	loadChannelMessages,
	loadMemberNames,
	loadStoredChain,
	type TimelineRange,
} from "../store/messages";
import type { SearchOptions } from "../store/search";
import {
	type ConversationSummary,
	findSummaryEndingAt,
} from "../store/summaries";
import { selectImages } from "./conversation";

/** 添付のURLの期限まで、これより短ければ取り直す。AIが画像を読みに行くまでの余裕 */
const URL_REFRESH_MARGIN_MS = 10 * 60 * 1000;
/** 返信のつながりをたどるときに、1回でDiscordから読むメッセージの数の上限。保存したもの(D1)から読む分には上限はない */
const MAX_DISCORD_FETCHES = 100;

/** Discordからメッセージを1件読む。消えているか、読めなければnull */
export type MessageFetcher = (
	channelId: string,
	messageId: string,
) => Promise<APIMessage | null>;

/** Discordから、チャンネルのメッセージの一覧を読む(新しい順で返る)。beforeとafterはメッセージID */
export type MessageLister = (
	channelId: string,
	options: { before?: string; after?: string; limit: number },
) => Promise<APIMessage[]>;

/** 過去のメッセージの読み先(仕様: docs/spec/architecture.md「会話の文脈と過去の発言の保存」) */
export interface HistoryDeps {
	db: D1Database;
	guildId: string | null;
	channelId: string;
	fetchMessage: MessageFetcher;
	listMessages: MessageLister;
	/**
	 * 検索語に意味が近いメッセージのIDを、近い順に探す(意味で検索)。
	 * scopeがchannelなら、このチャンネルから。serverなら、このサーバーの共有チャンネル全体から
	 */
	searchMessages: (
		query: string,
		options: Omit<SearchOptions, "scope"> & { scope: "channel" | "server" },
	) => Promise<string[]>;
	/** Discordから読んだメッセージを、保存に回す(読んだ分だけ取り込む) */
	ingest: (messages: StoredMessageInput[]) => Promise<void>;
	/** 話しかけたメッセージで分かった、サーバーで見えている名前。保存したものより新しい */
	knownNames: readonly UserName[];
}

/** Discordから読んだメッセージを、保存の形にする。Discordから読み直したメッセージには、ニックネームが含まれない */
export function fromDiscord(
	message: APIMessage,
	guildId: string | null,
): StoredMessageInput {
	return toStoredMessage({ ...message, guild_id: guildId ?? undefined });
}

/** 会話(返信のつながり) */
export interface Conversation {
	/** 発言(古い順)。要約があれば、要約した位置より後の発言だけ */
	messages: StoredMessageInput[];
	/** 会話の古い部分を要約してあれば、その要約 */
	summary: ConversationSummary | null;
}

/**
 * 会話(返信のつながり)を、話しかけたメッセージから古い方へたどって読む
 * (仕様: docs/spec/architecture.md「会話の文脈と過去の発言の保存」「長い会話の自動要約」)。
 * 件数の上限はない。要約した位置に行き当たったら、そこで止め、それより前は要約で渡す。
 */
export async function readConversation(
	start: StoredMessageInput,
	deps: HistoryDeps,
): Promise<Conversation> {
	const { chain, summary } = await walkReplyChain(start, deps, {
		limit: Number.MAX_SAFE_INTEGER,
		stopAtSummary: true,
	});
	// 要約した位置(要約の終わりのメッセージ)と、それより前は、要約に含まれている
	return { messages: summary ? chain.slice(1) : chain, summary };
}

/**
 * 返信のつながりを、startから古い方へたどって読み、古い順に並べて返す(startを含めて、最大limit件)。
 * 要約した位置でも止めない(返信先を読む道具で使う)
 */
export async function readReplyChain(
	start: StoredMessageInput,
	deps: HistoryDeps,
	limit: number,
): Promise<StoredMessageInput[]> {
	const { chain } = await walkReplyChain(start, deps, {
		limit,
		stopAtSummary: false,
	});
	return chain;
}

/**
 * 返信のつながりをたどる。保存したメッセージ(D1)から読む。
 * 保存していないもの(Botが動き出す前のものや、保存の処理がまだ済んでいないもの)は、Discordから読み、保存にも回す。
 * Discordから読むのは、1回で100件まで。返信先が消えていたら、そこで止める。
 * stopAtSummaryなら、要約した位置で止め、その要約を返す。
 */
async function walkReplyChain(
	start: StoredMessageInput,
	deps: HistoryDeps,
	options: { limit: number; stopAtSummary: boolean },
): Promise<{
	chain: StoredMessageInput[];
	summary: ConversationSummary | null;
}> {
	const chain = [start];
	const fetched: StoredMessageInput[] = [];
	let summary: ConversationSummary | null = null;
	let nextId = start.replyToId;
	while (nextId !== null && chain.length < options.limit) {
		const stored = await loadStoredChain(
			deps.db,
			nextId,
			options.limit - chain.length,
			options.stopAtSummary,
		);
		const last = stored.messages.at(-1);
		if (last) {
			chain.push(...stored.messages);
			if (stored.reachedSummary) {
				summary = await findSummaryEndingAt(deps.db, last.messageId);
				break;
			}
			nextId = last.replyToId;
			continue;
		}
		if (fetched.length >= MAX_DISCORD_FETCHES) {
			break;
		}
		const message = await deps.fetchMessage(deps.channelId, nextId);
		if (message === null) {
			break;
		}
		const converted = fromDiscord(message, deps.guildId);
		chain.push(converted);
		fetched.push(converted);
		if (options.stopAtSummary) {
			summary = await findSummaryEndingAt(deps.db, converted.messageId);
			if (summary) {
				break;
			}
		}
		nextId = converted.replyToId;
	}
	// 返信のつながりの始まりが「Bobertに聞く」の返答なら、説明の対象のメッセージを、会話の最初に入れる。
	// Interactionへの返答は「返信」ではないので、返信のつながりからはたどれないため。説明の対象の返信先までは、たどらない
	const oldest = chain.at(-1);
	if (
		summary === null &&
		nextId === null &&
		oldest !== undefined &&
		chain.length < options.limit
	) {
		const targetId = await findExplainTarget(deps.db, oldest.messageId);
		if (targetId !== null) {
			const stored = await loadStoredChain(deps.db, targetId, 1);
			let target = stored.messages[0] ?? null;
			if (target === null) {
				const message = await deps.fetchMessage(deps.channelId, targetId);
				target = message === null ? null : fromDiscord(message, deps.guildId);
				if (target !== null) {
					fetched.push(target);
				}
			}
			if (target !== null) {
				chain.push(target);
			}
		}
	}
	if (fetched.length > 0) {
		await deps.ingest(fetched);
	}
	return { chain: chain.reverse(), summary };
}

/**
 * メッセージの発言者と、メンションされた人の、サーバーで見えている名前。
 * 保存した名前に、話しかけたメッセージで分かった名前を重ねる。
 */
export async function namesFor(
	messages: readonly StoredMessageInput[],
	deps: HistoryDeps,
): Promise<Map<string, string>> {
	const userIds = new Set(
		messages.flatMap((message) => [
			message.authorId,
			...message.mentions.map((user) => user.id),
		]),
	);
	const names =
		deps.guildId === null
			? new Map<string, string>()
			: await loadMemberNames(deps.db, deps.guildId, [...userIds]);
	for (const known of deps.knownNames) {
		names.set(known.id, known.name);
	}
	return names;
}

/**
 * AIに渡す画像のURLのうち、期限(約24時間)が近いものを、Discordから読み直して取り直す。
 * 読み直せなかった(消えていた)メッセージは、会話から外す。読み直したものは、保存にも回す。
 */
export async function refreshImageUrls(
	chain: readonly StoredMessageInput[],
	deps: HistoryDeps,
	botUserId: string,
	now = Date.now(),
): Promise<StoredMessageInput[]> {
	const stale = new Set(
		[...selectImages(chain, botUserId)]
			.filter(([, images]) =>
				images.some((image) => expiresSoon(image.url, now)),
			)
			.map(([messageId]) => messageId),
	);
	if (stale.size === 0) {
		return [...chain];
	}
	const refreshed: StoredMessageInput[] = [];
	const result: StoredMessageInput[] = [];
	// Discordの利用制限にかからないよう、1件ずつ読む(画像の枚数の上限までなので、多くはない)
	for (const message of chain) {
		if (!stale.has(message.messageId)) {
			result.push(message);
			continue;
		}
		const fresh = await deps.fetchMessage(deps.channelId, message.messageId);
		if (fresh === null) {
			continue;
		}
		const converted = fromDiscord(fresh, deps.guildId);
		refreshed.push(converted);
		result.push({ ...message, attachments: converted.attachments });
	}
	if (refreshed.length > 0) {
		await deps.ingest(refreshed);
	}
	return result;
}

/** 添付のURLの期限が近いか。DiscordのURLは、期限をexに16進数のUNIX時間(秒)で持つ。期限がなければ、取り直さない */
export function expiresSoon(url: string, now: number): boolean {
	let expires: string | null;
	try {
		expires = new URL(url).searchParams.get("ex");
	} catch {
		return false;
	}
	if (expires === null) {
		return false;
	}
	const expiresAt = Number.parseInt(expires, 16) * 1000;
	return Number.isNaN(expiresAt) || expiresAt - now < URL_REFRESH_MARGIN_MS;
}

/** DiscordのメッセージIDの時刻の起点(2015-01-01) */
const DISCORD_EPOCH = 1420070400000n;

/**
 * チャンネルの履歴を、範囲を指定して読む(時系列で読む道具)。返すのは古い順。
 * channelIdを省くと、今いるチャンネルを読む。
 * 過去ログの取り込みが済んでいれば、保存したもの(D1)から読む。
 * 済んでいなければ、保存していない期間があるので、Discordから読み、保存にも回す(保存するのは、共有チャンネルの分だけ)。
 */
export async function readChannelTimeline(
	range: TimelineRange,
	deps: HistoryDeps,
	channelId = deps.channelId,
): Promise<StoredMessageInput[]> {
	const imported = await getChannelImport(deps.db, channelId);
	if (imported?.status === "done") {
		return loadChannelMessages(deps.db, channelId, range);
	}
	const page = await deps.listMessages(channelId, {
		...(range.newestFirst
			? range.before === null
				? {}
				: { before: snowflakeAt(range.before) }
			: { after: snowflakeAt(range.after ?? 0) }),
		limit: range.limit,
	});
	const messages = page
		.map((message) => ({ ...message, guild_id: deps.guildId ?? undefined }))
		// 参加やピン留めの通知などのシステムのメッセージは、保存の対象と同じく外す
		.filter((message) => shouldStore(message))
		.map((message) => toStoredMessage(message))
		.filter(
			(message) =>
				(range.after === null || message.createdAt > range.after) &&
				(range.before === null || message.createdAt < range.before),
		)
		.sort((a, b) => a.createdAt - b.createdAt);
	if (messages.length > 0) {
		await deps.ingest(messages);
	}
	return messages;
}

/** その時刻のメッセージIDの下限。メッセージIDの上位のビットは、投稿された時刻 */
function snowflakeAt(ms: number): string {
	const time = BigInt(Math.max(0, Math.floor(ms))) - DISCORD_EPOCH;
	return (time > 0n ? time << 22n : 0n).toString();
}
