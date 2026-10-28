import type { APIOverwrite } from "discord-api-types/v10";
import { DiscordApiError, getChannel, getGuildRoles } from "./api";
import { ChannelType, PermissionFlags } from "./constants";

/** 権限の上書きの対象がロールであることを表す値 */
const OVERWRITE_ROLE = 0;

/**
 * チャンネルとスレッドのうち、公開かどうかの判定に使う部分
 * (仕様: docs/spec/architecture.md「サーバー全体の公開チャンネル」)。GatewayとDiscordのAPIで届く情報から作る
 */
export interface ChannelInfo {
	channelId: string;
	guildId: string;
	/** スレッドなら、親のチャンネル。スレッドでなければnull(カテゴリーは持たない) */
	parentId: string | null;
	type: number;
	name: string;
	/** 年齢制限のチャンネルか。スレッドは親に従う */
	nsfw: boolean;
	/** @everyoneへの上書きの、許可と拒否のビット(10進数の文字列)。上書きがなければnull */
	everyoneAllow: string | null;
	everyoneDeny: string | null;
}

/** Discordのチャンネルの情報のうち、Bobertが使う部分(GatewayとAPIで共通) */
export interface DiscordChannel {
	id: string;
	type: number;
	name?: string | null;
	parent_id?: string | null;
	nsfw?: boolean;
	permission_overwrites?: APIOverwrite[];
}

const THREAD_TYPES: ReadonlySet<number> = new Set([
	ChannelType.AnnouncementThread,
	ChannelType.PublicThread,
	ChannelType.PrivateThread,
]);

/** スレッドのほかに、メッセージを持つチャンネルの種類(テキスト、お知らせ、ボイスとステージのテキストチャット) */
const MESSAGE_CHANNEL_TYPES: ReadonlySet<number> = new Set([
	ChannelType.GuildText,
	ChannelType.GuildAnnouncement,
	ChannelType.GuildVoice,
	ChannelType.GuildStageVoice,
]);

/** 投稿がスレッドになるチャンネルの種類(フォーラムとメディア) */
const POST_CHANNEL_TYPES: ReadonlySet<number> = new Set([
	ChannelType.GuildForum,
	ChannelType.GuildMedia,
]);

/** スレッドを作れるチャンネルの種類 */
const THREAD_PARENT_TYPES: ReadonlySet<number> = new Set([
	ChannelType.GuildText,
	ChannelType.GuildAnnouncement,
	ChannelType.GuildForum,
	ChannelType.GuildMedia,
]);

export function toChannelInfo(
	channel: DiscordChannel,
	guildId: string,
): ChannelInfo {
	const everyone = channel.permission_overwrites?.find(
		(overwrite) =>
			overwrite.id === guildId && Number(overwrite.type) === OVERWRITE_ROLE,
	);
	return {
		channelId: channel.id,
		guildId,
		// スレッドでないチャンネルのparent_idは、カテゴリー。公開かどうかには関係しない
		parentId: isThreadType(channel.type) ? (channel.parent_id ?? null) : null,
		type: channel.type,
		name: channel.name ?? "",
		nsfw: channel.nsfw === true,
		everyoneAllow: everyone?.allow ?? null,
		everyoneDeny: everyone?.deny ?? null,
	};
}

/** チャンネル(スレッドを含む)の情報を、DiscordのAPIで取る。消えているか、Botが見られなければnull */
export async function fetchChannelInfo(
	botToken: string,
	channelId: string,
	guildId: string,
): Promise<ChannelInfo | null> {
	try {
		const channel = (await getChannel(botToken, channelId)) as DiscordChannel;
		return toChannelInfo(channel, guildId);
	} catch (error) {
		if (isGone(error)) {
			return null;
		}
		throw error;
	}
}

/** サーバーの@everyoneの権限を、DiscordのAPIで取る。Botがサーバーにいなければnull */
export async function fetchEveryonePermissions(
	botToken: string,
	guildId: string,
): Promise<string | null> {
	try {
		return everyonePermissionsOf(
			await getGuildRoles(botToken, guildId),
			guildId,
		);
	} catch (error) {
		if (isGone(error)) {
			return null;
		}
		throw error;
	}
}

/** 見る権限がない(403)か、消えた(404) */
function isGone(error: unknown): boolean {
	return (
		error instanceof DiscordApiError &&
		(error.status === 403 || error.status === 404)
	);
}

/** @everyoneのロールの権限。@everyoneのロールのIDは、サーバーのIDと同じ */
export function everyonePermissionsOf(
	roles: readonly { id: string; permissions: string }[],
	guildId: string,
): string | null {
	return roles.find((role) => role.id === guildId)?.permissions ?? null;
}

export function isThreadType(type: number): boolean {
	return THREAD_TYPES.has(type);
}

/** スレッドのほかに、メッセージを持つチャンネルか(過去ログを取り込む対象) */
export function hasMessages(type: number): boolean {
	return MESSAGE_CHANNEL_TYPES.has(type);
}

/** 投稿がスレッドになるチャンネル(フォーラムとメディア)か */
export function hasPosts(type: number): boolean {
	return POST_CHANNEL_TYPES.has(type);
}

/** スレッドを作れるチャンネルか */
export function canHaveThreads(type: number): boolean {
	return THREAD_PARENT_TYPES.has(type);
}

/**
 * 公開チャンネルか。@everyoneが見られて過去のメッセージも読め、年齢制限がないチャンネル。
 * スレッドは、公開スレッド(お知らせのスレッドを含む)で、親のチャンネルが公開なら公開。非公開スレッドは権限付き
 */
export function isPublicChannel(
	channel: ChannelInfo,
	parent: ChannelInfo | undefined,
	everyonePermissions: string,
): boolean {
	if (isThreadType(channel.type)) {
		return (
			channel.type !== ChannelType.PrivateThread &&
			parent !== undefined &&
			!isThreadType(parent.type) &&
			isPublicChannel(parent, undefined, everyonePermissions)
		);
	}
	return !channel.nsfw && everyoneCanRead(channel, everyonePermissions);
}

/** @everyoneが、チャンネルを見て、過去のメッセージも読めるか */
function everyoneCanRead(
	channel: ChannelInfo,
	everyonePermissions: string,
): boolean {
	const base = BigInt(everyonePermissions);
	if ((base & PermissionFlags.Administrator) !== 0n) {
		return true;
	}
	const allow = BigInt(channel.everyoneAllow ?? "0");
	const deny = BigInt(channel.everyoneDeny ?? "0");
	const permissions = (base & ~deny) | allow;
	const required =
		PermissionFlags.ViewChannel | PermissionFlags.ReadMessageHistory;
	return (permissions & required) === required;
}
