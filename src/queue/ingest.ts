import { logEvent } from "../log";
import { type Embedder, embeddingText } from "../store/embedding";
import {
	deleteStoredMessages,
	findMessagesToEmbed,
	markEmbedded,
	messageVersion,
	saveMessages,
} from "../store/messages";
import type { StoredMessageInput } from "./messages";

/** 保存とベクトル化に使うもの。テストでは偽物に差し替える */
export interface IngestDeps {
	db: D1Database;
	/**
	 * Vectorizeの索引。生成された型(VectorizeIndex)は古いベータ版のもので、戻り値が今の版と違う。
	 * 戻り値は使わないので、どちらでも受け取れる形にしておく
	 */
	vectors: {
		upsert(vectors: VectorizeVector[]): Promise<unknown>;
		deleteByIds(ids: string[]): Promise<unknown>;
	};
	embed: Embedder;
	/** Bobert自身のユーザーID。返答の末尾の注記を、ベクトルにする文から外すため */
	botUserId: string;
}

/**
 * 受け取ったメッセージを保存し、ベクトルを入れる(仕様: docs/spec/architecture.md「会話の文脈と過去の発言の保存」)。
 * - ベクトルのIDはメッセージID、名前空間はチャンネルID。メタデータに発言者IDと時刻を付ける
 * - ベクトルを入れるのは、新しいメッセージと、本文が変わったものだけ
 * - 本文が空になったもの(添付だけなど)は、ベクトルにしない。編集で空になったら、前のベクトルを消す
 */
export async function ingestMessages(
	messages: readonly StoredMessageInput[],
	deps: IngestDeps,
): Promise<void> {
	// 同じメッセージが何度か届いたら(作成と編集など)、いちばん新しい版だけを使う
	const latest = new Map<string, StoredMessageInput>();
	for (const message of messages) {
		const current = latest.get(message.messageId);
		if (!current || messageVersion(message) >= messageVersion(current)) {
			latest.set(message.messageId, message);
		}
	}
	await saveMessages(deps.db, [...latest.values()]);

	const targets = await findMessagesToEmbed(deps.db, [...latest.keys()]);
	const texts = targets.map((message) => ({
		message,
		text: embeddingText(message, deps.botUserId),
	}));
	const embeddable = texts.filter(({ text }) => text !== "");
	const emptied = texts
		.filter(({ text, message }) => text === "" && message.editedAt !== null)
		.map(({ message }) => message.messageId);

	if (embeddable.length > 0) {
		const values = await deps.embed(embeddable.map(({ text }) => text));
		await deps.vectors.upsert(
			embeddable.map(({ message }, i) => ({
				id: message.messageId,
				namespace: message.channelId,
				values: values[i] as number[],
				metadata: {
					author_id: message.authorId,
					created_at: message.createdAt,
				},
			})),
		);
		await markEmbedded(
			deps.db,
			embeddable.map(({ message }) => message),
		);
	}
	if (emptied.length > 0) {
		await deps.vectors.deleteByIds(emptied);
	}
	logEvent("queue", "ingested", {
		messages: latest.size,
		embedded: embeddable.length,
		emptied: emptied.length,
	});
}

/** 削除されたメッセージを、D1とVectorizeから消す */
export async function deleteMessages(
	messageIds: readonly string[],
	deps: IngestDeps,
): Promise<void> {
	const ids = [...new Set(messageIds)];
	await deleteStoredMessages(deps.db, ids);
	await deps.vectors.deleteByIds(ids);
	logEvent("queue", "deleted", { messages: ids.length });
}
