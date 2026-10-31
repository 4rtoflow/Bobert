import { IMPORT_COMMAND_NAME } from "../import/progress";
import { logEvent } from "../log";
import { type Embedder, embeddingText } from "../store/embedding";
import {
	clearEmbedded,
	deleteStoredMessages,
	findMessagesToEmbed,
	markEmbedded,
	messageIdsAfter,
	messageVersion,
	saveMessages,
} from "../store/messages";
import { deleteMessageReactions } from "../store/reactions";
import { type ChannelDeps, resolveSharedChannels } from "./channels";
import type { ReindexJob, StoredMessageInput } from "./messages";

/** 1回でベクトルにする文の数。過去ログの取り込みでは1回に100件届くので、分けて送る */
const EMBED_BATCH_SIZE = 50;
/** ベクトルの入れ直しで、1回に入れ直すメッセージの数 */
const REINDEX_PAGE_SIZE = 100;

/** 保存とベクトル化に使うもの。テストでは偽物に差し替える */
export interface IngestDeps extends ChannelDeps {
	/**
	 * Vectorizeの索引。生成された型(VectorizeIndex)は古いベータ版のもので、戻り値が今の版と違う。
	 * 戻り値は使わないので、どちらでも受け取れる形にしておく
	 */
	vectors: {
		upsert(vectors: VectorizeVector[]): Promise<unknown>;
		deleteByIds(ids: string[]): Promise<unknown>;
	};
	embed: Embedder;
}

/**
 * 受け取ったメッセージを保存し、ベクトルを入れる(仕様: docs/spec/architecture.md「会話の文脈と過去の発言の保存」)。
 * 保存したメッセージの数を返す。
 * - 保存するのは、共有チャンネル(Botが見られて、年齢制限がないチャンネルと、その中の公開スレッド)のメッセージだけ。
 *   年齢制限のチャンネルと、非公開スレッドのメッセージは保存しない
 * - `/import`の進み具合のメッセージは保存しない。会話ではないうえ、5秒おきに書き換わるため
 * - ベクトルのIDはメッセージID、名前空間はチャンネルID。メタデータに発言者IDと時刻、サーバーIDを付ける
 * - ベクトルを入れるのは、新しいメッセージと、本文が変わったものだけ
 * - 本文が空になったもの(添付だけなど)は、ベクトルにしない。編集で空になったら、前のベクトルを消す
 */
export async function ingestMessages(
	messages: readonly StoredMessageInput[],
	deps: IngestDeps,
): Promise<number> {
	// 同じメッセージが何度か届いたら(作成と編集など)、いちばん新しい版だけを使う
	const latest = new Map<string, StoredMessageInput>();
	for (const message of messages) {
		const current = latest.get(message.messageId);
		if (!current || messageVersion(message) >= messageVersion(current)) {
			latest.set(message.messageId, message);
		}
	}
	const candidates = [...latest.values()].filter(
		(message) => !isImportProgress(message, deps.botUserId),
	);
	const visible = await resolveSharedChannels(candidates, deps);
	const kept = candidates.filter((message) => visible.has(message.channelId));
	await saveMessages(deps.db, kept);
	const { embedded, emptied } = await embedMessages(
		kept.map((message) => message.messageId),
		deps,
	);
	logEvent("queue", "ingested", {
		messages: latest.size,
		saved: kept.length,
		embedded,
		emptied,
	});
	return kept.length;
}

/** `/import`の進み具合のメッセージ(Bobertの、`/import`への返答)か */
export function isImportProgress(
	message: Pick<StoredMessageInput, "authorId" | "command">,
	botUserId: string,
): boolean {
	return (
		message.authorId === botUserId &&
		message.command?.name === IMPORT_COMMAND_NAME
	);
}

/**
 * 保存したメッセージのうち、まだベクトルを入れていないものに、ベクトルを入れる。
 * 本文が空になったもの(編集で空になったもの)は、前のベクトルを消す
 */
async function embedMessages(
	messageIds: readonly string[],
	deps: IngestDeps,
): Promise<{ embedded: number; emptied: number }> {
	const targets = await findMessagesToEmbed(deps.db, messageIds);
	const texts = targets.map((message) => ({
		message,
		text: embeddingText(message, deps.botUserId),
	}));
	const embeddable = texts.filter(({ text }) => text !== "");
	const emptied = texts
		.filter(({ text, message }) => text === "" && message.editedAt !== null)
		.map(({ message }) => message.messageId);

	for (let i = 0; i < embeddable.length; i += EMBED_BATCH_SIZE) {
		const batch = embeddable.slice(i, i + EMBED_BATCH_SIZE);
		const values = await deps.embed(batch.map(({ text }) => text));
		await deps.vectors.upsert(
			batch.map(({ message }, j) => ({
				id: message.messageId,
				namespace: message.channelId,
				values: values[j] as number[],
				metadata: {
					author_id: message.authorId,
					created_at: message.createdAt,
					// サーバー全体を探すときに、サーバーで絞り込む
					...(message.guildId === null ? {} : { guild_id: message.guildId }),
				},
			})),
		);
		await markEmbedded(
			deps.db,
			batch.map(({ message }) => message),
		);
	}
	if (emptied.length > 0) {
		await deps.vectors.deleteByIds(emptied);
	}
	return { embedded: embeddable.length, emptied: emptied.length };
}

/** 削除されたメッセージを、D1とVectorizeから消す。リアクションの記録も消す */
export async function deleteMessages(
	messageIds: readonly string[],
	deps: IngestDeps,
): Promise<void> {
	const ids = [...new Set(messageIds)];
	await deleteStoredMessages(deps.db, ids);
	await deleteMessageReactions(deps.db, ids);
	await deps.vectors.deleteByIds(ids);
	logEvent("queue", "deleted", { messages: ids.length });
}

/**
 * 保存したメッセージのベクトルを、1回分入れ直す(メタデータにサーバーIDを足したときなど)。
 * 続きがあれば、続きの仕事を入れる。管理用エンドポイントから始める
 */
export async function reindexPage(
	job: ReindexJob,
	deps: IngestDeps & {
		continueReindex: (job: ReindexJob) => Promise<void>;
	},
): Promise<void> {
	const ids = await messageIdsAfter(deps.db, job.after, REINDEX_PAGE_SIZE);
	if (ids.length > 0) {
		await clearEmbedded(deps.db, ids);
		await embedMessages(ids, deps);
	}
	const last = ids.at(-1);
	if (ids.length === REINDEX_PAGE_SIZE && last !== undefined) {
		await deps.continueReindex({ kind: "reindex", after: last });
		return;
	}
	logEvent("queue", "reindex_done", {});
}
