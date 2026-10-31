-- メッセージに付いたリアクション。誰がどの絵文字を付けたか(仕様: architecture.md「リアクション」)
-- 記録するのは、メッセージを保存しているチャンネル(共有チャンネル)のものだけ
CREATE TABLE message_reactions (
	message_id TEXT NOT NULL,
	channel_id TEXT NOT NULL,
	-- 絵文字。Unicodeの絵文字はその文字、カスタム絵文字は「名前:ID」。全部外した印は「*」
	emoji TEXT NOT NULL,
	-- 付けた人。全部外した印と、絵文字ごとに外した印は「*」
	user_id TEXT NOT NULL,
	-- スーパーリアクションか。ふつうのリアクションとは別に付け外しされる
	burst INTEGER NOT NULL DEFAULT 0,
	-- 付いている(1)か、外した(0)か。外したものと印は、古い通知で付け直さないよう、1日だけ残す
	present INTEGER NOT NULL,
	-- この状態の通知を受け取った時刻。古い通知で上書きしないため。付いているものは、付けた順に並べるのにも使う
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (message_id, emoji, user_id, burst)
);
CREATE INDEX idx_message_reactions_channel ON message_reactions (channel_id);
CREATE INDEX idx_message_reactions_removed ON message_reactions (present, updated_at);
