import type { Embedder } from "../store/embedding";
import {
	type KnowledgeFile,
	loadKnowledgeText,
	splitText,
} from "../store/knowledge";

/**
 * 知識のファイルの中を、意味で探せるようにする(仕様: docs/spec/architecture.md「知識チャンネル」)。
 * 文字にした内容を区切ってベクトルにし、Vectorizeに入れる。索引は、メッセージと同じもの(bobert-messages)を使い、
 * 名前空間をサーバーごとの「knowledge-<サーバーID>」に分ける。メッセージの検索は、チャンネルの名前空間か、
 * メタデータのサーバーID(guild_id)で探すので、知識のベクトル(guild_idを付けない)は、メッセージの検索には出ない
 */

/** ベクトルにする区切りの長さ(UTF-16の長さ)。探す道具は、見つけた区切りの文字をそのまま返す */
export const KNOWLEDGE_CHUNK_LENGTH = 1_000;

/**
 * 1つのファイルでベクトルにする区切りの数の上限(先頭から。30万文字分)。
 * とても長いファイルで、埋め込みとVectorizeの費用(運営者の負担)と、仕事の時間が増えすぎないようにするため。
 * それより後ろは、探す道具では見つからないが、読む道具では読める
 */
export const MAX_KNOWLEDGE_CHUNKS = 300;

/** 1回でベクトルにする区切りの数 */
const EMBED_BATCH_SIZE = 50;

/** Vectorizeから1回に消すベクトルの数 */
const DELETE_BATCH_SIZE = 100;

/** 知識のベクトルを入れるVectorizeの索引のうち、使う部分。テストでは偽物に差し替える */
export interface KnowledgeVectorStore {
	upsert(vectors: VectorizeVector[]): Promise<unknown>;
	deleteByIds(ids: string[]): Promise<unknown>;
}

/** サーバーの知識のベクトルの名前空間 */
export function knowledgeNamespace(guildId: string): string {
	return `knowledge-${guildId}`;
}

/** 知識のベクトルのID(メッセージのベクトルのIDは数字だけなので、重ならない) */
export function knowledgeVectorId(fileId: number, index: number): string {
	return `k${fileId}-${index}`;
}

/** 知識のベクトルのIDから、ファイルのIDを読む。知識のベクトルでなければnull */
export function fileIdOfVector(vectorId: string): number | null {
	const match = /^k(\d+)-\d+$/.exec(vectorId);
	return match === null ? null : Number(match[1]);
}

/**
 * ファイルの、文字にした内容の先頭から、区切ってベクトルにし、Vectorizeに入れる。入れた区切りの数(ベクトルのIDの数)を返す。
 * ベクトルにする文には、ファイル名を添える(ファイル名で探されたときにも見つかるように)。
 * 区切りの位置は、メタデータ(start、end)に入れ、探す道具がその文字を読むのに使う
 */
export async function embedKnowledgeFile(
	deps: { db: D1Database; embed: Embedder; vectors: KnowledgeVectorStore },
	file: Pick<KnowledgeFile, "id" | "guildId" | "filename" | "textLength">,
): Promise<number> {
	const limit = Math.min(
		file.textLength ?? 0,
		MAX_KNOWLEDGE_CHUNKS * KNOWLEDGE_CHUNK_LENGTH,
	);
	if (limit === 0) {
		return 0;
	}
	// 先頭から読むので、読んだ文は0文字目から始まる
	const loaded = await loadKnowledgeText(deps.db, file.id, 0, limit);
	const parts = splitText(loaded.text.slice(0, limit), KNOWLEDGE_CHUNK_LENGTH)
		.map((part, index) => ({ ...part, index }))
		// 空白だけの区切りは、探しても意味がないので入れない(番号は飛ばす)
		.filter((part) => part.text.trim() !== "")
		.slice(0, MAX_KNOWLEDGE_CHUNKS);
	for (let i = 0; i < parts.length; i += EMBED_BATCH_SIZE) {
		const batch = parts.slice(i, i + EMBED_BATCH_SIZE);
		const values = await deps.embed(
			batch.map((part) => `${file.filename}\n${part.text}`),
		);
		await deps.vectors.upsert(
			batch.map((part, j) => ({
				id: knowledgeVectorId(file.id, part.index),
				namespace: knowledgeNamespace(file.guildId),
				values: values[j] as number[],
				metadata: { file_id: file.id, start: part.start, end: part.end },
			})),
		);
	}
	const last = parts.at(-1);
	return last === undefined ? 0 : last.index + 1;
}

/** ファイルのベクトルを、Vectorizeから消す(入れたIDは、0からvectorCount-1まで) */
export async function deleteKnowledgeVectors(
	vectors: Pick<KnowledgeVectorStore, "deleteByIds">,
	files: readonly { id: number; vectorCount: number | null }[],
): Promise<void> {
	const ids = files.flatMap((file) =>
		Array.from({ length: file.vectorCount ?? 0 }, (_, index) =>
			knowledgeVectorId(file.id, index),
		),
	);
	for (let i = 0; i < ids.length; i += DELETE_BATCH_SIZE) {
		await vectors.deleteByIds(ids.slice(i, i + DELETE_BATCH_SIZE));
	}
}
