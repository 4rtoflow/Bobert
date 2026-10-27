/**
 * 「Bobertに聞く」の返答と、説明の対象のメッセージの対応(仕様: docs/spec/behavior.md「スラッシュコマンド」の右クリックメニュー)。
 * Interactionへの返答は「返信」ではないので、返答に返信して会話を続けたときに、説明の対象までたどるために使う
 */

/** 返答と、説明の対象のメッセージの対応を保存する */
export async function saveExplainTarget(
	db: D1Database,
	responseMessageId: string,
	targetMessageId: string,
	now = Date.now(),
): Promise<void> {
	await db
		.prepare(
			"INSERT OR REPLACE INTO explain_targets (response_message_id, target_message_id, created_at) VALUES (?, ?, ?)",
		)
		.bind(responseMessageId, targetMessageId, now)
		.run();
}

/** 「Bobertに聞く」の返答なら、説明の対象のメッセージのID。違えばnull */
export async function findExplainTarget(
	db: D1Database,
	responseMessageId: string,
): Promise<string | null> {
	return db
		.prepare(
			"SELECT target_message_id FROM explain_targets WHERE response_message_id = ?",
		)
		.bind(responseMessageId)
		.first<string>("target_message_id");
}
