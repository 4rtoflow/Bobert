import type { APIOverwrite } from "discord-api-types/v10";
import {
	DiscordApiError,
	getChannel,
	getGuildMember,
	getGuildRoles,
} from "./api";
import { ChannelType, PermissionFlags } from "./constants";

/** 権限の上書きの対象の種類(ロールか、メンバーか) */
const OVERWRITE_ROLE = 0;
const OVERWRITE_MEMBER = 1;

/** チャンネルの権限の上書き */
export interface PermissionOverwrite {
	/** ロールかメンバーのID。@everyoneのロールのIDは、サーバーのIDと同じ */
	id: string;
	/** 0はロール、1はメンバー */
	type: number;
	/** 許可と拒否のビット(10進数の文字列) */
	allow: string;
	deny: string;
}

/**
 * チャンネルとスレッドのうち、共有チャンネルかどうかの判定に使う部分
 * (仕様: docs/spec/architecture.md「サーバー全体の共有チャンネル」)。GatewayとDiscordのAPIで届く情報から作る
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
	/** 権限の上書き(@everyone、ロール、メンバーへの)。スレッドは持たない(親に従う) */
	overwrites: PermissionOverwrite[];
}

/** サーバーのロール */
export interface RoleInfo {
	id: string;
	/** 権限のビット(10進数の文字列) */
	permissions: string;
}

/** Botがチャンネルを見られるかの計算に使う、サーバーのロールの情報 */
export interface GuildRoles {
	/** サーバーのロール(@everyoneを含む) */
	roles: RoleInfo[];
	/** Botが持つロールのID(@everyoneを除く) */
	botRoleIds: string[];
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
	const thread = isThreadType(channel.type);
	return {
		channelId: channel.id,
		guildId,
		// スレッドでないチャンネルのparent_idは、カテゴリー。見られるかどうかには関係しない
		parentId: thread ? (channel.parent_id ?? null) : null,
		type: channel.type,
		name: channel.name ?? "",
		nsfw: channel.nsfw === true,
		overwrites: thread
			? []
			: (channel.permission_overwrites ?? []).map((overwrite) => ({
					id: overwrite.id,
					type: Number(overwrite.type),
					allow: overwrite.allow,
					deny: overwrite.deny,
				})),
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

/** サーバーのロールの権限と、Botのロールを、DiscordのAPIで取る。Botがサーバーにいなければnull */
export async function fetchGuildRoles(
	botToken: string,
	guildId: string,
	botUserId: string,
): Promise<GuildRoles | null> {
	try {
		const [roles, member] = await Promise.all([
			getGuildRoles(botToken, guildId),
			getGuildMember(botToken, guildId, botUserId),
		]);
		return {
			roles: roles.map((role) => ({
				id: role.id,
				permissions: role.permissions,
			})),
			botRoleIds: member.roles,
		};
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
 * 共有チャンネル(AIが、サーバーのどのチャンネルからでも読めるチャンネル)か。
 * Botが見られて、年齢制限がないチャンネル。スレッドは、公開スレッド(お知らせのスレッドを含む)で、
 * 親のチャンネルが共有チャンネルなら共有。非公開スレッドは共有しない
 */
export function isSharedChannel(
	channel: ChannelInfo,
	parent: ChannelInfo | undefined,
	guild: GuildRoles,
	botUserId: string,
): boolean {
	if (isThreadType(channel.type)) {
		return (
			channel.type !== ChannelType.PrivateThread &&
			parent !== undefined &&
			!isThreadType(parent.type) &&
			isSharedChannel(parent, undefined, guild, botUserId)
		);
	}
	return !channel.nsfw && botCanView(channel, guild, botUserId);
}

/**
 * Botが、チャンネル(スレッドでないもの)を見られるか。「チャンネルを見る」の権限で決める。
 * @everyoneとBotのロールの権限に、@everyone、Botのロール、Botへの上書きの順で、チャンネルの権限の上書きを当てる。
 * Botのロールのうち、ロールの一覧にないもの(削除されたもの)は、権限にも上書きにも数えない
 */
export function botCanView(
	channel: ChannelInfo,
	guild: GuildRoles,
	botUserId: string,
): boolean {
	const permissionsOf = new Map(
		guild.roles.map((role) => [role.id, BigInt(role.permissions)]),
	);
	const botRoles = new Set(
		guild.botRoleIds.filter(
			(roleId) => roleId !== channel.guildId && permissionsOf.has(roleId),
		),
	);
	let permissions = permissionsOf.get(channel.guildId) ?? 0n;
	for (const roleId of botRoles) {
		permissions |= permissionsOf.get(roleId) ?? 0n;
	}
	if ((permissions & PermissionFlags.Administrator) !== 0n) {
		return true;
	}
	const everyone = channel.overwrites.find(
		(overwrite) =>
			overwrite.type === OVERWRITE_ROLE && overwrite.id === channel.guildId,
	);
	if (everyone) {
		permissions = apply(permissions, everyone.allow, everyone.deny);
	}
	let roleAllow = 0n;
	let roleDeny = 0n;
	for (const overwrite of channel.overwrites) {
		if (overwrite.type === OVERWRITE_ROLE && botRoles.has(overwrite.id)) {
			roleAllow |= BigInt(overwrite.allow);
			roleDeny |= BigInt(overwrite.deny);
		}
	}
	permissions = (permissions & ~roleDeny) | roleAllow;
	const member = channel.overwrites.find(
		(overwrite) =>
			overwrite.type === OVERWRITE_MEMBER && overwrite.id === botUserId,
	);
	if (member) {
		permissions = apply(permissions, member.allow, member.deny);
	}
	return (permissions & PermissionFlags.ViewChannel) !== 0n;
}

/** 権限の上書きを1つ当てる。拒否を外してから、許可を足す */
function apply(permissions: bigint, allow: string, deny: string): bigint {
	return (permissions & ~BigInt(deny)) | BigInt(allow);
}
