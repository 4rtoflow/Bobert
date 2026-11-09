import {
	addOwnReaction,
	createMessage,
	DiscordApiError,
	deleteMessage,
	deleteOwnReaction,
	editChannelMessage,
} from "../discord/api";
import { MessageFlags } from "../discord/constants";
import { logEvent } from "../log";
import type { KnowledgeProgress } from "../queue/messages";
import { knowledgeFilesOfMessages } from "../store/knowledge";
import { knowledgeProgress } from "./texts";

/**
 * 知識のファイルの読み込みの進み具合を、ファイルのメッセージに見せる(仕様: docs/spec/behavior.md「知識チャンネル」)。
 * - 受け付けたら、メッセージに👀を付け、進み具合を返信で見せる(小さい文字。全員に見えるが、通知はしない)
 * - 中身を読み取ったら、返信を書き換える
 * - メッセージのファイルがすべて終わったら(知識に入ったか、加えなかったか、消された)、👀を外して、返信を消す。
 *   すべて知識に入っていたら、✅を付ける
 * Botは、チャンネルに、本人にだけ見えるメッセージを送れない(インタラクションへの返事でしか送れない)ので、返信にした。
 * 見せるだけのことなので、うまくいかなくても(権限がない、メッセージが消えたなど)、記録だけ残して続ける
 */

/** 読み込んでいる間、ファイルのメッセージに付けるリアクション */
export const KNOWLEDGE_LOADING_EMOJI = "👀";

/** メッセージのファイルが、すべて知識に入ったら付けるリアクション */
export const KNOWLEDGE_LOADED_EMOJI = "✅";

/** 進み具合を見せるのに使う、DiscordのAPI。うまくいかなくても、例外にしない */
export interface KnowledgeProgressApi {
	/** メッセージに、Botのリアクションを付ける */
	react: (channelId: string, messageId: string, emoji: string) => Promise<void>;
	/** Botが付けたリアクションを外す */
	unreact: (
		channelId: string,
		messageId: string,
		emoji: string,
	) => Promise<void>;
	/** メッセージに、通知しない返信を送る。送れたら返信のID、送れなければnull */
	reply: (
		channelId: string,
		messageId: string,
		content: string,
	) => Promise<string | null>;
	/** 返信を書き換える */
	edit: (channelId: string, replyId: string, content: string) => Promise<void>;
	/** 返信を消す */
	remove: (channelId: string, replyId: string) => Promise<void>;
}

/** 本物のDiscordのAPIを使う */
export function discordProgressApi(botToken: string): KnowledgeProgressApi {
	return {
		react: async (channelId, messageId, emoji) => {
			await attempt("react", () =>
				addOwnReaction(botToken, channelId, messageId, emoji),
			);
		},
		unreact: async (channelId, messageId, emoji) => {
			await attempt("unreact", () =>
				deleteOwnReaction(botToken, channelId, messageId, emoji),
			);
		},
		reply: async (channelId, messageId, content) => {
			const sent = await attempt("reply", () =>
				createMessage(botToken, channelId, {
					content,
					message_reference: {
						message_id: messageId,
						fail_if_not_exists: true,
					},
					// 誰にも通知しない(送った人へのメンションも、プッシュ通知も)
					allowed_mentions: { parse: [], replied_user: false },
					flags: MessageFlags.SuppressNotifications,
				}),
			);
			return sent?.id ?? null;
		},
		edit: async (channelId, replyId, content) => {
			await attempt("edit", () =>
				editChannelMessage(botToken, channelId, replyId, { content }),
			);
		},
		remove: async (channelId, replyId) => {
			await attempt("remove", () =>
				deleteMessage(botToken, channelId, replyId),
			);
		},
	};
}

/**
 * 受け付けたファイルのメッセージに、👀を付け、進み具合の返信を送る(どのファイルも、中身を読み取る段階)。
 * 仕事に渡す、メッセージと返信を返す
 */
export async function startKnowledgeProgress(
	api: KnowledgeProgressApi,
	message: { channelId: string; messageId: string },
	filenames: readonly string[],
): Promise<KnowledgeProgress> {
	const { channelId, messageId } = message;
	await api.react(channelId, messageId, KNOWLEDGE_LOADING_EMOJI);
	const replyId = await api.reply(
		channelId,
		messageId,
		knowledgeProgress(
			filenames.map((filename) => ({ filename, converted: false })),
		),
	);
	return { channelId, messageId, replyId };
}

/**
 * ファイルのメッセージに、今の進み具合を見せ直す。中身を読み取ったときと、ファイルの読み込みが終わったときに呼ぶ。
 * 読み込み中のファイルが残っていれば、返信をその一覧に書き換える。残っていなければ、
 * すべて知識に入ったときだけ✅を付け、👀を外して、返信を消す。progressがなければ(進み具合を見せていない仕事)、何もしない。
 * 同じメッセージのほかのファイルの仕事と同時に動いても困らないよう、どれも、何度しても同じ結果になる操作にする
 */
export async function refreshKnowledgeProgress(
	db: D1Database,
	api: KnowledgeProgressApi,
	progress: KnowledgeProgress | undefined,
): Promise<void> {
	if (progress === undefined) {
		return;
	}
	const { channelId, messageId, replyId } = progress;
	const files = await attempt("load", () =>
		knowledgeFilesOfMessages(db, [messageId]),
	);
	if (files === null) {
		return;
	}
	const loading = files
		.filter((file) => file.state === "pending" || file.state === "converted")
		.sort((a, b) => a.id - b.id);
	if (loading.length > 0) {
		if (replyId !== null) {
			await api.edit(
				channelId,
				replyId,
				knowledgeProgress(
					loading.map((file) => ({
						filename: file.filename,
						converted: file.state === "converted",
					})),
				),
			);
		}
		return;
	}
	if (files.length > 0 && files.every((file) => file.state === "ready")) {
		await api.react(channelId, messageId, KNOWLEDGE_LOADED_EMOJI);
	}
	await api.unreact(channelId, messageId, KNOWLEDGE_LOADING_EMOJI);
	if (replyId !== null) {
		await api.remove(channelId, replyId);
	}
}

/**
 * 呼んでみて、うまくいかなければ、記録だけ残してnullを返す。
 * 消えていた(読み込み中に、ファイルのメッセージか返信が消された)ときは、片付けるものがないだけなので、記録しない
 */
async function attempt<T>(
	action: string,
	call: () => Promise<T>,
): Promise<T | null> {
	try {
		return await call();
	} catch (error) {
		if (!(error instanceof DiscordApiError && error.status === 404)) {
			logEvent("knowledge", "progress_failed", {
				action,
				status: error instanceof DiscordApiError ? error.status : null,
				code: error instanceof DiscordApiError ? error.code : null,
				error: error instanceof Error ? error.name : "unknown",
			});
		}
		return null;
	}
}
