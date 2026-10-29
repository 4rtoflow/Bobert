import type { Embedder } from "./embedding";

/**
 * Vectorizeの索引のうち、検索に使う部分。
 * 生成された型(VectorizeIndex)は古いベータ版のものなので、使う部分だけを書いておく
 */
export interface VectorSearcher {
	query(
		vector: number[],
		options: VectorizeQueryOptions,
	): Promise<{ matches: { id: string }[] }>;
}

/** 探す範囲。チャンネルなら、その名前空間から。サーバーなら、サーバーIDのメタデータで絞り込んで、全部の名前空間から */
export type SearchScope =
	| { kind: "channel"; channelId: string }
	| { kind: "server"; guildId: string };

export interface SearchOptions {
	scope: SearchScope;
	/** 発言者で絞り込む。nullなら絞り込まない */
	authorIds: readonly string[] | null;
	/** この時刻より後(UNIX時間のミリ秒)。nullなら制限しない */
	after: number | null;
	/** この時刻より前(UNIX時間のミリ秒)。nullなら制限しない */
	before: number | null;
	topK: number;
}

/**
 * 検索語に意味が近いメッセージのIDを、近い順に返す(仕様: docs/spec/architecture.md「過去メッセージを参照する道具」)。
 * 検索語はWorkers AIでベクトルにし、Vectorizeで探す。チャンネルの中なら、そのチャンネルの名前空間から探す。
 * サーバー全体なら、メタデータのサーバーID(guild_id)で絞り込む(保存しているのは、共有チャンネルのメッセージだけ)。
 * 発言者と期間は、メタデータ(author_id、created_at)で絞り込む。
 */
export async function searchSimilarMessages(
	query: string,
	options: SearchOptions,
	deps: { embed: Embedder; vectors: VectorSearcher },
): Promise<string[]> {
	const [vector] = await deps.embed([query]);
	if (!vector) {
		return [];
	}
	const { scope } = options;
	const filter: VectorizeVectorMetadataFilter =
		scope.kind === "server" ? { guild_id: scope.guildId } : {};
	if (options.authorIds !== null) {
		filter.author_id = { $in: [...options.authorIds] };
	}
	if (options.after !== null || options.before !== null) {
		filter.created_at = {
			...(options.after === null ? {} : { $gt: options.after }),
			...(options.before === null ? {} : { $lt: options.before }),
		};
	}
	const result = await deps.vectors.query(vector, {
		topK: options.topK,
		...(scope.kind === "channel" ? { namespace: scope.channelId } : {}),
		returnMetadata: "none",
		...(Object.keys(filter).length > 0 ? { filter } : {}),
	});
	return result.matches.map((match) => match.id);
}
