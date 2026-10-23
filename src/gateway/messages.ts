import type { APIMessage } from "discord-api-types/v10";
import type { StoredMessageInput } from "../queue/messages";

/** Gatewayで届くメッセージのうち、Bobertが使う部分 */
export type GatewayMessage = Pick<
	APIMessage,
	| "id"
	| "channel_id"
	| "author"
	| "content"
	| "timestamp"
	| "edited_timestamp"
	| "mentions"
	| "attachments"
	| "message_reference"
	| "referenced_message"
> & {
	guild_id?: string;
	member?: { nick?: string | null };
};

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

/** 保存用の形に変換する */
export function toStoredMessage(message: GatewayMessage): StoredMessageInput {
	return {
		messageId: message.id,
		guildId: message.guild_id ?? null,
		channelId: message.channel_id,
		authorId: message.author.id,
		authorName:
			message.member?.nick ??
			message.author.global_name ??
			message.author.username,
		authorIsBot: message.author.bot === true,
		content: message.content,
		replyToId: message.message_reference?.message_id ?? null,
		attachments: message.attachments.map((attachment) => ({
			url: attachment.url,
			contentType: attachment.content_type ?? null,
			size: attachment.size,
		})),
		createdAt: Date.parse(message.timestamp),
		editedAt: message.edited_timestamp
			? Date.parse(message.edited_timestamp)
			: null,
	};
}
