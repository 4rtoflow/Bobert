-- Bobertの最初のスキーマ(D1)。仕様: docs/spec/ 以下
-- 時刻はすべてUNIX時間のミリ秒。

-- ユーザーごとの設定(仕様: llm-cost.md「ユーザーごとの設定」、behavior.md)
CREATE TABLE users (
	user_id TEXT PRIMARY KEY,
	-- NULLなら既定のモデル
	model_key TEXT,
	-- その他で入力されたモデルID(model_key が 'custom' のとき)
	custom_model_id TEXT,
	-- NULLならモデルの既定の思考の深さ
	effort TEXT,
	-- /prompt で設定した自分用の指示
	custom_prompt TEXT,
	feat_web_search INTEGER NOT NULL DEFAULT 0,
	feat_usage_display INTEGER NOT NULL DEFAULT 0,
	feat_image_input INTEGER NOT NULL DEFAULT 1,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);

-- 登録された資格情報。暗号化して保存する(仕様: llm-cost.md「資格情報の登録・保存・削除」)
CREATE TABLE credentials (
	user_id TEXT NOT NULL,
	provider TEXT NOT NULL CHECK (provider IN ('anthropic', 'openrouter')),
	-- 暗号化に使った鍵の番号(鍵の入れ替えのため)
	key_version INTEGER NOT NULL,
	-- AES-GCMの初期化ベクトルと暗号文(Base64)
	iv TEXT NOT NULL,
	ciphertext TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (user_id, provider)
);

-- 保存したメッセージ。リアルタイムで受け取った分も、取り込んだ過去ログも入れる
-- (仕様: architecture.md「会話の文脈と過去の発言の保存」)
CREATE TABLE messages (
	message_id TEXT PRIMARY KEY,
	guild_id TEXT,
	channel_id TEXT NOT NULL,
	author_id TEXT NOT NULL,
	author_name TEXT NOT NULL,
	author_is_bot INTEGER NOT NULL DEFAULT 0,
	content TEXT NOT NULL,
	reply_to_id TEXT,
	-- 添付画像の情報(JSON)
	attachments TEXT,
	created_at INTEGER NOT NULL,
	edited_at INTEGER,
	-- Vectorizeに入れた時刻。NULLならまだ
	embedded_at INTEGER
);
CREATE INDEX idx_messages_channel_created ON messages (channel_id, created_at);
CREATE INDEX idx_messages_reply_to ON messages (reply_to_id);

-- 応答済みのメッセージ。同じメッセージに2回返信しないため
CREATE TABLE handled_messages (
	message_id TEXT PRIMARY KEY,
	handled_at INTEGER NOT NULL
);

-- 「Bobertに聞く」の返答と、説明の対象のメッセージの対応
CREATE TABLE explain_targets (
	response_message_id TEXT PRIMARY KEY,
	target_message_id TEXT NOT NULL,
	created_at INTEGER NOT NULL
);

-- 長い会話の要約(仕様: architecture.md「長い会話の自動要約」)
CREATE TABLE conversation_summaries (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	-- 会話の起点のメッセージ
	root_message_id TEXT NOT NULL,
	-- このメッセージまでを要約した
	covered_until_message_id TEXT NOT NULL,
	summary TEXT NOT NULL,
	model_key TEXT NOT NULL,
	-- 要約の費用を払った人
	created_by_user_id TEXT NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE INDEX idx_summaries_root ON conversation_summaries (root_message_id, created_at);

-- 要約を勧める案内を出した記録(会話、人、モデルごとに1回)
CREATE TABLE compaction_notices (
	root_message_id TEXT NOT NULL,
	user_id TEXT NOT NULL,
	model_key TEXT NOT NULL,
	notified_at INTEGER NOT NULL,
	PRIMARY KEY (root_message_id, user_id, model_key)
);

-- チャンネルごとの過去ログの取り込みの進み具合(仕様: architecture.md「過去ログの取り込み」)
CREATE TABLE channel_imports (
	channel_id TEXT PRIMARY KEY,
	status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'done', 'failed')),
	-- ここより古い方へたどる
	oldest_imported_message_id TEXT,
	started_at INTEGER,
	finished_at INTEGER,
	updated_at INTEGER NOT NULL
);
