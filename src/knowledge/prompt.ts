import { formatJstDate } from "../respond/time";
import { loadChannels } from "../store/channels";
import {
	type KnowledgeFile,
	listReadyKnowledgeFiles,
} from "../store/knowledge";
import { loadMemberNames } from "../store/messages";
import { KNOWLEDGE_LIST_INTRO } from "./texts";

/**
 * AIへの指示に入れる、知識のファイルの一覧(仕様: docs/spec/architecture.md「知識チャンネル」)。
 * スキルの一覧の次、本人の指示の前に入れる(サーバーで同じ部分なので、人ごとに変わる部分より前に置き、キャッシュを効かせる)
 */

/** 一覧に載せるファイルの数の上限(新しい順)。一覧は毎回AIに渡すので、長いほど全員の返答の費用が増えるため */
export const MAX_LISTED_KNOWLEDGE_FILES = 50;

/** AIへの指示に入れる一覧 */
export interface KnowledgeList {
	/** 一覧の文(前置き、ファイルの一覧) */
	block: string;
	/** 一覧に載せたファイルの数(ログに残す) */
	listed: number;
}

/**
 * サーバーの知識のファイルの一覧を作る。知識に入ったファイルがなければnull(一覧も、読む道具も渡さない)。
 * チャンネルの名前は今の名前、送った人の名前は最後に分かった名前(なければ、送ったときの名前)にする
 */
export async function loadKnowledgeList(
	db: D1Database,
	guildId: string,
): Promise<KnowledgeList | null> {
	const { files, total } = await listReadyKnowledgeFiles(
		db,
		guildId,
		MAX_LISTED_KNOWLEDGE_FILES,
	);
	if (files.length === 0) {
		return null;
	}
	const channels = await loadChannels(db, [
		...new Set(files.map((file) => file.channelId)),
	]);
	const names = await loadMemberNames(db, guildId, [
		...new Set(files.map((file) => file.authorId)),
	]);
	return {
		block: knowledgeListBlock(
			files,
			(channelId) => channels.get(channelId)?.name ?? null,
			(file) => names.get(file.authorId) ?? file.authorName,
			total,
		),
		listed: files.length,
	};
}

/**
 * 一覧の文。1つのファイルを1行にする(例: 「- k12: #資料「規約.pdf」(2026-11-06、Alice) 部費の額と…」)。
 * 載せきれないファイルがあれば、その数を書き添える。中身は、どこまでが一覧かが分かるよう、タグで囲む
 */
export function knowledgeListBlock(
	files: readonly KnowledgeFile[],
	channelName: (channelId: string) => string | null,
	authorName: (file: KnowledgeFile) => string,
	total: number,
): string {
	return [
		KNOWLEDGE_LIST_INTRO,
		"",
		"<knowledge_files>",
		...files.map(
			(file) =>
				`- k${file.id}: #${channelName(file.channelId) ?? "(名前の分からないチャンネル)"}「${file.filename}」(${formatJstDate(file.postedAt)}、${authorName(file)}) ${file.summary ?? ""}`,
		),
		"</knowledge_files>",
		...(total > files.length
			? [
					`(新しい${files.length}件だけを載せています。ほかに、それより前のファイルが${total - files.length}件あります)`,
				]
			: []),
	].join("\n");
}
