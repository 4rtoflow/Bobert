/**
 * 応答を始める前に、このメッセージを処理中として記録する。
 * すでに記録があればfalseを返す。GatewayのResumeで同じイベントが届いても、2回返信しないため。
 */
export async function claimMessage(
	db: D1Database,
	messageId: string,
	now = Date.now(),
): Promise<boolean> {
	const result = await db
		.prepare(
			"INSERT OR IGNORE INTO handled_messages (message_id, handled_at) VALUES (?, ?)",
		)
		.bind(messageId, now)
		.run();
	return result.meta.changes === 1;
}

/** 応答に失敗してQueueでやり直すときは、記録を消しておく */
export async function releaseMessage(
	db: D1Database,
	messageId: string,
): Promise<void> {
	await db
		.prepare("DELETE FROM handled_messages WHERE message_id = ?")
		.bind(messageId)
		.run();
}
