/**
 * 知識チャンネルと、知識のファイル(仕様: docs/spec/architecture.md「知識チャンネル」)。
 * 知識チャンネルに送られたファイルを文字にして保存し、要約を付けて、AIに渡す一覧と、読む道具に使う
 */

/** 1つの問い合わせに入れるIDの数の上限(D1は、1つの問い合わせの値を100個までにしている) */
const MAX_IDS_PER_QUERY = 50;

/**
 * 文字にした内容を、D1に入れるときの区切りの長さ(UTF-16の長さ)。
 * UTF-8で3バイトの文字ばかりでも90KBで、1つのSQL文の上限(100KB)と、1行の上限(2MB)に収まる
 */
export const KNOWLEDGE_TEXT_PART_LENGTH = 30_000;

/** 文字にした内容を入れるときに、1回のまとめた書き込みに入れる区切りの数 */
const PARTS_PER_BATCH = 10;

/** 知識のファイルの形式。csvとtextは、文字としてそのまま読む。pptxは、PDFにしてから文字にする */
export type KnowledgeFormat =
	| "pdf"
	| "docx"
	| "xlsx"
	| "xls"
	| "pptx"
	| "csv"
	| "text";

/**
 * 知識のファイルの状態。pendingは受け付けた(文字にするのを待つ)、convertedは文字にした(要約を待つ)、
 * readyは知識に入った(一覧に載り、読める)、rejectedは知識に加えなかった
 */
export type KnowledgeState = "pending" | "converted" | "ready" | "rejected";

/** 知識に加えなかった理由(記録とログに残す) */
export type KnowledgeRejection =
	/** 送った人が、AIのキーを登録していない */
	| "no_key"
	/** 大きすぎる(20MBを超える) */
	| "too_large"
	/** 文字にできない(壊れている、パスワード付き、文字がないなど) */
	| "unreadable"
	/** 要約できない(キーが無効、残高不足、AIに断られたなど) */
	| "summary_failed"
	/** 障害などで、やり直しても文字にするか要約するかができなかった */
	| "retry_failed";

/** 知識チャンネル */
export interface KnowledgeChannel {
	channelId: string;
	guildId: string;
	/** 指定した人 */
	designatedBy: string;
	/** 指定した日時。これより後に送られたファイルだけを加える */
	designatedAt: number;
}

/** 知識のファイル */
export interface KnowledgeFile {
	/** AIに見せるID(k12の12) */
	id: number;
	guildId: string;
	/** 指定された知識チャンネル(スレッドの中のファイルなら、親のチャンネル) */
	knowledgeChannelId: string;
	/** ファイルのメッセージがあるチャンネル(スレッドの中なら、スレッド) */
	channelId: string;
	messageId: string;
	/** 添付ファイルのID(src/respond/attachments.ts の attachmentKey) */
	attachmentId: string;
	filename: string;
	format: KnowledgeFormat;
	size: number;
	authorId: string;
	/** 送ったときに、サーバーで見えていた名前 */
	authorName: string;
	/** 送った日時(メッセージの投稿時刻) */
	postedAt: number;
	state: KnowledgeState;
	rejectedReason: KnowledgeRejection | null;
	/** 文字にした内容の長さ(UTF-16の長さ)。文字にするまではnull */
	textLength: number | null;
	/** 要約。要約するまではnull */
	summary: string | null;
}

/**
 * 消したか、知識に加えないことにした、知識のファイル。D1の外に置いたもの(PowerPointをPDFにしたもの)を、
 * 呼んだ側で消すのに使う
 */
export interface ForgottenKnowledgeFile {
	id: number;
	format: KnowledgeFormat;
}

/** 新しく受け付けるファイル */
export type NewKnowledgeFile = Omit<
	KnowledgeFile,
	"id" | "state" | "rejectedReason" | "textLength" | "summary"
>;

interface KnowledgeFileRow {
	id: number;
	guild_id: string;
	knowledge_channel_id: string;
	channel_id: string;
	message_id: string;
	attachment_id: string;
	filename: string;
	format: string;
	size: number;
	author_id: string;
	author_name: string;
	posted_at: number;
	state: string;
	rejected_reason: string | null;
	text_length: number | null;
	summary: string | null;
}

/** 知識チャンネルを読む。指定されていなければnull */
export async function getKnowledgeChannel(
	db: D1Database,
	channelId: string,
): Promise<KnowledgeChannel | null> {
	const row = await db
		.prepare(
			"SELECT channel_id, guild_id, designated_by, designated_at FROM knowledge_channels WHERE channel_id = ?",
		)
		.bind(channelId)
		.first<{
			channel_id: string;
			guild_id: string;
			designated_by: string;
			designated_at: number;
		}>();
	return row === null
		? null
		: {
				channelId: row.channel_id,
				guildId: row.guild_id,
				designatedBy: row.designated_by,
				designatedAt: row.designated_at,
			};
}

/** サーバーの知識チャンネルと、それぞれの知識のファイル(知識に入ったもの)の数。指定した順 */
export async function listKnowledgeChannels(
	db: D1Database,
	guildId: string,
): Promise<{ channelId: string; files: number }[]> {
	const { results } = await db
		.prepare(
			`SELECT k.channel_id,
				(SELECT COUNT(*) FROM knowledge_files f WHERE f.knowledge_channel_id = k.channel_id AND f.state = 'ready') AS files
			FROM knowledge_channels k
			WHERE k.guild_id = ?
			ORDER BY k.designated_at, k.channel_id`,
		)
		.bind(guildId)
		.all<{ channel_id: string; files: number }>();
	return results.map((row) => ({
		channelId: row.channel_id,
		files: row.files,
	}));
}

/** 知識チャンネルから加えた知識のファイル(知識に入ったもの)の数 */
export async function countKnowledgeFiles(
	db: D1Database,
	channelId: string,
): Promise<number> {
	const row = await db
		.prepare(
			"SELECT COUNT(*) AS files FROM knowledge_files WHERE knowledge_channel_id = ? AND state = 'ready'",
		)
		.bind(channelId)
		.first<{ files: number }>();
	return row?.files ?? 0;
}

/** チャンネルを知識チャンネルにする。すでに知識チャンネルなら、何もせずにfalseを返す */
export async function designateKnowledgeChannel(
	db: D1Database,
	channel: Omit<KnowledgeChannel, "designatedAt">,
	now = Date.now(),
): Promise<boolean> {
	const result = await db
		.prepare(
			`INSERT INTO knowledge_channels (channel_id, guild_id, designated_by, designated_at)
			VALUES (?, ?, ?, ?)
			ON CONFLICT (channel_id) DO NOTHING`,
		)
		.bind(channel.channelId, channel.guildId, channel.designatedBy, now)
		.run();
	return result.meta.changes > 0;
}

/**
 * 知識チャンネルを解除し、そのチャンネル(中のスレッドを含む)から加えた知識を消す。
 * 消した知識のファイル(知識に加えなかったものを含む)を返す
 */
export async function removeKnowledgeChannel(
	db: D1Database,
	channelId: string,
): Promise<ForgottenKnowledgeFile[]> {
	const [, files] = await db.batch([
		db
			.prepare(
				"DELETE FROM knowledge_texts WHERE file_id IN (SELECT id FROM knowledge_files WHERE knowledge_channel_id = ?)",
			)
			.bind(channelId),
		db
			.prepare(
				"DELETE FROM knowledge_files WHERE knowledge_channel_id = ? RETURNING id, format",
			)
			.bind(channelId),
		db
			.prepare("DELETE FROM knowledge_channels WHERE channel_id = ?")
			.bind(channelId),
	]);
	return forgottenFrom(files);
}

/**
 * チャンネル(とスレッド)のうち、知識チャンネルとその中のスレッドを見分ける。
 * チャンネルのIDごとに、指定された知識チャンネルと、指定した日時を返す。スレッドは、親のチャンネルの記録で見分ける
 */
export async function knowledgeChannelsFor(
	db: D1Database,
	channelIds: readonly string[],
): Promise<Map<string, { knowledgeChannelId: string; designatedAt: number }>> {
	const found = new Map<
		string,
		{ knowledgeChannelId: string; designatedAt: number }
	>();
	for (const ids of chunks([...new Set(channelIds)], MAX_IDS_PER_QUERY)) {
		const marks = ids.map(() => "?").join(", ");
		const [direct, threads] = await db.batch([
			db
				.prepare(
					`SELECT channel_id, channel_id AS knowledge_channel_id, designated_at
					FROM knowledge_channels WHERE channel_id IN (${marks})`,
				)
				.bind(...ids),
			db
				.prepare(
					`SELECT c.channel_id, k.channel_id AS knowledge_channel_id, k.designated_at
					FROM channels c JOIN knowledge_channels k ON k.channel_id = c.parent_id
					WHERE c.channel_id IN (${marks})`,
				)
				.bind(...ids),
		]);
		for (const row of [
			...((direct?.results ?? []) as KnowledgeChannelMatch[]),
			...((threads?.results ?? []) as KnowledgeChannelMatch[]),
		]) {
			found.set(row.channel_id, {
				knowledgeChannelId: row.knowledge_channel_id,
				designatedAt: row.designated_at,
			});
		}
	}
	return found;
}

interface KnowledgeChannelMatch {
	channel_id: string;
	knowledge_channel_id: string;
	designated_at: number;
}

/**
 * 知識チャンネルに送られたファイルを、受け付けた(pending)として記録する。新しく記録したもののIDを返す。
 * 同じ添付ファイルがすでにあれば(作成と編集の通知が両方届いたときなど)、記録しない。
 * 消されたメッセージ(削除の記録があるもの)と、指定が外された(か、指定より前に送られた)ものも、記録しない
 */
export async function addPendingKnowledgeFiles(
	db: D1Database,
	files: readonly NewKnowledgeFile[],
	now = Date.now(),
): Promise<number[]> {
	if (files.length === 0) {
		return [];
	}
	const results = await db.batch(
		files.map((file) =>
			db
				.prepare(
					`INSERT INTO knowledge_files (
						guild_id, knowledge_channel_id, channel_id, message_id, attachment_id, filename, format, size,
						author_id, author_name, posted_at, state, created_at, updated_at
					)
					SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'pending', ?12, ?12
					WHERE NOT EXISTS (SELECT 1 FROM deleted_messages WHERE message_id = ?4)
						AND EXISTS (SELECT 1 FROM knowledge_channels WHERE channel_id = ?2 AND designated_at <= ?11)
					ON CONFLICT (message_id, attachment_id) DO NOTHING
					RETURNING id`,
				)
				.bind(
					file.guildId,
					file.knowledgeChannelId,
					file.channelId,
					file.messageId,
					file.attachmentId,
					file.filename,
					file.format,
					file.size,
					file.authorId,
					file.authorName,
					file.postedAt,
					now,
				),
		),
	);
	return results.flatMap((result) =>
		((result.results ?? []) as { id: number }[]).map((row) => row.id),
	);
}

/** 知識のファイルを、IDで読む。なければnull */
export async function loadKnowledgeFile(
	db: D1Database,
	id: number,
): Promise<KnowledgeFile | null> {
	const row = await db
		.prepare("SELECT * FROM knowledge_files WHERE id = ?")
		.bind(id)
		.first<KnowledgeFileRow>();
	return row === null ? null : fromRow(row);
}

/** 知識に入ったファイルを、サーバーとIDで読む(読む道具で使う)。ほかのサーバーのものと、知識に入っていないものはnull */
export async function findKnowledgeFile(
	db: D1Database,
	guildId: string,
	id: number,
): Promise<KnowledgeFile | null> {
	const row = await db
		.prepare(
			"SELECT * FROM knowledge_files WHERE id = ? AND guild_id = ? AND state = 'ready'",
		)
		.bind(id, guildId)
		.first<KnowledgeFileRow>();
	return row === null ? null : fromRow(row);
}

/** メッセージの、知識のファイル(知識に加えなかったものを含む) */
export async function knowledgeFilesOfMessages(
	db: D1Database,
	messageIds: readonly string[],
): Promise<KnowledgeFile[]> {
	const found: KnowledgeFile[] = [];
	for (const ids of chunks([...new Set(messageIds)], MAX_IDS_PER_QUERY)) {
		const { results } = await db
			.prepare(
				`SELECT * FROM knowledge_files WHERE message_id IN (${ids.map(() => "?").join(", ")})`,
			)
			.bind(...ids)
			.all<KnowledgeFileRow>();
		found.push(...results.map(fromRow));
	}
	return found;
}

/**
 * サーバーの、知識に入ったファイルを、新しい順にlimit件まで読む(AIに渡す一覧)。
 * totalは、知識に入ったファイルの全部の数
 */
export async function listReadyKnowledgeFiles(
	db: D1Database,
	guildId: string,
	limit: number,
): Promise<{ files: KnowledgeFile[]; total: number }> {
	const [files, count] = await db.batch([
		db
			.prepare(
				`SELECT * FROM knowledge_files WHERE guild_id = ? AND state = 'ready'
				ORDER BY posted_at DESC, id DESC LIMIT ?`,
			)
			.bind(guildId, limit),
		db
			.prepare(
				"SELECT COUNT(*) AS total FROM knowledge_files WHERE guild_id = ? AND state = 'ready'",
			)
			.bind(guildId),
	]);
	return {
		files: ((files?.results ?? []) as KnowledgeFileRow[]).map(fromRow),
		total:
			((count?.results ?? [])[0] as { total: number } | undefined)?.total ?? 0,
	};
}

/**
 * 文字にした内容を保存し、文字にした(converted)にする。受け付けた(pending)ままのときだけ保存する。
 * 保存している間に、消されたり、知識に加えないことになったりしたら、入れた分を消してfalseを返す
 */
export async function saveKnowledgeText(
	db: D1Database,
	id: number,
	text: string,
	now = Date.now(),
): Promise<boolean> {
	await db
		.prepare("DELETE FROM knowledge_texts WHERE file_id = ?")
		.bind(id)
		.run();
	const parts = splitText(text, KNOWLEDGE_TEXT_PART_LENGTH);
	for (let i = 0; i < parts.length; i += PARTS_PER_BATCH) {
		await db.batch(
			parts.slice(i, i + PARTS_PER_BATCH).map((part, j) =>
				db
					.prepare(
						`INSERT INTO knowledge_texts (file_id, part, start_offset, end_offset, text)
						SELECT ?1, ?2, ?3, ?4, ?5
						WHERE EXISTS (SELECT 1 FROM knowledge_files WHERE id = ?1 AND state = 'pending')`,
					)
					.bind(id, i + j, part.start, part.end, part.text),
			),
		);
	}
	const result = await db
		.prepare(
			`UPDATE knowledge_files SET state = 'converted', text_length = ?, updated_at = ?
			WHERE id = ? AND state = 'pending'`,
		)
		.bind(text.length, now, id)
		.run();
	if (result.meta.changes > 0) {
		return true;
	}
	await db
		.prepare("DELETE FROM knowledge_texts WHERE file_id = ?")
		.bind(id)
		.run();
	return false;
}

/**
 * 文字にした内容のうち、start文字目からlength文字分が入った部分を読む。
 * 返すのは、区切りの境目から読んだ文で、startは、その最初の文字が全体の何文字目か
 */
export async function loadKnowledgeText(
	db: D1Database,
	id: number,
	start: number,
	length: number,
): Promise<{ start: number; text: string }> {
	const { results } = await db
		.prepare(
			`SELECT start_offset, text FROM knowledge_texts
			WHERE file_id = ? AND end_offset > ? AND start_offset < ?
			ORDER BY part`,
		)
		.bind(id, start, start + length)
		.all<{ start_offset: number; text: string }>();
	return {
		start: results[0]?.start_offset ?? start,
		text: results.map((row) => row.text).join(""),
	};
}

/** 要約を保存し、知識に入った(ready)にする。文字にした(converted)ままのときだけ保存する */
export async function saveKnowledgeSummary(
	db: D1Database,
	id: number,
	summary: string,
	now = Date.now(),
): Promise<boolean> {
	const result = await db
		.prepare(
			`UPDATE knowledge_files SET state = 'ready', summary = ?, updated_at = ?
			WHERE id = ? AND state = 'converted'`,
		)
		.bind(summary, now, id)
		.run();
	return result.meta.changes > 0;
}

/**
 * 知識のファイルを、知識に加えなかった(rejected)にし、文字にした内容を消す。
 * 受け付けたか文字にした状態のときだけ変える。変えたらtrue(同じファイルで二度知らせないため)
 */
export async function rejectKnowledgeFile(
	db: D1Database,
	id: number,
	reason: KnowledgeRejection,
	now = Date.now(),
): Promise<boolean> {
	const [update] = await db.batch([
		db
			.prepare(
				`UPDATE knowledge_files SET state = 'rejected', rejected_reason = ?, text_length = NULL, summary = NULL, updated_at = ?
				WHERE id = ? AND state IN ('pending', 'converted')`,
			)
			.bind(reason, now, id),
		db.prepare("DELETE FROM knowledge_texts WHERE file_id = ?").bind(id),
	]);
	return (update?.meta.changes ?? 0) > 0;
}

/**
 * メッセージのうち、まだ知識に入っていないファイルを、まとめて知識に加えなかった(rejected)にする
 * (送った人がキーを登録していないとき。メッセージごとに1回だけ知らせるため)。変えたファイルを返す
 */
export async function rejectPendingKnowledgeFiles(
	db: D1Database,
	messageId: string,
	reason: KnowledgeRejection,
	now = Date.now(),
): Promise<ForgottenKnowledgeFile[]> {
	const [, update] = await db.batch([
		db
			.prepare(
				`DELETE FROM knowledge_texts WHERE file_id IN (
					SELECT id FROM knowledge_files WHERE message_id = ? AND state IN ('pending', 'converted')
				)`,
			)
			.bind(messageId),
		db
			.prepare(
				`UPDATE knowledge_files SET state = 'rejected', rejected_reason = ?, text_length = NULL, summary = NULL, updated_at = ?
				WHERE message_id = ? AND state IN ('pending', 'converted')
				RETURNING id, format`,
			)
			.bind(reason, now, messageId),
	]);
	return forgottenFrom(update);
}

/** 知識のファイルを、IDを指定して消す(文字にした内容も)。消したファイルを返す */
export async function deleteKnowledgeFiles(
	db: D1Database,
	ids: readonly number[],
): Promise<ForgottenKnowledgeFile[]> {
	const deleted: ForgottenKnowledgeFile[] = [];
	for (const part of chunks([...new Set(ids)], MAX_IDS_PER_QUERY)) {
		const marks = part.map(() => "?").join(", ");
		const [, files] = await db.batch([
			db
				.prepare(`DELETE FROM knowledge_texts WHERE file_id IN (${marks})`)
				.bind(...part),
			db
				.prepare(
					`DELETE FROM knowledge_files WHERE id IN (${marks}) RETURNING id, format`,
				)
				.bind(...part),
		]);
		deleted.push(...forgottenFrom(files));
	}
	return deleted;
}

/** 消されたメッセージの、知識のファイルを消す(文字にした内容も)。消したファイルを返す */
export async function deleteKnowledgeFilesOfMessages(
	db: D1Database,
	messageIds: readonly string[],
): Promise<ForgottenKnowledgeFile[]> {
	const deleted: ForgottenKnowledgeFile[] = [];
	for (const ids of chunks([...new Set(messageIds)], MAX_IDS_PER_QUERY)) {
		const marks = ids.map(() => "?").join(", ");
		const [, files] = await db.batch([
			db
				.prepare(
					`DELETE FROM knowledge_texts WHERE file_id IN (SELECT id FROM knowledge_files WHERE message_id IN (${marks}))`,
				)
				.bind(...ids),
			db
				.prepare(
					`DELETE FROM knowledge_files WHERE message_id IN (${marks}) RETURNING id, format`,
				)
				.bind(...ids),
		]);
		deleted.push(...forgottenFrom(files));
	}
	return deleted;
}

/**
 * 消されたチャンネルと、共有しなくなったチャンネル(中のスレッドを含む)の、知識を消す。
 * 知識チャンネルなら、指定も外す。外した知識チャンネルの数と、消したファイルを返す
 */
export async function forgetKnowledgeChannels(
	db: D1Database,
	channelIds: readonly string[],
): Promise<{ channels: number; files: ForgottenKnowledgeFile[] }> {
	let channels = 0;
	const files: ForgottenKnowledgeFile[] = [];
	// 1つの問い合わせに、同じIDを2回ずつ入れるので、半分ずつにする
	for (const ids of chunks([...new Set(channelIds)], MAX_IDS_PER_QUERY / 2)) {
		const marks = ids.map(() => "?").join(", ");
		const [, deletedFiles, deletedChannels] = await db.batch([
			db
				.prepare(
					`DELETE FROM knowledge_texts WHERE file_id IN (
						SELECT id FROM knowledge_files WHERE channel_id IN (${marks}) OR knowledge_channel_id IN (${marks})
					)`,
				)
				.bind(...ids, ...ids),
			db
				.prepare(
					`DELETE FROM knowledge_files WHERE channel_id IN (${marks}) OR knowledge_channel_id IN (${marks})
					RETURNING id, format`,
				)
				.bind(...ids, ...ids),
			db
				.prepare(
					`DELETE FROM knowledge_channels WHERE channel_id IN (${marks})`,
				)
				.bind(...ids),
		]);
		files.push(...forgottenFrom(deletedFiles));
		channels += deletedChannels?.meta.changes ?? 0;
	}
	return { channels, files };
}

/**
 * 文字を、長さsizeまでの区切りに分ける。サロゲートペア(絵文字など)の途中では分けない。
 * 区切りごとに、全体のどこからどこまでか(UTF-16の位置)を添える
 */
export function splitText(
	text: string,
	size: number,
): { start: number; end: number; text: string }[] {
	const parts: { start: number; end: number; text: string }[] = [];
	let start = 0;
	while (start < text.length) {
		let end = Math.min(start + size, text.length);
		if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1))) {
			end--;
		}
		parts.push({ start, end, text: text.slice(start, end) });
		start = end;
	}
	return parts;
}

function isHighSurrogate(code: number): boolean {
	return code >= 0xd800 && code <= 0xdbff;
}

/** 消したか、知識に加えないことにした行(RETURNING id, format)を読む */
function forgottenFrom(result: D1Result | undefined): ForgottenKnowledgeFile[] {
	return ((result?.results ?? []) as { id: number; format: string }[]).map(
		(row) => ({ id: row.id, format: row.format as KnowledgeFormat }),
	);
}

function fromRow(row: KnowledgeFileRow): KnowledgeFile {
	return {
		id: row.id,
		guildId: row.guild_id,
		knowledgeChannelId: row.knowledge_channel_id,
		channelId: row.channel_id,
		messageId: row.message_id,
		attachmentId: row.attachment_id,
		filename: row.filename,
		format: row.format as KnowledgeFormat,
		size: row.size,
		authorId: row.author_id,
		authorName: row.author_name,
		postedAt: row.posted_at,
		state: row.state as KnowledgeState,
		rejectedReason: row.rejected_reason as KnowledgeRejection | null,
		textLength: row.text_length,
		summary: row.summary,
	};
}

function chunks<T>(items: readonly T[], size: number): T[][] {
	const result: T[][] = [];
	for (let i = 0; i < items.length; i += size) {
		result.push(items.slice(i, i + size));
	}
	return result;
}
