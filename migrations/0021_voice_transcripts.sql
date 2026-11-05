-- 音声メッセージを文字にした内容(仕様: docs/spec/architecture.md「音声メッセージ」)。
-- 音声メッセージは添付ファイルが1つだけなので、メッセージIDで見分ける。
-- 年齢制限のチャンネルと非公開スレッドの分も入れるが、検索には出さず、そのメッセージを読むときにだけ使う(会話の要約と同じ)。
-- メッセージが消されたら、一緒に消す
CREATE TABLE voice_transcripts (
	message_id TEXT PRIMARY KEY,
	channel_id TEXT NOT NULL,
	-- 文字にした内容。声が入っていなければ空
	text TEXT NOT NULL,
	-- 判定された言語(例: ja)。分からなければNULL
	language TEXT,
	-- 音声の長さ(秒)
	duration_secs REAL NOT NULL,
	-- 文字にしたモデル
	model TEXT NOT NULL,
	created_at INTEGER NOT NULL
);

-- チャンネルが消されたときや、共有しなくなったときに、まとめて消すため
CREATE INDEX voice_transcripts_channel ON voice_transcripts (channel_id);
