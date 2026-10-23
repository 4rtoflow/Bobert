/** Queueで受け渡す仕事。RESPOND_QUEUEはRespondJob、INGEST_QUEUEはそれ以外を運ぶ。 */
export type QueueMessage = RespondJob | IngestJob | DeleteJob | ImportJob;

/** 応答の生成。会話の履歴を組み立ててLLMを呼び、Discordに返信する。 */
export interface RespondJob {
	kind: "respond";
	/** 応答のきっかけになったメッセージ(重複除去のキーにもなる) */
	messageId: string;
	channelId: string;
	guildId: string | null;
	/** 話しかけた人。この人の資格情報と設定を使う */
	authorId: string;
}

/** 受け取ったメッセージの保存とベクトル化。 */
export interface IngestJob {
	kind: "ingest";
	message: StoredMessageInput;
}

/** Discordで削除されたメッセージを、保存分からも消す。 */
export interface DeleteJob {
	kind: "delete";
	channelId: string;
	messageIds: string[];
}

/** 過去ログの取り込み。beforeより古いメッセージを1回分(最大100件)取り込む。 */
export interface ImportJob {
	kind: "import";
	channelId: string;
	before: string | null;
}

export interface StoredMessageInput {
	messageId: string;
	guildId: string | null;
	channelId: string;
	authorId: string;
	authorName: string;
	authorIsBot: boolean;
	content: string;
	replyToId: string | null;
	attachments: AttachmentInfo[];
	/** 投稿時刻(UNIX時間のミリ秒) */
	createdAt: number;
	/** 編集時刻(UNIX時間のミリ秒) */
	editedAt: number | null;
}

export interface AttachmentInfo {
	url: string;
	contentType: string | null;
	size: number;
}
