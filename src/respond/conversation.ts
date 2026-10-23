import type { APIAttachment, APIMessage, APIUser } from "discord-api-types/v10";
import { MessageType } from "../discord/constants";
import type { ChatMessage, ChatPart } from "../llm/types";

/**
 * 返信のつながりをさかのぼる上限。
 * メッセージの保存ができるまでは、Discordから1件ずつ読むので上限を設ける。
 */
export const MAX_CHAIN_LENGTH = 100;

/** AIに渡せる画像の形式 */
const IMAGE_TYPES = new Set([
	"image/jpeg",
	"image/png",
	"image/gif",
	"image/webp",
]);
/** 1枚あたりの大きさの上限(AnthropicのAPIの上限は5MB) */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** 1回に渡す画像の枚数の上限。新しいものから数える */
const MAX_IMAGES = 10;

/** メッセージを1件読む。消えているか、読めなければnull */
export type MessageFetcher = (
	channelId: string,
	messageId: string,
) => Promise<APIMessage | null>;

/**
 * 返信のつながりをさかのぼり、古い順に並べて返す(仕様: docs/spec/architecture.md「会話の文脈と過去の発言の保存」)。
 * 返信先が消えていたら、そこで止める。
 */
export async function fetchReplyChain(
	start: APIMessage,
	fetchMessage: MessageFetcher,
): Promise<APIMessage[]> {
	const chain = [start];
	let current = start;
	while (chain.length < MAX_CHAIN_LENGTH) {
		const reference = current.message_reference;
		// 返信だけをたどる。転送やピン留めの通知もmessage_referenceを持つため
		if (current.type !== MessageType.Reply || !reference?.message_id) {
			break;
		}
		// 返信先が消えているとnullになる
		if (current.referenced_message === null) {
			break;
		}
		// 取得したメッセージには、返信先が1段だけ含まれている
		const parent =
			current.referenced_message ??
			(await fetchMessage(
				reference.channel_id ?? current.channel_id,
				reference.message_id,
			));
		if (!parent) {
			break;
		}
		chain.push(parent);
		current = parent;
	}
	return chain.reverse();
}

export interface ConversationOptions {
	botUserId: string;
	/** 画像をAIに渡すか(モデルが対応していて、本人の設定がONのとき) */
	includeImages: boolean;
}

export interface Conversation {
	messages: ChatMessage[];
	/** 話しかけたメッセージに画像が添付されていたのに、AIに渡さなかった */
	imagesSkipped: boolean;
}

/**
 * 返信のつながりを、AIに渡す会話に変換する。
 * - Bobertの発言はAIの発言、それ以外は「名前: 本文」の形の人の発言にする
 * - 画像は、新しいものから上限の枚数まで渡す。渡さない添付は、ファイル名だけを書き添える
 */
export function toConversation(
	chain: readonly APIMessage[],
	options: ConversationOptions,
): Conversation {
	let remainingImages = options.includeImages ? MAX_IMAGES : 0;
	const messages: ChatMessage[] = [];
	for (const message of [...chain].reverse()) {
		if (message.author.id === options.botUserId) {
			messages.unshift({
				role: "assistant",
				parts: [{ type: "text", text: botText(message) }],
			});
			continue;
		}
		const images: ChatPart[] = [];
		const notes: string[] = [];
		for (const attachment of message.attachments) {
			if (remainingImages > 0 && isReadableImage(attachment)) {
				images.push({ type: "image", url: attachment.url });
				remainingImages--;
			} else {
				notes.push(
					isImage(attachment)
						? `[画像: ${attachment.filename}]`
						: `[添付ファイル: ${attachment.filename}]`,
				);
			}
		}
		const body = [resolveMentions(message.content, message.mentions), ...notes]
			.filter((text) => text !== "")
			.join("\n");
		messages.unshift({
			role: "user",
			parts: [
				{ type: "text", text: `${displayName(message.author)}: ${body}` },
				...images,
			],
		});
	}
	// AIへの会話は人の発言から始める必要がある
	if (messages[0]?.role === "assistant") {
		messages.unshift({
			role: "user",
			parts: [{ type: "text", text: "(これより前の会話は残っていません)" }],
		});
	}

	const last = chain.at(-1);
	return {
		messages,
		imagesSkipped:
			!options.includeImages && (last?.attachments.some(isImage) ?? false),
	};
}

/** Bobertの発言。末尾に添えた注記(「-# 」で始まる小さな文字の行)は、会話の内容ではないので外す */
function botText(message: APIMessage): string {
	const lines = message.content.split("\n");
	while (lines.length > 0 && lines.at(-1)?.startsWith("-# ")) {
		lines.pop();
	}
	return lines.join("\n").trimEnd() || "(本文なし)";
}

function displayName(user: APIUser): string {
	return user.global_name ?? user.username;
}

/** メンションなどの記法を、AIが読める形にする */
function resolveMentions(
	content: string,
	mentions: readonly APIUser[],
): string {
	const names = new Map(mentions.map((user) => [user.id, displayName(user)]));
	return content
		.replace(
			/<@!?(\d+)>/g,
			(_, id: string) => `@${names.get(id) ?? "ユーザー"}`,
		)
		.replace(/<@&\d+>/g, "@ロール")
		.replace(/<a?:(\w+):\d+>/g, ":$1:");
}

function isImage(attachment: APIAttachment): boolean {
	return attachment.content_type?.startsWith("image/") ?? false;
}

function isReadableImage(attachment: APIAttachment): boolean {
	const type = attachment.content_type?.split(";")[0]?.trim() ?? "";
	return IMAGE_TYPES.has(type) && attachment.size <= MAX_IMAGE_BYTES;
}
