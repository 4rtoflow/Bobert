import { getChannelMessages } from "../discord/api";
import { logEvent } from "../log";
import { handleRespondJob } from "../respond/handler";
import { workersAiEmbedder } from "../store/embedding";
import { IMPORT_PAGE_SIZE, importChannelPage } from "./import";
import { deleteMessages, type IngestDeps, ingestMessages } from "./ingest";
import type {
	DeleteJob,
	ImportJob,
	IngestJob,
	QueueMessage,
	RespondJob,
	StoredMessageInput,
} from "./messages";

/**
 * Queueに入った仕事を処理する。失敗した仕事は、Queueの設定の回数までやり直す。
 * 保存と削除は、まとめて処理する(D1、Workers AI、Vectorizeを呼ぶ回数を減らすため)。
 */
export async function handleQueueBatch(
	batch: MessageBatch<QueueMessage>,
	env: Env,
): Promise<void> {
	const deps: IngestDeps = {
		db: env.DB,
		vectors: env.VECTORIZE,
		embed: workersAiEmbedder(env.AI),
		botUserId: env.DISCORD_APPLICATION_ID,
	};
	await processBatch(batch.messages, {
		respond: (job) => handleRespondJob(job, env),
		ingest: (messages) => ingestMessages(messages, deps),
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
	});
}

/** 仕事の種類ごとの処理 */
export interface JobHandlers {
	respond: (job: RespondJob) => Promise<void>;
	ingest: (messages: StoredMessageInput[]) => Promise<void>;
	delete: (jobs: DeleteJob[]) => Promise<void>;
	import: (job: ImportJob) => Promise<void>;
}

/** 仕事を種類ごとに分けて処理する。応答と過去ログの取り込みは1件ずつ、保存と削除はまとめて */
export async function processBatch(
	messages: readonly Message<QueueMessage>[],
	handlers: JobHandlers,
): Promise<void> {
	const respond = messages.filter(
		(message): message is Message<RespondJob> =>
			message.body.kind === "respond",
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

	for (const message of respond) {
		await settle([message], async (jobs) => {
			for (const job of jobs) {
				await handlers.respond(job);
			}
		});
	}
	await settle(ingest, (jobs) => handlers.ingest(jobs.map(withDefaults)));
	await settle(deletion, (jobs) => handlers.delete(jobs));
	for (const message of imports) {
		await settle([message], async (jobs) => {
			for (const job of jobs) {
				await handlers.import(job);
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
