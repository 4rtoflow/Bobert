import { getChannelMessages } from "../discord/api";
import { handleImportCommandJob } from "../import/start";
import { logEvent } from "../log";
import { handleCompactJob } from "../respond/compact";
import { handleExplainJob } from "../respond/explain";
import { handleRespondJob } from "../respond/handler";
import { applyChannelSync } from "./channels";
import { ingestDeps } from "./deps";
import { IMPORT_PAGE_SIZE, importChannelPage } from "./import";
import { deleteMessages, ingestMessages, reindexPage } from "./ingest";
import type {
	ChannelSyncJob,
	CompactJob,
	DeleteJob,
	ExplainJob,
	ImportCommandJob,
	ImportJob,
	IngestJob,
	QueueMessage,
	ReactionJob,
	ReindexJob,
	RespondJob,
	StoredMessageInput,
} from "./messages";
import { applyReactions } from "./reactions";

/**
 * Queueに入った仕事を処理する。失敗した仕事は、Queueの設定の回数までやり直す。
 * 保存と削除は、まとめて処理する(D1、Workers AI、Vectorizeを呼ぶ回数を減らすため)。
 */
export async function handleQueueBatch(
	batch: MessageBatch<QueueMessage>,
	env: Env,
): Promise<void> {
	const deps = ingestDeps(env);
	await processBatch(batch.messages, {
		channels: (job) => applyChannelSync(job, deps),
		respond: (job) => handleRespondJob(job, env),
		explain: (job) => handleExplainJob(job, env),
		compact: (job) => handleCompactJob(job, env),
		importCommand: (job) => handleImportCommandJob(job, env),
		ingest: async (messages) => {
			await ingestMessages(messages, deps);
		},
		delete: (jobs) =>
			deleteMessages(
				jobs.flatMap((job) => job.messageIds),
				deps,
			),
		import: (job) =>
			importChannelPage(job, {
				...deps,
				listMessages: (channelId, before) =>
					getChannelMessages(env.DISCORD_BOT_TOKEN, channelId, {
						before,
						limit: IMPORT_PAGE_SIZE,
					}),
				continueImport: async (next, delaySeconds) => {
					await env.INGEST_QUEUE.send(next satisfies QueueMessage, {
						delaySeconds,
					});
				},
			}),
		reindex: (job) =>
			reindexPage(job, {
				...deps,
				continueReindex: async (next) => {
					await env.INGEST_QUEUE.send(next satisfies QueueMessage);
				},
			}),
		reaction: (jobs) => applyReactions(jobs, deps),
	});
}

/** 仕事の種類ごとの処理 */
export interface JobHandlers {
	channels: (job: ChannelSyncJob) => Promise<void>;
	respond: (job: RespondJob) => Promise<void>;
	explain: (job: ExplainJob) => Promise<void>;
	compact: (job: CompactJob) => Promise<void>;
	importCommand: (job: ImportCommandJob) => Promise<void>;
	ingest: (messages: StoredMessageInput[]) => Promise<void>;
	delete: (jobs: DeleteJob[]) => Promise<void>;
	import: (job: ImportJob) => Promise<void>;
	reindex: (job: ReindexJob) => Promise<void>;
	reaction: (jobs: ReactionJob[]) => Promise<void>;
}

/**
 * 仕事を種類ごとに分けて処理する。保存と削除とリアクションはまとめて、それ以外は1件ずつ。
 * チャンネルの記録は、保存より先に、受け取った順に反映する(保存するかどうかを、チャンネルの記録で決めるため)
 */
export async function processBatch(
	messages: readonly Message<QueueMessage>[],
	handlers: JobHandlers,
): Promise<void> {
	const channels = messages
		.filter(
			(message): message is Message<ChannelSyncJob> =>
				message.body.kind === "channels",
		)
		.sort((a, b) => a.body.syncedAt - b.body.syncedAt);
	const respond = messages.filter(
		(message): message is Message<RespondJob> =>
			message.body.kind === "respond",
	);
	const explain = messages.filter(
		(message): message is Message<ExplainJob> =>
			message.body.kind === "explain",
	);
	const compact = messages.filter(
		(message): message is Message<CompactJob> =>
			message.body.kind === "compact",
	);
	const importCommands = messages.filter(
		(message): message is Message<ImportCommandJob> =>
			message.body.kind === "import_command",
	);
	const ingest = messages.filter(
		(message): message is Message<IngestJob> => message.body.kind === "ingest",
	);
	const deletion = messages.filter(
		(message): message is Message<DeleteJob> => message.body.kind === "delete",
	);
	const imports = messages.filter(
		(message): message is Message<ImportJob> => message.body.kind === "import",
	);
	const reindex = messages.filter(
		(message): message is Message<ReindexJob> =>
			message.body.kind === "reindex",
	);
	const reactions = messages.filter(
		(message): message is Message<ReactionJob> =>
			message.body.kind === "reaction",
	);

	await eachOne(channels, handlers.channels);
	await eachOne(respond, handlers.respond);
	await eachOne(explain, handlers.explain);
	await eachOne(compact, handlers.compact);
	await eachOne(importCommands, handlers.importCommand);
	await settle(ingest, (jobs) => handlers.ingest(jobs.map(withDefaults)));
	await settle(deletion, (jobs) => handlers.delete(jobs));
	await eachOne(imports, handlers.import);
	await eachOne(reindex, handlers.reindex);
	await settle(reactions, (jobs) => handlers.reaction(jobs));
}

/** 1件ずつ処理する。失敗した仕事だけを、やり直しに回す */
async function eachOne<T extends QueueMessage>(
	messages: readonly Message<T>[],
	handle: (job: T) => Promise<void>,
): Promise<void> {
	for (const message of messages) {
		await settle([message], async (jobs) => {
			for (const job of jobs) {
				await handle(job);
			}
		});
	}
}

/**
 * まとめて処理し、成功したら完了にする。
 * 失敗したら1件ずつ処理し直し、それでも失敗した仕事だけをやり直しに回す。1件の不正な仕事で、ほかの仕事まで止めないため。
 */
async function settle<T extends QueueMessage>(
	messages: readonly Message<T>[],
	task: (jobs: T[]) => Promise<void>,
): Promise<void> {
	const first = messages[0];
	if (!first) {
		return;
	}
	try {
		await task(messages.map((message) => message.body));
		for (const message of messages) {
			message.ack();
		}
	} catch (error) {
		logEvent("queue", "job_failed", {
			kind: first.body.kind,
			jobs: messages.length,
			attempts: Math.max(...messages.map((message) => message.attempts)),
			error: error instanceof Error ? error.message : "unknown",
		});
		if (messages.length === 1) {
			first.retry();
			return;
		}
		for (const message of messages) {
			await settle([message], task);
		}
	}
}

/** デプロイの前にQueueに入った仕事には、後から足した項目がない */
function withDefaults(job: IngestJob): StoredMessageInput {
	const { message } = job;
	return {
		...message,
		mentions: message.mentions ?? [],
		members: message.members ?? [],
		attachments: message.attachments.map((attachment) => ({
			...attachment,
			filename: attachment.filename ?? "",
		})),
		embeds: message.embeds ?? [],
		command: message.command ?? null,
	};
}
