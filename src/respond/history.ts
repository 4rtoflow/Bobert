import type { APIMessage } from "discord-api-types/v10";
import { shouldStore, toStoredMessage } from "../gateway/messages";
import type { StoredMessageInput, UserName } from "../queue/messages";
import { getChannelImport } from "../store/imports";
import {
	loadChannelMessages,
	loadMemberNames,
	loadStoredChain,
	type TimelineRange,
} from "../store/messages";
import type { SearchOptions } from "../store/search";
import { MAX_CHAIN_LENGTH, selectImages } from "./conversation";

/** 添付のURLの期限まで、これより短ければ取り直す。AIが画像を読みに行くまでの余裕 */
const URL_REFRESH_MARGIN_MS = 10 * 60 * 1000;

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
	/** このチャンネルで、検索語に意味が近いメッセージのIDを、近い順に探す(意味で検索) */
	searchMessages: (
		query: string,
		options: Omit<SearchOptions, "channelId">,
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

/**
 * 返信のつながりを、startから古い方へたどって読み、古い順に並べて返す(startを含めて、最大limit件)。
 * 保存したメッセージ(D1)から読む。保存していないもの(Botが動き出す前のものや、保存の処理がまだ済んでいないもの)は、
 * Discordから読み、保存にも回す。返信先が消えていたら、そこで止める。
 */
export async function readReplyChain(
	start: StoredMessageInput,
	deps: HistoryDeps,
	limit = MAX_CHAIN_LENGTH,
): Promise<StoredMessageInput[]> {
	const chain = [start];
	const fetched: StoredMessageInput[] = [];
	let nextId = start.replyToId;
	while (nextId !== null && chain.length < limit) {
		const stored = await loadStoredChain(deps.db, nextId, limit - chain.length);
		const last = stored.at(-1);
		if (last) {
			chain.push(...stored);
			nextId = last.replyToId;
			continue;
		}
		const message = await deps.fetchMessage(deps.channelId, nextId);
		if (message === null) {
			break;
		}
		const converted = fromDiscord(message, deps.guildId);
		chain.push(converted);
		fetched.push(converted);
		nextId = converted.replyToId;
	}
	if (fetched.length > 0) {
		await deps.ingest(fetched);
	}
	return chain.reverse();
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
function expiresSoon(url: string, now: number): boolean {
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
 * 過去ログの取り込みが済んでいれば、保存したもの(D1)から読む。
 * 済んでいなければ、保存していない期間があるので、Discordから読み、保存にも回す。
 */
export async function readChannelTimeline(
	range: TimelineRange,
	deps: HistoryDeps,
): Promise<StoredMessageInput[]> {
	const imported = await getChannelImport(deps.db, deps.channelId);
	if (imported?.status === "done") {
		return loadChannelMessages(deps.db, deps.channelId, range);
	}
	const page = await deps.listMessages(deps.channelId, {
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
