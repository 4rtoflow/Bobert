import {
	embedLines,
	resolveMentions,
	stripNotes,
} from "../respond/conversation";
import type { MessageToEmbed } from "./messages";

/**
 * 検索用のデータ化(埋め込み)に使う、Workers AIのモデル(仕様: docs/spec/architecture.md「会話の文脈と過去の発言の保存」)。
 * 多言語に対応していて、1024次元のベクトルになる。Vectorizeの索引も1024次元で作る。
 */
export const EMBEDDING_MODEL = "@cf/baai/bge-m3";

/** 文をベクトルにする。返すベクトルは、渡した文と同じ順 */
export type Embedder = (texts: string[]) => Promise<number[][]>;

/** Workers AIで文をベクトルにする */
export function workersAiEmbedder(ai: Ai): Embedder {
	return async (texts) => {
		// 長すぎる文は、モデルの上限で切ってベクトルにする
		const output = await ai.run(EMBEDDING_MODEL, {
			text: texts,
			truncate_inputs: true,
		});
		const vectors = "data" in output ? output.data : undefined;
		if (!vectors || vectors.length !== texts.length) {
			throw new Error("埋め込みの結果の数が合いません");
		}
		return vectors;
	};
}

/**
 * ベクトルにする文。本文の後に、Embedの中身を続ける。メンションは名前に置き換える(会話の組み立てと同じ)。
 * Bobertの返答は、末尾に添えた注記を外す。空なら、ベクトルにしない。
 */
export function embeddingText(
	message: Pick<MessageToEmbed, "authorId" | "content" | "mentions" | "embeds">,
	botUserId: string,
): string {
	const content =
		message.authorId === botUserId
			? stripNotes(message.content)
			: message.content;
	const text = [
		content,
		...message.embeds.map((embed) => embedLines(embed).join("\n")),
	]
		.filter((part) => part.trim() !== "")
		.join("\n");
	return resolveMentions(
		text,
		new Map(message.mentions.map((user) => [user.id, user.name])),
	).trim();
}
