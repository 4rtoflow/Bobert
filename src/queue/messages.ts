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
	/**
	 * 話しかけたメッセージで分かった、サーバーで見えている名前(発言者と、メンションされた人)。
	 * 保存より先に応答の処理が動くことがあるので、ここで渡す。デプロイの前に入った仕事にはない
	 */
	members?: UserName[];
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

/** 過去ログの取り込み。beforeより古いメッセージを1回分(最大100件)取り込む。nullなら、いちばん新しいものから */
export interface ImportJob {
	kind: "import";
	channelId: string;
	guildId: string | null;
	before: string | null;
}

export interface StoredMessageInput {
	messageId: string;
	guildId: string | null;
	channelId: string;
	authorId: string;
	/** 発言者の名前。サーバーのニックネームを優先する(分かるのは、Gatewayで届いたときだけ) */
	authorName: string;
	authorIsBot: boolean;
	content: string;
	/** 返信先。返信のときだけ入れる(転送やピン留めの通知も、返信先と同じ項目を持つため) */
	replyToId: string | null;
	/** メンションされた人。本文のメンションを名前に置き換えるのに使う */
	mentions: UserName[];
	attachments: AttachmentInfo[];
	/** Embedの中身(他のBotの投稿の埋め込みや、リンクのプレビュー) */
	embeds: EmbedInfo[];
	/** コマンドへの返答なら、どのコマンドを誰が使ったか */
	command: CommandInfo | null;
	/**
	 * このメッセージで分かった、サーバーで見えている名前(発言者と、メンションされた人)。
	 * サーバーでの情報(ニックネームの有無)が付いていた人だけ
	 */
	members: UserName[];
	/** 投稿時刻(UNIX時間のミリ秒) */
	createdAt: number;
	/** 編集時刻(UNIX時間のミリ秒) */
	editedAt: number | null;
}

/** 人のIDと名前 */
export interface UserName {
	id: string;
	name: string;
}

/** Embedの中身のうち、文字の部分。ないものは入れない */
export interface EmbedInfo {
	/** 提供元(リンクのプレビューのサイト名など) */
	provider?: string;
	author?: string;
	title?: string;
	description?: string;
	fields?: { name: string; value: string }[];
	footer?: string;
}

/** コマンドへの返答の情報 */
export interface CommandInfo {
	/** コマンドの名前。サブコマンドを含む(例: "add store")。右クリックメニューなら、項目の名前 */
	name: string;
	/** 右クリックメニューのコマンドか。違えばスラッシュコマンド */
	contextMenu: boolean;
	/** コマンドを使った人 */
	userId: string;
	userName: string;
}

export interface AttachmentInfo {
	filename: string;
	/** 期限付き(約24時間)。AIに渡すときは、Discordから新しいURLを取り直す */
	url: string;
	contentType: string | null;
	size: number;
}
