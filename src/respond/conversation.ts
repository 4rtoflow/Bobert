import type { ChatMessage, ChatPart } from "../llm/types";
import type { AttachmentInfo, StoredMessageInput } from "../queue/messages";

/**
 * 返信のつながりをさかのぼる上限。
 * 長すぎる会話への備え。長い会話の要約ができるまでは、上限を設ける。
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

export interface ConversationOptions {
	botUserId: string;
	/** 画像をAIに渡すか(モデルが対応していて、本人の設定がONのとき) */
	includeImages: boolean;
	/** サーバーで見えている名前(人ごとに、最後に分かったもの)。なければ、メッセージに付いている名前を使う */
	names: ReadonlyMap<string, string>;
}

export interface Conversation {
	messages: ChatMessage[];
	/** 話しかけたメッセージに画像が添付されていたのに、AIに渡さなかった */
	imagesSkipped: boolean;
}

/**
 * 返信のつながり(古い順)を、AIに渡す会話に変換する(仕様: docs/spec/architecture.md「会話の文脈と過去の発言の保存」)。
 * - Bobertの発言はAIの発言、それ以外は「名前: 本文」の形の人の発言にする
 * - 画像は、新しいものから上限の枚数まで渡す。渡さない添付は、ファイル名だけを書き添える
 */
export function toConversation(
	chain: readonly StoredMessageInput[],
	options: ConversationOptions,
): Conversation {
	const images = options.includeImages
		? selectImages(chain, options.botUserId)
		: new Map<string, AttachmentInfo[]>();
	const messages: ChatMessage[] = [];
	for (const message of chain) {
		if (message.authorId === options.botUserId) {
			messages.push({
				role: "assistant",
				parts: [{ type: "text", text: botText(message) }],
			});
			continue;
		}
		const passed = images.get(message.messageId) ?? [];
		const notes = message.attachments
			.filter((attachment) => !passed.includes(attachment))
			.map(attachmentNote);
		messages.push({
			role: "user",
			parts: [
				{ type: "text", text: humanLine(message, options.names, notes) },
				...passed.map((image): ChatPart => ({ type: "image", url: image.url })),
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

/**
 * AIに渡す画像を選ぶ。新しいものから上限の枚数まで。Bobertの発言の添付は渡さない。
 * メッセージIDごとに、渡す添付を返す
 */
export function selectImages(
	chain: readonly StoredMessageInput[],
	botUserId: string,
): Map<string, AttachmentInfo[]> {
	const selected = new Map<string, AttachmentInfo[]>();
	let remaining = MAX_IMAGES;
	for (const message of [...chain].reverse()) {
		if (message.authorId === botUserId) {
			continue;
		}
		const images: AttachmentInfo[] = [];
		for (const attachment of message.attachments) {
			if (remaining > 0 && isReadableImage(attachment)) {
				images.push(attachment);
				remaining--;
			}
		}
		if (images.length > 0) {
			selected.set(message.messageId, images);
		}
	}
	return selected;
}

/**
 * メッセージを「名前: 本文」の文にする(道具の結果で使う)。添付は、ファイル名だけを書き添える。
 * Bobertの発言は、末尾の注記を外す。
 */
export function messageLine(
	message: StoredMessageInput,
	botUserId: string,
	names: ReadonlyMap<string, string>,
): string {
	if (message.authorId === botUserId) {
		return `${authorName(message, names)}: ${botText(message)}`;
	}
	return humanLine(message, names, message.attachments.map(attachmentNote));
}

/** 人の発言を「名前: 本文」の文にする。notesは、本文の後に書き添える */
function humanLine(
	message: StoredMessageInput,
	names: ReadonlyMap<string, string>,
	notes: readonly string[],
): string {
	const mentioned = new Map(
		message.mentions.map((user) => [user.id, names.get(user.id) ?? user.name]),
	);
	const body = [resolveMentions(message.content, mentioned), ...notes]
		.filter((text) => text !== "")
		.join("\n");
	return `${authorName(message, names)}: ${body}`;
}

function authorName(
	message: StoredMessageInput,
	names: ReadonlyMap<string, string>,
): string {
	return names.get(message.authorId) ?? message.authorName;
}

/** Bobertの発言。末尾に添えた注記は外す */
function botText(message: StoredMessageInput): string {
	return stripNotes(message.content) || "(本文なし)";
}

/** Bobertの返答の末尾に添えた注記(「-# 」で始まる小さな文字の行)を外す。会話の内容ではないため */
export function stripNotes(content: string): string {
	const lines = content.split("\n");
	while (lines.length > 0 && lines.at(-1)?.startsWith("-# ")) {
		lines.pop();
	}
	return lines.join("\n").trimEnd();
}

/** メンションなどの記法を、AIが読める形にする。namesは、メンションされた人のIDと名前 */
export function resolveMentions(
	content: string,
	names: ReadonlyMap<string, string>,
): string {
	return content
		.replace(
			/<@!?(\d+)>/g,
			(_, id: string) => `@${names.get(id) ?? "ユーザー"}`,
		)
		.replace(/<@&\d+>/g, "@ロール")
		.replace(/<a?:(\w+):\d+>/g, ":$1:");
}

function attachmentNote(attachment: AttachmentInfo): string {
	return isImage(attachment)
		? `[画像: ${attachment.filename}]`
		: `[添付ファイル: ${attachment.filename}]`;
}

function isImage(attachment: AttachmentInfo): boolean {
	return attachment.contentType?.startsWith("image/") ?? false;
}

function isReadableImage(attachment: AttachmentInfo): boolean {
	const type = attachment.contentType?.split(";")[0]?.trim() ?? "";
	return IMAGE_TYPES.has(type) && attachment.size <= MAX_IMAGE_BYTES;
}
