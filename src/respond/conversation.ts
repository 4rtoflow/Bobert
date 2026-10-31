import type { ChatMessage, ChatPart } from "../llm/types";
import type {
	AttachmentInfo,
	EmbedInfo,
	StoredMessageInput,
} from "../queue/messages";
import { type FileCatalog, isImage, isReadableImage } from "./attachments";
import { formatJst } from "./time";

/** 1回に渡す画像の枚数の上限。新しいものから数える */
const MAX_IMAGES = 10;

export interface ConversationOptions {
	botUserId: string;
	/** 画像をAIに渡すか(モデルが画像を読めるとき) */
	includeImages: boolean;
	/** サーバーで見えている名前(人ごとに、最後に分かったもの)。なければ、メッセージに付いている名前を使う */
	names: ReadonlyMap<string, string>;
	/** 会話の古い部分の要約。あれば、会話の最初に渡す */
	summary?: string | null;
	/**
	 * AIに見せた添付ファイルの一覧(ファイルを読む道具を渡すとき)。あれば、渡さない添付ファイルに番号を付ける。
	 * なければ、ファイル名だけを書き添える
	 */
	files?: FileCatalog;
	/** いちばん古い発言の返信先が削除されている。そのことを、いちばん古い発言に書き添える */
	parentDeleted?: boolean;
}

/** 編集されたメッセージ(Bobert以外)の本文の後に書き添える。Discordの画面の表示と同じ */
export const EDITED_NOTE = "(編集済み)";

/** 返信先が削除されていて、それより前をたどれなかったメッセージに書き添える */
export const PARENT_DELETED_NOTE = "(返信先のメッセージは削除されています)";

export interface Conversation {
	messages: ChatMessage[];
	/** 話しかけたメッセージに画像が添付されていたのに、AIに渡さなかった */
	imagesSkipped: boolean;
}

/**
 * 返信のつながり(古い順)を、AIに渡す会話に変換する(仕様: docs/spec/architecture.md「会話の文脈と過去の発言の保存」)。
 * - Bobertの発言はAIの発言、それ以外は「[時刻] 名前: 本文」の形の人の発言にする。時刻は日本時間で、
 *   話しかけた発言の時刻が今の日時にあたる。発言の形は毎回同じなので、キャッシュは崩れない
 * - 画像は、新しいものから上限の枚数まで渡す。渡さない添付は、番号(ファイルを読む道具で読める)か、ファイル名を書き添える
 * - 古い部分の要約があれば、会話の最初に、人の発言として渡す
 * - いちばん古い発言の返信先が削除されていれば、そのことを書き添える
 */
export function toConversation(
	chain: readonly StoredMessageInput[],
	options: ConversationOptions,
): Conversation {
	const images = options.includeImages
		? selectImages(chain, options.botUserId)
		: new Map<string, AttachmentInfo[]>();
	const messages: ChatMessage[] = [];
	for (const [index, message] of chain.entries()) {
		if (message.authorId === options.botUserId) {
			messages.push({
				role: "assistant",
				parts: [{ type: "text", text: botText(message) }],
			});
			continue;
		}
		const passed = images.get(message.messageId) ?? [];
		const notes = [
			...message.attachments
				.filter((attachment) => !passed.includes(attachment))
				.map((attachment) =>
					attachmentNote(message, attachment, options.files),
				),
			...(index === 0 && options.parentDeleted ? [PARENT_DELETED_NOTE] : []),
		];
		messages.push({
			role: "user",
			parts: [
				{ type: "text", text: humanLine(message, options.names, notes) },
				...passed.map((image): ChatPart => ({ type: "image", url: image.url })),
			],
		});
	}
	if (options.summary) {
		messages.unshift({
			role: "user",
			parts: [
				{
					type: "text",
					text: `(これより前の会話の要約です)\n${options.summary}`,
				},
			],
		});
	}
	// AIへの会話は人の発言から始める必要がある。Bobertの発言の返信先が削除されていれば、そのことを伝える
	if (messages[0]?.role === "assistant") {
		messages.unshift({
			role: "user",
			parts: [
				{
					type: "text",
					text: options.parentDeleted
						? PARENT_DELETED_NOTE
						: "(これより前の会話は残っていません)",
				},
			],
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
 * メッセージを「[時刻] 名前: 本文」の文にする(道具の結果で使う)。Bobertの発言にも時刻を付ける。Embedの中身と、添付ファイルを書き添える。
 * Bobertの発言は、末尾の注記を外す。
 * placeを渡すと、時刻の後に書く(今いるチャンネル以外のメッセージの、チャンネルの名前。例: 「[時刻] #雑談 名前: 本文」)。
 * filesを渡すと、添付ファイルに番号を付ける(ファイルを読む道具で読める)。なければ、ファイル名だけを書き添える
 */
export function messageLine(
	message: StoredMessageInput,
	botUserId: string,
	names: ReadonlyMap<string, string>,
	place: string | null = null,
	files?: FileCatalog,
): string {
	const where = place === null ? "" : `${place} `;
	if (message.authorId === botUserId) {
		return `[${formatJst(message.createdAt)}] ${where}${authorName(message, names)}: ${botText(message)}`;
	}
	return humanLine(
		message,
		names,
		message.attachments.map((attachment) =>
			attachmentNote(message, attachment, files),
		),
		where,
	);
}

/**
 * Bobert以外の発言を「[時刻] 名前: 本文」の文にする。本文の後に、Embedの中身と、notes(添付のファイル名など)を書き添える。
 * ほかのBotの発言は、名前にBotであることと、どのコマンドへの返答かを書き添える。whereは、時刻の後に書く。
 * 編集されたメッセージは、本文の後に「(編集済み)」と書き添える
 */
function humanLine(
	message: StoredMessageInput,
	names: ReadonlyMap<string, string>,
	notes: readonly string[],
	where = "",
): string {
	const mentioned = new Map(
		message.mentions.map((user) => [user.id, names.get(user.id) ?? user.name]),
	);
	const embeds = message.embeds.map(
		(embed) =>
			`[Embed] ${resolveMentions(embedLines(embed).join("\n"), mentioned)}`,
	);
	const content = resolveMentions(message.content, mentioned);
	const text =
		!message.authorIsBot && looksLikeCommand(content)
			? `${content}${TEXT_COMMAND_NOTE}`
			: content;
	const body = [
		message.editedAt === null ? text : `${text}${EDITED_NOTE}`,
		...embeds,
		...notes,
	]
		.filter((text) => text !== "")
		.join("\n");
	return `[${formatJst(message.createdAt)}] ${where}${speakerLabel(message, names)}: ${body}`;
}

/**
 * 「/」と英数字で始まる人の発言に添える一言。スラッシュコマンドを使っても使った人の発言は残らないので、
 * こうした発言は、文字で送っただけのもの。AIが、コマンドの実行と取り違えないようにする
 */
const TEXT_COMMAND_NOTE = "(文字の発言で、コマンドの実行ではありません)";

/** スラッシュコマンドのように見えるか(「/」と英数字で始まる) */
function looksLikeCommand(content: string): boolean {
	return /^\/[\p{L}\p{N}_-]+/u.test(content.trimStart());
}

/** 発言者の名前。ほかのBotなら、Botであることと、どのコマンドへの返答か(誰が使ったか)を書き添える */
function speakerLabel(
	message: StoredMessageInput,
	names: ReadonlyMap<string, string>,
): string {
	const name = authorName(message, names);
	if (!message.authorIsBot) {
		return name;
	}
	const { command } = message;
	if (command === null) {
		return `${name}(Bot)`;
	}
	const user = names.get(command.userId) ?? command.userName;
	const used = command.contextMenu ? `「${command.name}」` : `/${command.name}`;
	return `${name}(Bot。${user}が使った ${used} への返答)`;
}

/**
 * Embedの中身を、文字の行にする。提供元と作者、タイトル、説明、項目、フッターの順。
 * 検索用のデータ化(ベクトルにする文)でも使う
 */
export function embedLines(embed: EmbedInfo): string[] {
	const head = [embed.provider, embed.author]
		.filter((part) => part !== undefined && part !== "")
		.join(" / ");
	return [
		head,
		embed.title ?? "",
		embed.description ?? "",
		...(embed.fields ?? []).map((field) => `${field.name}: ${field.value}`),
		embed.footer ?? "",
	].filter((line) => line !== "");
}

function authorName(
	message: StoredMessageInput,
	names: ReadonlyMap<string, string>,
): string {
	return names.get(message.authorId) ?? message.authorName;
}

/** Bobertの発言。末尾に添えた注記は外す */
function botText(message: StoredMessageInput): string {
	return stripNotes(stripReplyHeader(message.content)) || "(本文なし)";
}

/**
 * AIが会話の書式をまねて返答の先頭に書いた、「[時刻] 名前: 」の部分。時刻は会話と同じ日本時間の書式で、
 * 後に、ほかのチャンネルの名前(道具の結果の書式)と、Bobertの名前が続くことがある。時刻がなくても、先頭の「Bobert: 」は外す
 */
const REPLY_HEADER =
	/^\s*(?:\[\d{4}-\d{2}-\d{2}\([日月火水木金土]\) \d{2}:\d{2}\]\s*(?:#\S+\s+)?(?:Bobert\s*[:：]\s*)?|Bobert\s*[:：]\s*)/i;

/**
 * AIの返答の先頭に付いた「[時刻] Bobert: 」を外す(仕様: docs/spec/architecture.md「会話の並べ方」)。
 * 投稿する前と、過去の返答をAIに渡す前に外す。残っていると、AIがそれを見て、またまねるため
 */
export function stripReplyHeader(text: string): string {
	return text.replace(REPLY_HEADER, "");
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

/**
 * 添付ファイルに書き添える文。filesがあれば、番号(読めるとき)か、読めない理由を書く。
 * なければ(ファイルを読む道具を渡さないとき)、ファイル名だけを書く
 */
function attachmentNote(
	message: StoredMessageInput,
	attachment: AttachmentInfo,
	files: FileCatalog | undefined,
): string {
	if (files) {
		return files.note(message, attachment);
	}
	return isImage(attachment)
		? `[画像: ${attachment.filename}]`
		: `[添付ファイル: ${attachment.filename}]`;
}
