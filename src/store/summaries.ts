/**
 * 長い会話の要約と、会話の量の記録(仕様: docs/spec/architecture.md「長い会話の自動要約」)。
 */

/** 保存した要約 */
export interface ConversationSummary {
	/** 会話の起点のメッセージ */
	rootMessageId: string;
	/** このメッセージまでを要約した */
	coveredUntilMessageId: string;
	summary: string;
}

/** 要約を保存する */
export async function saveSummary(
	db: D1Database,
	summary: ConversationSummary & { modelKey: string; createdByUserId: string },
	now = Date.now(),
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO conversation_summaries
			(root_message_id, covered_until_message_id, summary, model_key, created_by_user_id, created_at)
			VALUES (?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			summary.rootMessageId,
			summary.coveredUntilMessageId,
			summary.summary,
			summary.modelKey,
			summary.createdByUserId,
			now,
		)
		.run();
}

/** そのメッセージまでを要約したもの。いくつかあれば、いちばん新しいもの。なければnull */
export async function findSummaryEndingAt(
	db: D1Database,
	messageId: string,
): Promise<ConversationSummary | null> {
	const row = await db
		.prepare(
			`SELECT root_message_id, covered_until_message_id, summary
			FROM conversation_summaries
			WHERE covered_until_message_id = ?
			ORDER BY created_at DESC, id DESC
			LIMIT 1`,
		)
		.bind(messageId)
		.first<{
			root_message_id: string;
			covered_until_message_id: string;
			summary: string;
		}>();
	return row
		? {
				rootMessageId: row.root_message_id,
				coveredUntilMessageId: row.covered_until_message_id,
				summary: row.summary,
			}
		: null;
}

/** Bobertの返答のときに、会話全体を渡した入力のトークン数を記録する。分けて投稿したなら、どのメッセージにも */
export async function recordReplyUsage(
	db: D1Database,
	messageIds: readonly string[],
	inputTokens: number,
	now = Date.now(),
): Promise<void> {
	if (messageIds.length === 0) {
		return;
	}
	await db.batch(
		messageIds.map((messageId) =>
			db
				.prepare(
					"INSERT OR REPLACE INTO reply_usage (message_id, input_tokens, created_at) VALUES (?, ?, ?)",
				)
				.bind(messageId, inputTokens, now),
		),
	);
}

/**
 * 記録した入力のトークン数を、メッセージIDごとに読む。記録のないメッセージは含まない。
 * IDは、1回の問い合わせに入る数(50件)ずつに分けて読む
 */
export async function loadReplyUsage(
	db: D1Database,
	messageIds: readonly string[],
): Promise<Map<string, number>> {
	const usage = new Map<string, number>();
	for (let i = 0; i < messageIds.length; i += 50) {
		const ids = messageIds.slice(i, i + 50);
		const { results } = await db
			.prepare(
				`SELECT message_id, input_tokens FROM reply_usage
				WHERE message_id IN (${ids.map(() => "?").join(", ")})`,
			)
			.bind(...ids)
			.all<{ message_id: string; input_tokens: number }>();
		for (const row of results) {
			usage.set(row.message_id, row.input_tokens);
		}
	}
	return usage;
}
