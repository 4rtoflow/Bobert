-- 記憶(本人の発言から、AIがその人について覚えておくことをまとめ、返答に使う。#70)
-- 仕様: architecture.md「記憶」、behavior.md「記憶」

-- 人とサーバーごとの、記憶の設定と、更新の記録
CREATE TABLE memory_settings (
	user_id TEXT NOT NULL,
	guild_id TEXT NOT NULL,
	-- 記憶を使うか(/memory で切り替える)
	enabled INTEGER NOT NULL,
	-- この時刻までの発言を、記憶に読み込んだ(発言の時刻、UNIX時間のミリ秒)。NULLなら、まだ最初の一覧を作っていない
	read_until INTEGER,
	-- 最後に更新を始めた時刻。同じ人の更新を重ねないためと、失敗したときに1時間あけるために使う
	attempted_at INTEGER,
	-- 最後に更新し終えた時刻。1日1回までにするために使う
	updated_at INTEGER,
	-- 最後の更新に失敗した理由(返答のエラーと同じ文)。成功したらNULL
	failure TEXT,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (user_id, guild_id)
);

-- 記憶の項目(1つ100文字まで、人とサーバーごとに合わせて1500文字まで)
CREATE TABLE memory_items (
	-- 保存するときに作るID(UUID)。項目ともとの発言を、1回のまとめた書き込みで入れるため
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	guild_id TEXT NOT NULL,
	-- 並び順(小さい方から)
	position INTEGER NOT NULL,
	text TEXT NOT NULL,
	-- 本人が書いた項目(/memory で直したものと、会話で頼まれたもの)。まとめ直しでは変えず、もとの発言が消されても消さない
	user_written INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE INDEX idx_memory_items_owner ON memory_items (user_id, guild_id, position);

-- 項目のもとになった発言。もとの発言がすべて消されたら、項目も消す(本人が書いた項目は除く)
CREATE TABLE memory_item_sources (
	item_id TEXT NOT NULL,
	message_id TEXT NOT NULL,
	PRIMARY KEY (item_id, message_id)
);
CREATE INDEX idx_memory_item_sources_message ON memory_item_sources (message_id);

-- 本人の発言を、サーバーと時刻で読むため(記憶の更新)
CREATE INDEX idx_messages_guild_author_created ON messages (guild_id, author_id, created_at);
