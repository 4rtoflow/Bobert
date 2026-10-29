import type { APIMessage } from "discord-api-types/v10";
import { DiscordApiError } from "../discord/api";
import { shouldStore, toStoredMessage } from "../gateway/messages";
import { logEvent } from "../log";
import {
	failChannelImport,
	finishChannelImport,
	getChannelImport,
	recordImportProgress,
	type StartedImport,
	startQueuedImports,
} from "../store/imports";
import { resolveSharedChannels } from "./channels";
import { type IngestDeps, ingestMessages } from "./ingest";
import type { ImportJob } from "./messages";

/** 1回で読むメッセージの数(DiscordのAPIの上限) */
export const IMPORT_PAGE_SIZE = 100;
/** 続きの仕事を入れるまでの間隔(秒)。DiscordのAPIの利用制限を守るため */
const IMPORT_INTERVAL_SECONDS = 2;

/** 過去ログの取り込みに使うもの。テストでは偽物に差し替える */
export interface ImportDeps extends IngestDeps {
	/** チャンネルのメッセージを、beforeより前から1回分読む(新しい順) */
	listMessages: (
		channelId: string,
		before: string | null,
	) => Promise<APIMessage[]>;
	/** 続きの仕事を、間を空けて入れる */
	continueImport: (job: ImportJob, delaySeconds: number) => Promise<void>;
}

/** 取り込みを始めたチャンネルの、最初の仕事 */
export function firstImportJob(started: StartedImport): ImportJob {
	return {
		kind: "import",
		channelId: started.channelId,
		guildId: started.guildId,
		before: started.before,
	};
}

/**
 * 過去ログを1回分(最大100件)読んで、保存とベクトル化をし、続きの仕事を入れる
 * (仕様: docs/spec/architecture.md「過去ログの取り込み」)。
 * 100件に満たなければ、最後まで読んだので終える。読む権限がなければ、取り込めなかったと記録する。
 * 終えたら、同じ`/import`の回の、順番待ちのチャンネルの取り込みを始める。
 * 取り込み中に共有しなくなったチャンネル(Botが見られなくなったものなど)は、取り込みをやめる(保存もしない)
 */
export async function importChannelPage(
	job: ImportJob,
	deps: ImportDeps,
): Promise<void> {
	const visible = await resolveSharedChannels(
		[{ channelId: job.channelId, guildId: job.guildId }],
		deps,
	);
	if (!visible.has(job.channelId)) {
		await failChannelImport(deps.db, job.channelId);
		logEvent("queue", "import_not_shared", { channelId: job.channelId });
		await startNextImports(job.channelId, deps);
		return;
	}

	let page: APIMessage[];
	try {
		page = await deps.listMessages(job.channelId, job.before);
	} catch (error) {
		// 403は読む権限がない。404はチャンネルが消えた
		if (
			error instanceof DiscordApiError &&
			(error.status === 403 || error.status === 404)
		) {
			await failChannelImport(deps.db, job.channelId);
			logEvent(
				"queue",
				error.status === 403 ? "missing_permission" : "import_failed",
				{ channelId: job.channelId, status: error.status },
			);
			await startNextImports(job.channelId, deps);
			return;
		}
		throw error;
	}

	// 参加やピン留めの通知などのシステムのメッセージは、保存しない
	const messages = page
		.map((message) => ({ ...message, guild_id: job.guildId ?? undefined }))
		.filter((message) => shouldStore(message))
		.map((message) => toStoredMessage(message));
	const saved = messages.length > 0 ? await ingestMessages(messages, deps) : 0;

	const oldest = oldestMessageId(page);
	if (page.length < IMPORT_PAGE_SIZE || oldest === null) {
		await finishChannelImport(deps.db, job.channelId, oldest, saved);
		logEvent("queue", "import_done", { channelId: job.channelId });
		await startNextImports(job.channelId, deps);
		return;
	}
	await recordImportProgress(deps.db, job.channelId, oldest, saved);
	await deps.continueImport(
		{ ...job, before: oldest },
		IMPORT_INTERVAL_SECONDS,
	);
}

/** チャンネルの取り込みを終えたので、同じ回の、順番待ちのチャンネルの取り込みを始める */
async function startNextImports(
	channelId: string,
	deps: ImportDeps,
): Promise<void> {
	const runId = (await getChannelImport(deps.db, channelId))?.runId ?? null;
	if (runId === null) {
		return;
	}
	for (const started of await startQueuedImports(deps.db, runId)) {
		await deps.continueImport(firstImportJob(started), 0);
	}
}

/** いちばん古いメッセージのID。IDは、投稿された順に大きくなる */
function oldestMessageId(page: readonly APIMessage[]): string | null {
	let oldest: string | null = null;
	for (const message of page) {
		if (oldest === null || BigInt(message.id) < BigInt(oldest)) {
			oldest = message.id;
		}
	}
	return oldest;
}
