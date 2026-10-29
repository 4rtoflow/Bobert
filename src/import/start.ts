import type { APIMessage } from "discord-api-types/v10";
import {
	countGuildMessages,
	DiscordApiError,
	editChannelMessage,
	editOriginalInteractionResponse,
	getActiveGuildThreads,
	getArchivedPublicThreads,
	getGuildChannels,
	getGuildMember,
	getGuildRoles,
} from "../discord/api";
import {
	type ChannelInfo,
	canHaveThreads,
	type DiscordChannel,
	type GuildRoles,
	hasMessages,
	isSharedChannel,
	isThreadType,
	toChannelInfo,
} from "../discord/channels";
import { logEvent } from "../log";
import { applyChannelSync, type ChannelDeps } from "../queue/channels";
import { ingestDeps } from "../queue/deps";
import { firstImportJob } from "../queue/import";
import type {
	ImportCommandJob,
	ImportJob,
	QueueMessage,
} from "../queue/messages";
import { guildChannels } from "../store/channels";
import {
	activeImportRun,
	addToEstimate,
	claimImportTargets,
	createImportRun,
	finishImportRun,
	startQueuedImports,
} from "../store/imports";
import { claimMessage } from "../store/messages";
import {
	completedText,
	IMPORT_START_FAILED,
	isComplete,
	NO_SHARED_CHANNELS,
	progressText,
} from "./progress";
import {
	type EditResult,
	INTERACTION_EDIT_WINDOW_MS,
	type ProgressDisplay,
	runState,
} from "./watch";

/** メッセージ検索で、1回に指定できるチャンネルの数(DiscordのAPIの上限) */
const MAX_SEARCH_CHANNELS = 500;
/** 保存用のQueueに1回で入れる仕事の数(Queuesの上限は100) */
const ENQUEUE_BATCH_SIZE = 100;
/** 進み具合を見張るDurable Objectの名前の頭。サーバーごとに1つ作る */
const PROGRESS_OBJECT_PREFIX = "import-progress:";

/** サーバーのチャンネルとスレッドの、今の様子 */
export interface GuildSnapshot {
	/** サーバーのロールの権限と、Botのロール */
	roles: GuildRoles;
	/** スレッドでないチャンネル(サーバーの全部。2026-11-16からは、Botが見られるものだけ) */
	channels: ChannelInfo[];
	/** スレッド。アーカイブされていないものと、共有チャンネルの、アーカイブされた公開スレッド */
	threads: ChannelInfo[];
}

/** `/import`を始めるのに使うもの。テストでは偽物に差し替える */
export interface ImportStartDeps {
	db: D1Database;
	channels: ChannelDeps;
	/** サーバーのチャンネルとスレッドを、DiscordのAPIで列挙する */
	listGuild: (guildId: string) => Promise<GuildSnapshot>;
	/** 指定したチャンネルのメッセージの件数を、メッセージ検索で数える。数えられなければnull */
	countMessages: (
		guildId: string,
		channelIds: readonly string[],
	) => Promise<number | null>;
	enqueueImports: (jobs: ImportJob[]) => Promise<void>;
	/** 保留にした応答を書き換え、書き換えたメッセージを返す */
	editOriginal: (content: string) => Promise<APIMessage>;
	/** 進み具合を見張る役に、表示を渡す */
	watch: (display: ProgressDisplay) => Promise<void>;
}

/**
 * `/import`の仕事(仕様: docs/spec/architecture.md「過去ログの取り込み」)。
 * 同じInteractionで2回始めないよう、記録してから始める
 */
export async function handleImportCommandJob(
	job: ImportCommandJob,
	env: Env,
): Promise<void> {
	if (!(await claimMessage(env.DB, `import:${job.interactionId}`))) {
		logEvent("import", "duplicate", { userId: job.userId });
		return;
	}
	await startImport(job, importStartDeps(env, job));
}

/**
 * 共有チャンネルと、その中の公開スレッドを列挙し、過去ログの取り込みを始めて、保留にした応答を進み具合の表示にする。
 * 取り込み中の回があれば、その回に足す(同じ回の進み具合を見せる)。始められなければ、そう表示する。
 * 失敗してもやり直さない(やり直すと、表示が「取り込みを始められませんでした」から戻らないことがあるため)
 */
export async function startImport(
	job: ImportCommandJob,
	deps: ImportStartDeps,
	now = Date.now(),
): Promise<void> {
	try {
		await start(job, deps, now);
	} catch (error) {
		logEvent("import", "import_start_failed", {
			guildId: job.guildId,
			userId: job.userId,
			error: error instanceof Error ? error.message : "unknown",
		});
		try {
			await deps.editOriginal(IMPORT_START_FAILED);
		} catch {
			// 表示できなくても、ほかにできることはない
		}
	}
}

async function start(
	job: ImportCommandJob,
	deps: ImportStartDeps,
	now: number,
): Promise<void> {
	const { guildId } = job;
	const snapshot = await deps.listGuild(guildId);
	await applyChannelSync(
		{
			kind: "channels",
			guildId,
			syncedAt: now,
			roles: snapshot.roles.roles,
			allRoles: true,
			botRoleIds: snapshot.roles.botRoleIds,
			channels: [...snapshot.channels, ...snapshot.threads],
			allChannelIds: snapshot.channels.map((channel) => channel.channelId),
		},
		deps.channels,
	);
	const targets = (await guildChannels(deps.db, guildId))
		.filter(
			(record) =>
				record.shared &&
				(hasMessages(record.type) || isThreadType(record.type)),
		)
		.map((record) => record.channelId);
	if (targets.length === 0) {
		await deps.editOriginal(NO_SHARED_CHANNELS);
		return;
	}

	const active = await activeImportRun(deps.db, guildId);
	const runId = active?.runId ?? `${guildId}-${job.interactionId}`;
	if (active === null) {
		await createImportRun(deps.db, {
			runId,
			guildId,
			estimatedTotal: 0,
			startedAt: now,
		});
	}
	const claimed = await claimImportTargets(
		deps.db,
		{ runId, guildId },
		targets,
		now,
	);
	if (claimed.length > 0) {
		await addToEstimate(
			deps.db,
			runId,
			await estimateMessages(guildId, claimed, deps),
		);
	}
	const state = await runState(deps.db, runId);
	if (isComplete(state)) {
		// すべて取り込み済み
		await finishImportRun(deps.db, runId, now);
		await deps.editOriginal(completedText(state.imported));
		return;
	}
	const started = await startQueuedImports(deps.db, runId, now);
	await deps.enqueueImports(started.map(firstImportJob));
	const content = progressText(state, [], now);
	const message = await deps.editOriginal(content);
	await deps.watch({
		runId,
		guildId,
		channelId: message.channel_id,
		messageId: message.id,
		interactionToken: job.interactionToken,
		createdAt: job.requestedAt,
		content,
	});
	logEvent("import", "import_started", {
		guildId,
		userId: job.userId,
		runId,
		joined: active !== null,
		channels: claimed.length,
		started: started.length,
	});
}

/** 取り込むメッセージの件数の見積もり。数えられなければ(サーバーの検索の準備がまだなど)null */
async function estimateMessages(
	guildId: string,
	channelIds: readonly string[],
	deps: ImportStartDeps,
): Promise<number | null> {
	let total = 0;
	try {
		for (let i = 0; i < channelIds.length; i += MAX_SEARCH_CHANNELS) {
			const count = await deps.countMessages(
				guildId,
				channelIds.slice(i, i + MAX_SEARCH_CHANNELS),
			);
			if (count === null) {
				return null;
			}
			total += count;
		}
	} catch (error) {
		logEvent("import", "import_estimate_failed", {
			guildId,
			error: error instanceof Error ? error.message : "unknown",
		});
		return null;
	}
	return total;
}

/**
 * サーバーのチャンネルとスレッド、ロールの権限とBotのロールを、DiscordのAPIで列挙する。
 * アーカイブされた公開スレッドは、共有チャンネルの分だけ読む(共有しないチャンネルのスレッドは取り込まないため)
 */
export async function listGuild(
	botToken: string,
	guildId: string,
	botUserId: string,
): Promise<GuildSnapshot> {
	const [channels, roles, member, active] = await Promise.all([
		getGuildChannels(botToken, guildId),
		getGuildRoles(botToken, guildId),
		getGuildMember(botToken, guildId, botUserId),
		getActiveGuildThreads(botToken, guildId),
	]);
	const guildRoles: GuildRoles = {
		roles: roles.map((role) => ({
			id: role.id,
			permissions: role.permissions,
		})),
		botRoleIds: member.roles,
	};
	const infos = channels.map((channel) =>
		toChannelInfo(channel as DiscordChannel, guildId),
	);
	const threads = active.threads.map((thread) =>
		toChannelInfo(thread as DiscordChannel, guildId),
	);
	for (const parent of infos) {
		if (
			canHaveThreads(parent.type) &&
			isSharedChannel(parent, undefined, guildRoles, botUserId)
		) {
			threads.push(
				...(await archivedPublicThreads(botToken, parent.channelId, guildId)),
			);
		}
	}
	return { roles: guildRoles, channels: infos, threads };
}

/** チャンネルの、アーカイブされた公開スレッドを全部読む。Botにメッセージ履歴を読む権限がなければ、読まない */
async function archivedPublicThreads(
	botToken: string,
	channelId: string,
	guildId: string,
): Promise<ChannelInfo[]> {
	const threads: ChannelInfo[] = [];
	let before: string | null = null;
	for (;;) {
		let page: Awaited<ReturnType<typeof getArchivedPublicThreads>>;
		try {
			page = await getArchivedPublicThreads(botToken, channelId, before);
		} catch (error) {
			if (error instanceof DiscordApiError && error.status === 403) {
				logEvent("import", "missing_permission", { channelId });
				return threads;
			}
			throw error;
		}
		threads.push(
			...page.threads.map((thread) =>
				toChannelInfo(thread as DiscordChannel, guildId),
			),
		);
		// 続きは、いちばん前にアーカイブされたスレッドの時刻より前から読む
		const last = page.threads.at(-1) as
			| { thread_metadata?: { archive_timestamp?: string } }
			| undefined;
		const archivedAt = last?.thread_metadata?.archive_timestamp;
		if (!page.has_more || archivedAt === undefined) {
			return threads;
		}
		before = archivedAt;
	}
}

/** 本物のD1、Queue、DiscordのAPI、Durable Objectを使う */
function importStartDeps(env: Env, job: ImportCommandJob): ImportStartDeps {
	const token = env.DISCORD_BOT_TOKEN;
	return {
		db: env.DB,
		channels: ingestDeps(env),
		// BotのユーザーIDは、アプリケーションのIDと同じ
		listGuild: (guildId) =>
			listGuild(token, guildId, env.DISCORD_APPLICATION_ID),
		countMessages: (guildId, channelIds) =>
			countGuildMessages(token, guildId, channelIds),
		enqueueImports: (jobs) => enqueueImports(env, jobs),
		editOriginal: (content) =>
			editOriginalInteractionResponse(
				env.DISCORD_APPLICATION_ID,
				job.interactionToken,
				{ content, allowed_mentions: { parse: [] } },
			),
		watch: (display) => progressObject(env, display.guildId).watch(display),
	};
}

/** 取り込みの仕事を、保存用のQueueに入れる */
export async function enqueueImports(
	env: Env,
	jobs: readonly ImportJob[],
): Promise<void> {
	for (let i = 0; i < jobs.length; i += ENQUEUE_BATCH_SIZE) {
		await env.INGEST_QUEUE.sendBatch(
			jobs.slice(i, i + ENQUEUE_BATCH_SIZE).map((job) => ({
				body: job satisfies QueueMessage,
			})),
		);
	}
}

/** サーバーの、進み具合を見張るDurable Object */
function progressObject(env: Env, guildId: string) {
	return env.IMPORT_PROGRESS.get(
		env.IMPORT_PROGRESS.idFromName(`${PROGRESS_OBJECT_PREFIX}${guildId}`),
	);
}

/**
 * 進み具合の表示を書き換える。実行から14分までは、Interactionのトークンで書き換える。
 * その後は、トークンが切れるので、Botのトークンで、Botのメッセージとして書き換える
 */
export async function editProgress(
	env: Env,
	display: ProgressDisplay,
	content: string,
	now: number,
): Promise<EditResult> {
	try {
		if (now - display.createdAt < INTERACTION_EDIT_WINDOW_MS) {
			await editOriginalInteractionResponse(
				env.DISCORD_APPLICATION_ID,
				display.interactionToken,
				{ content },
			);
		} else {
			await editChannelMessage(
				env.DISCORD_BOT_TOKEN,
				display.channelId,
				display.messageId,
				{ content },
			);
		}
		return "ok";
	} catch (error) {
		if (error instanceof DiscordApiError && error.status === 404) {
			return "gone";
		}
		logEvent("import", "import_progress_edit_failed", {
			status: error instanceof DiscordApiError ? error.status : null,
		});
		return "failed";
	}
}
