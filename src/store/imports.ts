/**
 * チャンネルごとの過去ログの取り込みの進み具合(仕様: docs/spec/architecture.md「過去ログの取り込み」)。
 * 状態は、pending(仕事を入れた)、running(取り込み中)、done(最後まで読んだ)、failed(読む権限がないなど)。
 */

/** 取り込みを始めたことを記録する。すでに記録があれば(一度始めていれば)falseを返す */
export async function claimChannelImport(
	db: D1Database,
	channelId: string,
	now = Date.now(),
): Promise<boolean> {
	const result = await db
		.prepare(
			`INSERT OR IGNORE INTO channel_imports (channel_id, status, started_at, updated_at)
			VALUES (?, 'pending', ?, ?)`,
		)
		.bind(channelId, now, now)
		.run();
	return result.meta.changes === 1;
}

/** 取り込みの記録を消す。仕事を入れられなかったときに、次に使われたときにやり直すため */
export async function releaseChannelImport(
	db: D1Database,
	channelId: string,
): Promise<void> {
	await db
		.prepare("DELETE FROM channel_imports WHERE channel_id = ?")
		.bind(channelId)
		.run();
}

/** 1回分を取り込んだ。oldestMessageIdより新しいメッセージは、取り込み済み */
export async function recordImportProgress(
	db: D1Database,
	channelId: string,
	oldestMessageId: string,
	now = Date.now(),
): Promise<void> {
	await db
		.prepare(
			`UPDATE channel_imports
			SET status = 'running', oldest_imported_message_id = ?, updated_at = ?
			WHERE channel_id = ?`,
		)
		.bind(oldestMessageId, now, channelId)
		.run();
}

/** 最後まで取り込んだ */
export async function finishChannelImport(
	db: D1Database,
	channelId: string,
	oldestMessageId: string | null,
	now = Date.now(),
): Promise<void> {
	await db
		.prepare(
			`UPDATE channel_imports
			SET status = 'done',
				oldest_imported_message_id = COALESCE(?, oldest_imported_message_id),
				finished_at = ?, updated_at = ?
			WHERE channel_id = ?`,
		)
		.bind(oldestMessageId, now, now, channelId)
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

export interface ChannelImport {
	status: "pending" | "running" | "done" | "failed";
	oldestImportedMessageId: string | null;
}

/** チャンネルの取り込みの進み具合。まだ始めていなければnull */
export async function getChannelImport(
	db: D1Database,
	channelId: string,
): Promise<ChannelImport | null> {
	const row = await db
		.prepare(
			"SELECT status, oldest_imported_message_id FROM channel_imports WHERE channel_id = ?",
		)
		.bind(channelId)
		.first<{
			status: ChannelImport["status"];
			oldest_imported_message_id: string | null;
		}>();
	return row
		? {
				status: row.status,
				oldestImportedMessageId: row.oldest_imported_message_id,
			}
		: null;
}
