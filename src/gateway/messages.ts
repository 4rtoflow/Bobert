import type { APIMessage, APIUser } from "discord-api-types/v10";
import { MessageType } from "../discord/constants";
import type { StoredMessageInput, UserName } from "../queue/messages";

/** サーバーでの情報のうち、Bobertが使う部分 */
interface GatewayMember {
	nick?: string | null;
}

/** Gatewayで届くメッセージのうち、Bobertが使う部分 */
export type GatewayMessage = Pick<
	APIMessage,
	| "id"
	| "type"
	| "channel_id"
	| "author"
	| "content"
	| "timestamp"
	| "edited_timestamp"
	| "attachments"
	| "message_reference"
	| "referenced_message"
> & {
	guild_id?: string;
	/** 発言者のサーバーでの情報。サーバーの中のメッセージで、Gatewayで届いたときだけ付く */
	member?: GatewayMember;
	/** メンションされた人。サーバーの中では、それぞれのサーバーでの情報も付く */
	mentions: (APIUser & { member?: GatewayMember })[];
};

/** 保存するメッセージの種類。参加やピン留めの通知などのシステムのメッセージは、会話ではないので保存しない */
const STORED_TYPES: ReadonlySet<number> = new Set([
	MessageType.Default,
	MessageType.Reply,
	MessageType.ChatInputCommand,
	MessageType.ContextMenuCommand,
]);

/**
 * Botが応答すべきメッセージかどうか(仕様: docs/spec/architecture.md「決定事項」)。
 * - Botへのメンション
 * - Botのメッセージへの返信(メンションの有無は問わない)
 * Bot自身やほかのBotの投稿、DMには応答しない。
 */
export function shouldRespond(
	message: GatewayMessage,
	botUserId: string,
): boolean {
	if (message.author.bot || !message.guild_id) {
		return false;
	}
	const mentioned = message.mentions.some((user) => user.id === botUserId);
	const replyToBot = message.referenced_message?.author.id === botUserId;
	return mentioned || replyToBot;
}

/**
 * 保存するメッセージかどうか(仕様: docs/spec/architecture.md「会話の文脈と過去の発言の保存」)。
 * 編集の通知は一部の項目だけのことがあるので、種類がなければ保存する側に倒す。
 */
export function shouldStore(
	message: Pick<Partial<GatewayMessage>, "guild_id" | "type">,
): boolean {
	return (
		Boolean(message.guild_id) &&
		(message.type === undefined || STORED_TYPES.has(message.type))
	);
}

/**
 * メッセージで分かった、サーバーで見えている名前(発言者と、メンションされた人)。
 * サーバーでの情報が付いている人だけ。Discordから読み直したメッセージには付いていない
 */
export function memberNames(message: GatewayMessage): UserName[] {
	return [
		...(message.member
			? [
					{
						id: message.author.id,
						name: memberName(message.author, message.member),
					},
				]
			: []),
		...message.mentions.flatMap((user) =>
			user.member ? [{ id: user.id, name: memberName(user, user.member) }] : [],
		),
	];
}

/** 保存用の形に変換する。会話の組み立ても、この形で行う */
export function toStoredMessage(message: GatewayMessage): StoredMessageInput {
	return {
		messageId: message.id,
		guildId: message.guild_id ?? null,
		channelId: message.channel_id,
		authorId: message.author.id,
		authorName: memberName(message.author, message.member),
		authorIsBot: message.author.bot === true,
		content: message.content,
		replyToId:
			message.type === MessageType.Reply
				? (message.message_reference?.message_id ?? null)
				: null,
		mentions: message.mentions.map((user) => ({
			id: user.id,
			name: memberName(user, user.member),
		})),
		attachments: message.attachments.map((attachment) => ({
			filename: attachment.filename,
			url: attachment.url,
			contentType: attachment.content_type ?? null,
			size: attachment.size,
		})),
		members: memberNames(message),
		createdAt: Date.parse(message.timestamp),
		editedAt: message.edited_timestamp
			? Date.parse(message.edited_timestamp)
			: null,
	};
}

/** サーバーで見えている名前。ニックネーム、なければ表示名、それもなければユーザー名 */
function memberName(user: APIUser, member: GatewayMember | undefined): string {
	return member?.nick ?? user.global_name ?? user.username;
}
