import { hasPosts } from "../discord/channels";
import type { StoredMessageInput } from "../queue/messages";
import { loadChannels } from "../store/channels";
import { loadMessagesByIds } from "../store/messages";
import type { FileCatalog } from "./attachments";
import { messageLine } from "./conversation";
import { fromDiscord, type HistoryDeps, namesFor } from "./history";

/**
 * スレッドの中での会話なら、会話の最初に書く前置き(仕様: docs/spec/architecture.md「スレッド」)。
 * スレッドと親のチャンネルの名前と、スレッドを始めたメッセージ(フォーラムなら、投稿の最初のメッセージ)を書く。
 * スレッドでなければnull。スレッドを始めたメッセージが会話に入っていれば、名前だけを書く。
 * filesを渡すと、スレッドを始めたメッセージの添付ファイルに番号を付ける(会話より前なので、会話より先に呼ぶ)
 */
export async function threadPreface(
	history: HistoryDeps,
	chain: readonly StoredMessageInput[],
	botUserId: string,
	files?: FileCatalog,
): Promise<string | null> {
	const here = (await loadChannels(history.db, [history.channelId])).get(
		history.channelId,
	);
	if (here === undefined || here.parentId === null) {
		return null;
	}
	const parent = (await loadChannels(history.db, [here.parentId])).get(
		here.parentId,
	);
	const forum = parent !== undefined && hasPosts(parent.type);
	const where =
		parent === undefined
			? `スレッド「${here.name}」`
			: forum
				? `フォーラム #${parent.name} の投稿「${here.name}」`
				: `#${parent.name} のスレッド「${here.name}」`;
	const intro = `(この会話は、${where}の中です)`;
	// スレッドを始めたメッセージは、スレッドと同じIDを持つ。フォーラムの投稿ならスレッドの中に、そうでなければ親のチャンネルにある
	if (chain.some((message) => message.messageId === here.channelId)) {
		return intro;
	}
	const starter = await starterMessage(
		history,
		here.channelId,
		forum ? here.channelId : here.parentId,
	);
	if (starter === null) {
		return intro;
	}
	const names = await namesFor([starter], history);
	return [
		intro,
		forum ? "投稿の最初のメッセージです:" : "スレッドを始めたメッセージです:",
		messageLine(
			starter,
			botUserId,
			names,
			forum || parent === undefined ? null : `#${parent.name}`,
			files,
		),
	].join("\n");
}

/**
 * スレッドを始めたメッセージ。保存したものから読み、なければDiscordから読んで、保存にも回す。
 * メッセージから作ったスレッドでなければ(スレッドの作成ボタンなど)、ないのでnull
 */
async function starterMessage(
	history: HistoryDeps,
	threadId: string,
	channelId: string,
): Promise<StoredMessageInput | null> {
	const [stored] = await loadMessagesByIds(history.db, [threadId]);
	if (stored !== undefined) {
		return stored;
	}
	const message = await history.fetchMessage(channelId, threadId);
	if (message === null) {
		return null;
	}
	const converted = fromDiscord(message, history.guildId);
	await history.ingest([converted]);
	return converted;
}
