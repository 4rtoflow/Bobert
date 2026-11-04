/**
 * Bobert.md(サーバーの全員への返答で、AIに毎回渡す、サーバーの情報や指示。仕様: docs/spec/behavior.md「Bobert.md」)。
 * サーバーごとに1行。誰でも編集できるので、最後に編集した人を残す
 */

/** Bobert.mdの長さの上限(Discordの入力欄の上限。DiscordはUTF-16の長さで数える) */
export const MAX_BOBERT_MD_LENGTH = 4000;

/** サーバーのBobert.md */
export interface BobertMd {
	/** 中身。空にされていたら空の文字列 */
	content: string;
	/** 最後に編集した人の、そのときにサーバーで見えていた名前 */
	editedByName: string;
	/** 最後に編集した日時 */
	updatedAt: number;
}

/** Bobert.mdを編集した人。名前は、サーバーで見えている名前 */
export interface BobertMdEditor {
	id: string;
	name: string;
}

interface BobertMdRow {
	content: string;
	edited_by_name: string;
	updated_at: number;
}

/** サーバーのBobert.md。まだ誰も編集していなければnull */
export async function getBobertMd(
	db: D1Database,
	guildId: string,
): Promise<BobertMd | null> {
	const row = await db
		.prepare(
			"SELECT content, edited_by_name, updated_at FROM bobert_md WHERE guild_id = ?",
		)
		.bind(guildId)
		.first<BobertMdRow>();
	return row === null
		? null
		: {
				content: row.content,
				editedByName: row.edited_by_name,
				updatedAt: row.updated_at,
			};
}

/**
 * Bobert.mdの保存の結果。unchangedは、中身が今と同じだったので、保存し直さなかった。
 * conflictは、編集の画面を開いた後に、ほかの人が変えていた
 */
export type SaveBobertMdResult = "saved" | "unchanged" | "conflict";

/**
 * Bobert.mdを書き換える。空の文字列なら、空にする(誰が消したかを残すため、行は消さない)。
 * 編集の画面を開いたときの更新日時(expectedUpdatedAt。まだ誰も編集していなければ0)から変わっていたら、書き換えない。
 * 中身が今と同じなら、最後に編集した人を変えないよう、保存し直さない。
 * 更新日時は、前の値より必ず進める(同じ時刻に2回書き換えても、重なりを見つけられるように)
 */
export async function saveBobertMd(
	db: D1Database,
	guildId: string,
	expectedUpdatedAt: number,
	content: string,
	editor: BobertMdEditor,
	now = Date.now(),
): Promise<SaveBobertMdResult> {
	const current = await getBobertMd(db, guildId);
	if (
		!Number.isSafeInteger(expectedUpdatedAt) ||
		(current?.updatedAt ?? 0) !== expectedUpdatedAt
	) {
		return "conflict";
	}
	if ((current?.content ?? "") === content) {
		return "unchanged";
	}
	// 読んだ後に、ほかの人が先に書いていたら、書き換えない(足すときは同じサーバーの行があれば、書き換えるときは更新日時が変わっていれば)
	const result =
		current === null
			? await db
					.prepare(
						`INSERT INTO bobert_md (guild_id, content, edited_by_id, edited_by_name, updated_at)
						VALUES (?, ?, ?, ?, ?)
						ON CONFLICT (guild_id) DO NOTHING`,
					)
					.bind(guildId, content, editor.id, editor.name, now)
					.run()
			: await db
					.prepare(
						`UPDATE bobert_md SET
							content = ?, edited_by_id = ?, edited_by_name = ?,
							updated_at = MAX(?, updated_at + 1)
						WHERE guild_id = ? AND updated_at = ?`,
					)
					.bind(
						content,
						editor.id,
						editor.name,
						now,
						guildId,
						expectedUpdatedAt,
					)
					.run();
	return result.meta.changes > 0 ? "saved" : "conflict";
}
