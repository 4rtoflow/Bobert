/**
 * チャンネルごとの過去ログの取り込みの進み具合と、`/import`の回(仕様: docs/spec/architecture.md「過去ログの取り込み」)。
 * チャンネルの状態は、pending(順番を待っている)、running(取り込み中)、done(最後まで読んだ)、
 * failed(読む権限がない、途中で止まったなど)。
 */

/** 1つの回で、同時に取り込むチャンネルの数。DiscordのAPIとWorkers AIの利用制限に当たらないようにするため */
export const MAX_PARALLEL_IMPORTS = 5;
/**
 * 最後の更新からこれだけたっても取り込み中のままなら、途中で止まったとみなす。
 * ふだんは数秒ごとに更新し、Queueのやり直し(5回まで)も、ふつうは数分以内に終わるため
 */
export const STALL_MS = 10 * 60 * 1000;

/** 1つの問い合わせに入れるIDの数の上限(D1は、1つの問い合わせの値を100個までにしている) */
const MAX_IDS_PER_QUERY = 50;

export interface ChannelImport {
	status: "pending" | "running" | "done" | "failed";
	oldestImportedMessageId: string | null;
	/** 取り込んでいる`/import`の回。`/import`の前に始めたものはnull */
	runId: string | null;
}

/** チャンネルの取り込みの進み具合。まだ始めていなければnull */
export async function getChannelImport(
	db: D1Database,
	channelId: string,
): Promise<ChannelImport | null> {
	const row = await db
		.prepare(
			"SELECT status, oldest_imported_message_id, run_id FROM channel_imports WHERE channel_id = ?",
		)
		.bind(channelId)
		.first<{
			status: ChannelImport["status"];
			oldest_imported_message_id: string | null;
			run_id: string | null;
		}>();
	return row
		? {
				status: row.status,
				oldestImportedMessageId: row.oldest_imported_message_id,
				runId: row.run_id,
			}
		: null;
}

/** 1回分を取り込んだ。oldestMessageIdより新しいメッセージは、取り込み済み。countは、保存した件数 */
export async function recordImportProgress(
	db: D1Database,
	channelId: string,
	oldestMessageId: string,
	count: number,
	now = Date.now(),
): Promise<void> {
	await db
		.prepare(
			`UPDATE channel_imports
			SET status = 'running', oldest_imported_message_id = ?,
				imported_count = imported_count + ?, updated_at = ?
			WHERE channel_id = ?`,
		)
		.bind(oldestMessageId, count, now, channelId)
		.run();
}

/** 最後まで取り込んだ。countは、最後の1回分で保存した件数 */
export async function finishChannelImport(
	db: D1Database,
	channelId: string,
	oldestMessageId: string | null,
	count: number,
	now = Date.now(),
): Promise<void> {
	await db
		.prepare(
			`UPDATE channel_imports
			SET status = 'done',
				oldest_imported_message_id = COALESCE(?, oldest_imported_message_id),
				imported_count = imported_count + ?, finished_at = ?, updated_at = ?
			WHERE channel_id = ?`,
		)
		.bind(oldestMessageId, count, now, now, channelId)
		.run();
}

/** 読む権限がないなどで、取り込めなかった */
export async function failChannelImport(
	db: D1Database,
	channelId: string,
	now = Date.now(),
): Promise<void> {
	await db
		.prepare(
			`UPDATE channel_imports SET status = 'failed', finished_at = ?, updated_at = ?
			WHERE channel_id = ?`,
		)
		.bind(now, now, channelId)
		.run();
}

/** 取り込みの記録を消す(権限付きになったチャンネルや、削除されたチャンネル) */
export async function deleteChannelImports(
	db: D1Database,
	channelIds: readonly string[],
): Promise<void> {
	for (const ids of chunks([...new Set(channelIds)], MAX_IDS_PER_QUERY)) {
		await db
			.prepare(
				`DELETE FROM channel_imports WHERE channel_id IN (${ids.map(() => "?").join(", ")})`,
			)
			.bind(...ids)
			.run();
	}
}

/** `/import`の回 */
export interface ImportRun {
	runId: string;
	guildId: string;
	/** 取り込む件数の見積もり。取れなければnull */
	estimatedTotal: number | null;
	startedAt: number;
}

/** サーバーで進んでいる`/import`の回(順番待ちか取り込み中のチャンネルが残っている回)。なければnull */
export async function activeImportRun(
	db: D1Database,
	guildId: string,
): Promise<ImportRun | null> {
	const row = await db
		.prepare(
			`SELECT * FROM import_runs AS r
			WHERE guild_id = ? AND finished_at IS NULL AND EXISTS (
				SELECT 1 FROM channel_imports
				WHERE channel_imports.run_id = r.run_id AND status IN ('pending', 'running')
			)
			ORDER BY started_at DESC LIMIT 1`,
		)
		.bind(guildId)
		.first<ImportRunRow>();
	return row ? fromRunRow(row) : null;
}

/** `/import`の回を読む */
export async function loadImportRun(
	db: D1Database,
	runId: string,
): Promise<ImportRun | null> {
	const row = await db
		.prepare("SELECT * FROM import_runs WHERE run_id = ?")
		.bind(runId)
		.first<ImportRunRow>();
	return row ? fromRunRow(row) : null;
}

/** `/import`の回を始める */
export async function createImportRun(
	db: D1Database,
	run: ImportRun,
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO import_runs (run_id, guild_id, estimated_total, started_at)
			VALUES (?, ?, ?, ?)`,
		)
		.bind(run.runId, run.guildId, run.estimatedTotal, run.startedAt)
		.run();
}

/** 回に足したチャンネルの見積もりを、回の見積もりに足す。どちらかが分からなければ、分からないとする */
export async function addToEstimate(
	db: D1Database,
	runId: string,
	estimate: number | null,
): Promise<void> {
	await db
		.prepare(
			`UPDATE import_runs
			SET estimated_total = CASE WHEN ?1 IS NULL THEN NULL ELSE estimated_total + ?1 END
			WHERE run_id = ?2`,
		)
		.bind(estimate, runId)
		.run();
}

/** 回が終わったことを記録する */
export async function finishImportRun(
	db: D1Database,
	runId: string,
	now = Date.now(),
): Promise<void> {
	await db
		.prepare(
			"UPDATE import_runs SET finished_at = ? WHERE run_id = ? AND finished_at IS NULL",
		)
		.bind(now, runId)
		.run();
}

/**
 * `/import`の回に、取り込むチャンネルを入れる(順番待ちにする)。この回で取り込みを始めるのは、次のもの。
 * - まだ取り込んでいないもの
 * - 取り込めなかったもの
 * - 途中で止まったもの(最後の更新からSTALL_MS以上たっても、取り込み中のもの)
 * 取り込み済みのものと、取り込み中のものは、そのまま。回に入れたチャンネルのIDを返す。
 * 2回同時に実行されても同じチャンネルを二重に入れないよう、状態を確かめながら書き換える
 */
export async function claimImportTargets(
	db: D1Database,
	run: Pick<ImportRun, "runId" | "guildId">,
	channelIds: readonly string[],
	now = Date.now(),
): Promise<string[]> {
	const claimed: string[] = [];
	for (const ids of chunks([...new Set(channelIds)], MAX_IDS_PER_QUERY)) {
		const inserted = await db.batch(
			ids.map((channelId) =>
				db
					.prepare(
						`INSERT OR IGNORE INTO channel_imports
							(channel_id, status, started_at, updated_at, guild_id, run_id, imported_count)
						VALUES (?, 'pending', ?, ?, ?, ?, 0)`,
					)
					.bind(channelId, now, now, run.guildId, run.runId),
			),
		);
		const existing = ids.filter(
			(_, index) => inserted[index]?.meta.changes !== 1,
		);
		claimed.push(
			...ids.filter((_, index) => inserted[index]?.meta.changes === 1),
		);
		if (existing.length === 0) {
			continue;
		}
		const updated = await db.batch(
			existing.map((channelId) =>
				db
					.prepare(
						`UPDATE channel_imports
						SET status = 'pending', run_id = ?, guild_id = ?, imported_count = 0,
							started_at = ?, updated_at = ?, finished_at = NULL
						WHERE channel_id = ? AND (
							status = 'failed'
							OR (status IN ('pending', 'running') AND updated_at < ?)
						)`,
					)
					.bind(run.runId, run.guildId, now, now, channelId, now - STALL_MS),
			),
		);
		claimed.push(
			...existing.filter((_, index) => updated[index]?.meta.changes === 1),
		);
	}
	return claimed;
}

/** 取り込みを始めたチャンネル。この後、beforeより古い方へ読む */
export interface StartedImport {
	channelId: string;
	guildId: string | null;
	before: string | null;
}

/**
 * 回の順番待ちのチャンネルの取り込みを、同時に取り込む数の上限まで始める(取り込み中にする)。始めたものを返す。
 * 呼んだ側は、始めたものの取り込みの仕事をQueueに入れる
 */
export async function startQueuedImports(
	db: D1Database,
	runId: string,
	now = Date.now(),
): Promise<StartedImport[]> {
	const running =
		(await db
			.prepare(
				"SELECT COUNT(*) AS count FROM channel_imports WHERE run_id = ? AND status = 'running'",
			)
			.bind(runId)
			.first<number>("count")) ?? 0;
	const slots = MAX_PARALLEL_IMPORTS - running;
	if (slots <= 0) {
		return [];
	}
	const { results: queued } = await db
		.prepare(
			`SELECT channel_id FROM channel_imports
			WHERE run_id = ? AND status = 'pending'
			ORDER BY started_at, channel_id LIMIT ?`,
		)
		.bind(runId, slots)
		.all<{ channel_id: string }>();
	if (queued.length === 0) {
		return [];
	}
	// ほかの処理が先に始めていたら、二重に始めない
	const started = await db.batch(
		queued.map((row) =>
			db
				.prepare(
					`UPDATE channel_imports SET status = 'running', updated_at = ?
					WHERE channel_id = ? AND run_id = ? AND status = 'pending'
					RETURNING channel_id, guild_id, oldest_imported_message_id`,
				)
				.bind(now, row.channel_id, runId),
		),
	);
	return started.flatMap((result) =>
		(
			result.results as {
				channel_id: string;
				guild_id: string | null;
				oldest_imported_message_id: string | null;
			}[]
		).map((row) => ({
			channelId: row.channel_id,
			guildId: row.guild_id,
			before: row.oldest_imported_message_id,
		})),
	);
}

/**
 * 回の取り込み中のチャンネルのうち、途中で止まったもの(最後の更新からSTALL_MS以上たったもの)を、
 * 取り込めなかったとする。そうしたチャンネルのIDを返す。次の`/import`で、やり直す
 */
export async function failStalledImports(
	db: D1Database,
	runId: string,
	now = Date.now(),
): Promise<string[]> {
	const { results } = await db
		.prepare(
			`UPDATE channel_imports SET status = 'failed', finished_at = ?, updated_at = ?
			WHERE run_id = ? AND status = 'running' AND updated_at < ?
			RETURNING channel_id`,
		)
		.bind(now, now, runId, now - STALL_MS)
		.all<{ channel_id: string }>();
	return results.map((row) => row.channel_id);
}

/** 回の進み具合 */
export interface ImportRunProgress {
	/** 回に入れたチャンネルの数 */
	channels: number;
	/** 取り込み済みか、取り込めなかったチャンネルの数 */
	finished: number;
	/** この回で取り込んだメッセージの数 */
	imported: number;
}

export async function importRunProgress(
	db: D1Database,
	runId: string,
): Promise<ImportRunProgress> {
	const row = await db
		.prepare(
			`SELECT COUNT(*) AS channels,
				COALESCE(SUM(status IN ('done', 'failed')), 0) AS finished,
				COALESCE(SUM(imported_count), 0) AS imported
			FROM channel_imports WHERE run_id = ?`,
		)
		.bind(runId)
		.first<ImportRunProgress>();
	return row ?? { channels: 0, finished: 0, imported: 0 };
}

interface ImportRunRow {
	run_id: string;
	guild_id: string;
	estimated_total: number | null;
	started_at: number;
}

function fromRunRow(row: ImportRunRow): ImportRun {
	return {
		runId: row.run_id,
		guildId: row.guild_id,
		estimatedTotal: row.estimated_total,
		startedAt: row.started_at,
	};
}

function chunks<T>(items: readonly T[], size: number): T[][] {
	const result: T[][] = [];
	for (let i = 0; i < items.length; i += size) {
		result.push(items.slice(i, i + size));
	}
	return result;
}
