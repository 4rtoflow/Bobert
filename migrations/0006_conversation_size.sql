-- 長い会話の自動要約に使う記録(仕様: architecture.md「長い会話の自動要約」)

-- Bobertの返答のときに、会話全体を渡した入力のトークン数。会話の量を測るのに使う。
-- 長い返答を分けて投稿したときは、どのメッセージにも同じ値を入れる
CREATE TABLE reply_usage (
	message_id TEXT PRIMARY KEY,
	input_tokens INTEGER NOT NULL,
	created_at INTEGER NOT NULL
);

-- 返信のつながりをさかのぼるときに、要約した位置で止まるため
CREATE INDEX idx_summaries_covered_until ON conversation_summaries (covered_until_message_id);
