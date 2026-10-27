import type { APIMessage } from "discord-api-types/v10";
import { DiscordApiError } from "../discord/api";
import { shouldStore, toStoredMessage } from "../gateway/messages";
import { logEvent } from "../log";
import {
	claimChannelImport,
	failChannelImport,
	finishChannelImport,
	recordImportProgress,
	releaseChannelImport,
} from "../store/imports";
import { type IngestDeps, ingestMessages } from "./ingest";
import type { ImportJob, QueueMessage } from "./messages";

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

/**
 * そのチャンネルで初めてBotが使われたら、過去ログの取り込みを裏で始める
 * (仕様: docs/spec/architecture.md「過去ログの取り込み」)。すでに始めていれば何もせず、falseを返す。
 */
export async function startChannelImport(
	db: D1Database,
	queue: Queue<QueueMessage>,
	channelId: string,
	guildId: string,
): Promise<boolean> {
	if (!(await claimChannelImport(db, channelId))) {
		return false;
	}
	try {
		await queue.send({ kind: "import", channelId, guildId, before: null });
	} catch (error) {
		// 次に使われたときに、やり直す
		await releaseChannelImport(db, channelId);
		throw error;
	}
	return true;
}

/**
 * 過去ログを1回分(最大100件)読んで、保存とベクトル化をし、続きの仕事を入れる。
 * 100件に満たなければ、最後まで読んだので終える。読む権限がなければ、取り込めなかったと記録する。
 */
export async function importChannelPage(
	job: ImportJob,
	deps: ImportDeps,
): Promise<void> {
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
			return;
		}
		throw error;
	}

	// 参加やピン留めの通知などのシステムのメッセージは、保存しない
	const messages = page
		.map((message) => ({ ...message, guild_id: job.guildId ?? undefined }))
		.filter((message) => shouldStore(message))
		.map((message) => toStoredMessage(message));
	if (messages.length > 0) {
		await ingestMessages(messages, deps);
	}

	const oldest = oldestMessageId(page);
	if (page.length < IMPORT_PAGE_SIZE || oldest === null) {
		await finishChannelImport(deps.db, job.channelId, oldest);
		logEvent("queue", "import_done", { channelId: job.channelId });
		return;
	}
	await recordImportProgress(deps.db, job.channelId, oldest);
	await deps.continueImport(
		{ ...job, before: oldest },
		IMPORT_INTERVAL_SECONDS,
	);
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
