import type { KnowledgeJob, StoredMessageInput } from "../queue/messages";
import { attachmentKey } from "../respond/attachments";
import {
	type AcceptedKnowledgeFile,
	addPendingKnowledgeFiles,
	deleteKnowledgeFiles,
	knowledgeChannelsFor,
	knowledgeFilesOfMessages,
	type NewKnowledgeFile,
} from "../store/knowledge";
import { loadMessagesByIds } from "../store/messages";
import { knowledgeFormat } from "./format";
import { type KnowledgeProgressApi, startKnowledgeProgress } from "./progress";
import { forgetKnowledgeFiles, type KnowledgeStorage } from "./storage";

/** 知識のファイルの受け付けに使うもの。消すときは、D1の外に置いたもの(R2のPDFと、ベクトル)も消す */
export interface KnowledgeIntakeDeps extends KnowledgeStorage {
	db: D1Database;
	/** 受け付けたファイルを、文字にして要約する仕事を入れる(時間がかかるので、別の仕事にする) */
	knowledgeLater: (jobs: readonly KnowledgeJob[]) => Promise<void>;
	/** 受け付けたファイルのメッセージに、読み込みの進み具合を見せる(DiscordのAPI) */
	knowledgeProgress: KnowledgeProgressApi;
}

/**
 * 保存したメッセージのうち、知識チャンネル(と、その中の公開スレッドとフォーラムの投稿)のものを見る
 * (仕様: docs/spec/architecture.md「知識チャンネル」)。
 * - 指定した後に送られた、受け付ける形式のファイルを記録し、文字にして要約する仕事を入れる。
 *   そのメッセージに👀を付け、読み込みの進み具合を返信で見せる(src/knowledge/progress.ts)。
 *   Botが送ったファイルと、受け付けない形式のファイルには、何もしない
 * - 編集でファイルが外されていたら、そのファイルの知識を消す
 * 同じ添付ファイルは、二度受け付けない(作成と編集の通知が両方届いたときや、読み直したメッセージを保存し直したとき)。
 * 受け付けた数と、消した数を返す
 */
export async function acceptKnowledgeFiles(
	messages: readonly StoredMessageInput[],
	deps: KnowledgeIntakeDeps,
): Promise<{ accepted: number; removed: number }> {
	const inGuild = messages.filter((message) => message.guildId !== null);
	if (inGuild.length === 0) {
		return { accepted: 0, removed: 0 };
	}
	const channels = await knowledgeChannelsFor(
		deps.db,
		inGuild.map((message) => message.channelId),
	);
	if (channels.size === 0) {
		return { accepted: 0, removed: 0 };
	}
	// 保存した版で決める。処理のやり直しで、古い版が後から届いても、外したファイルを加え直さないため
	const stored = await loadMessagesByIds(
		deps.db,
		inGuild
			.filter((message) => channels.has(message.channelId))
			.map((message) => message.messageId),
	);
	const removed = await removeDetachedFiles(
		deps,
		stored.filter((message) => message.editedAt !== null),
	);
	const candidates = stored.flatMap((message): NewKnowledgeFile[] => {
		const channel = channels.get(message.channelId);
		if (
			channel === undefined ||
			message.guildId === null ||
			message.authorIsBot ||
			// 指定する前に送られていたファイルは、加えない
			message.createdAt < channel.designatedAt
		) {
			return [];
		}
		const guildId = message.guildId;
		return message.attachments.flatMap((attachment) => {
			const format = knowledgeFormat(attachment);
			return format === null
				? []
				: [
						{
							guildId,
							knowledgeChannelId: channel.knowledgeChannelId,
							channelId: message.channelId,
							messageId: message.messageId,
							attachmentId: attachmentKey(attachment),
							filename: attachment.filename,
							format,
							size: attachment.size,
							authorId: message.authorId,
							authorName: message.authorName,
							postedAt: message.createdAt,
						},
					];
		});
	});
	const accepted = await addPendingKnowledgeFiles(deps.db, candidates);
	// 進み具合は、メッセージごとに見せる(1つのメッセージに複数のファイルがあれば、1つの返信に並べる)
	const jobs: KnowledgeJob[] = [];
	for (const files of byMessage(accepted)) {
		const [first] = files;
		if (first === undefined) {
			continue;
		}
		const progress = await startKnowledgeProgress(
			deps.knowledgeProgress,
			first,
			files.map((file) => file.filename),
		);
		jobs.push(
			...files.map(
				(file): KnowledgeJob => ({
					kind: "knowledge",
					fileId: file.id,
					progress,
				}),
			),
		);
	}
	if (jobs.length > 0) {
		await deps.knowledgeLater(jobs);
	}
	return { accepted: accepted.length, removed };
}

/** 受け付けたファイルを、メッセージごとに分ける(受け付けた順のまま) */
function byMessage(
	files: readonly AcceptedKnowledgeFile[],
): AcceptedKnowledgeFile[][] {
	const groups = new Map<string, AcceptedKnowledgeFile[]>();
	for (const file of files) {
		const group = groups.get(file.messageId);
		if (group === undefined) {
			groups.set(file.messageId, [file]);
		} else {
			group.push(file);
		}
	}
	return [...groups.values()];
}

/** 編集されたメッセージのうち、知識のファイルの添付が外されたものの知識を消す。消した数を返す */
async function removeDetachedFiles(
	deps: KnowledgeIntakeDeps,
	messages: readonly StoredMessageInput[],
): Promise<number> {
	if (messages.length === 0) {
		return 0;
	}
	const present = new Map(
		messages.map((message) => [
			message.messageId,
			new Set(message.attachments.map(attachmentKey)),
		]),
	);
	const detached = (
		await knowledgeFilesOfMessages(
			deps.db,
			messages.map((message) => message.messageId),
		)
	).filter((file) => !present.get(file.messageId)?.has(file.attachmentId));
	await forgetKnowledgeFiles(
		deps,
		await deleteKnowledgeFiles(
			deps.db,
			detached.map((file) => file.id),
		),
	);
	return detached.length;
}
