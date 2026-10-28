import type { ChannelInfo } from "../discord/channels";

/**
 * Queueで受け渡す仕事。RESPOND_QUEUEはRespondJobとExplainJobとCompactJobとImportCommandJob、
 * INGEST_QUEUEはそれ以外を運ぶ。
 */
export type QueueMessage =
	| RespondJob
	| ExplainJob
	| CompactJob
	| ImportCommandJob
	| IngestJob
	| DeleteJob
	| ImportJob
	| ChannelSyncJob
	| ReindexJob;

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

/**
 * 右クリックメニューの「Bobertに聞く」。選んだ人のキーと設定で、メッセージの意味をAIに説明してもらい、
 * 保留にした応答(チャンネルに見える)を書き換えて投稿する。
 */
export interface ExplainJob {
	kind: "explain";
	/** InteractionのID。同じInteractionで2回投稿しないために使う */
	interactionId: string;
	/** Interactionのトークン。保留にした応答を書き換えるのに使う(15分で切れる) */
	interactionToken: string;
	/** 選んだ人。この人の資格情報と設定を使う */
	userId: string;
	/** 選んだ人の、サーバーで見えている名前 */
	userName: string;
	channelId: string;
	guildId: string | null;
	/** 説明するメッセージ(Interactionに含まれていたもの) */
	target: StoredMessageInput;
	/** 説明を頼まれた時刻(UNIX時間のミリ秒)。今の日時として、AIに伝える */
	requestedAt: number;
}

/**
 * 会話の要約(要約を勧める案内の「今すぐ要約」ボタンと、右クリックメニューの「会話を要約」)。
 * 押した人(選んだ人)のキーで要約し、保留にした応答を、結果に書き換える。
 */
export interface CompactJob {
	kind: "compact";
	/** Interactionのトークン。保留にした応答を書き換えるのに使う(15分で切れる) */
	interactionToken: string;
	/** 押した人(選んだ人)。この人の資格情報と設定を使う */
	userId: string;
	channelId: string;
	guildId: string | null;
	/** このメッセージまでの会話を要約する(Interactionに含まれていたもの) */
	start: StoredMessageInput;
	/** 案内のボタンから要約したときは、そのボタンを消すメッセージ */
	buttonMessageId: string | null;
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

/**
 * `/import`の実行。公開チャンネルと公開スレッドを列挙して、過去ログの取り込みを始め、
 * 保留にした応答(実行したチャンネルの全員に見える)を、進み具合の表示にする。
 */
export interface ImportCommandJob {
	kind: "import_command";
	/** InteractionのID。同じInteractionで2回始めないために使う */
	interactionId: string;
	/** Interactionのトークン。保留にした応答を書き換えるのに使う(15分で切れる) */
	interactionToken: string;
	guildId: string;
	/** 実行したチャンネル */
	channelId: string;
	/** 実行した人 */
	userId: string;
	/** 実行した時刻(UNIX時間のミリ秒)。Interactionのトークンが切れる時刻の計算に使う */
	requestedAt: number;
}

/**
 * チャンネル・スレッド・ロールの作成・変更・削除を、記録に反映する
 * (仕様: docs/spec/architecture.md「サーバー全体の公開チャンネル」)。
 */
export interface ChannelSyncJob {
	kind: "channels";
	guildId: string;
	/** 通知を受け取った時刻(UNIX時間のミリ秒)。古い通知で上書きしないため */
	syncedAt: number;
	/** @everyoneの権限(サーバーの情報や、ロールの変更の通知で分かったとき) */
	everyonePermissions?: string;
	/** 作成・変更されたチャンネルとスレッド */
	channels?: ChannelInfo[];
	/** 削除されたチャンネルとスレッド */
	deleted?: string[];
	/**
	 * サーバーの全チャンネル(スレッドを除く)のID。サーバーの情報(GUILD_CREATE)で届いたとき。
	 * 記録にあってここにないチャンネルは、Botが止まっていた間に削除されたとみなす
	 */
	allChannelIds?: string[];
}

/** 保存したメッセージのベクトルを、afterより後のものから1回分入れ直す(メタデータを足したときなど) */
export interface ReindexJob {
	kind: "reindex";
	after: string | null;
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
