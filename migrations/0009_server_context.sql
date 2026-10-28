-- サーバー全体の公開チャンネル(仕様: architecture.md「サーバー全体の公開チャンネル」)

-- サーバーごとの@everyoneの権限(ロールのIDはサーバーのIDと同じ)。チャンネルが公開かどうかの計算に使う
CREATE TABLE guild_everyone (
	guild_id TEXT PRIMARY KEY,
	-- 権限のビット(10進数の文字列)
	permissions TEXT NOT NULL,
	-- この情報を受け取った時刻。古い通知で上書きしないため
	synced_at INTEGER NOT NULL
);

-- サーバーのチャンネルとスレッド。公開チャンネルのメッセージだけを保存し、AIが読めるようにするため
CREATE TABLE channels (
	channel_id TEXT PRIMARY KEY,
	guild_id TEXT NOT NULL,
	-- スレッドなら、親のチャンネル。スレッドでなければNULL
	parent_id TEXT,
	-- Discordのチャンネルの種類
	type INTEGER NOT NULL,
	name TEXT NOT NULL,
	-- 年齢制限のチャンネルか。スレッドは親に従う
	nsfw INTEGER NOT NULL DEFAULT 0,
	-- @everyoneへの上書きの、許可と拒否のビット(10進数の文字列)。上書きがなければNULL
	everyone_allow TEXT,
	everyone_deny TEXT,
	-- 公開チャンネル(@everyoneが見られて、年齢制限がない)か。スレッドは、公開スレッドで親が公開なら公開
	public INTEGER NOT NULL DEFAULT 0,
	-- この情報を受け取った時刻。古い通知で上書きしないため
	synced_at INTEGER NOT NULL
);
CREATE INDEX idx_channels_guild ON channels (guild_id, public);
CREATE INDEX idx_channels_parent ON channels (parent_id);

-- 過去ログの取り込みに、サーバーと、/importの回と、その回で取り込んだ件数を足す
ALTER TABLE channel_imports ADD COLUMN guild_id TEXT;
ALTER TABLE channel_imports ADD COLUMN run_id TEXT;
ALTER TABLE channel_imports ADD COLUMN imported_count INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_channel_imports_run ON channel_imports (run_id);

-- /importの回。進み具合の表示に使う
CREATE TABLE import_runs (
	run_id TEXT PRIMARY KEY,
	guild_id TEXT NOT NULL,
	-- 取り込む件数の見積もり(メッセージ検索のAPIの件数)。取れなければNULL
	estimated_total INTEGER,
	started_at INTEGER NOT NULL,
	finished_at INTEGER
);
CREATE INDEX idx_import_runs_guild ON import_runs (guild_id, started_at);

-- サーバー全体で、発言者を名前から探すため(意味で検索の、発言者の指定)
CREATE INDEX idx_messages_guild_author ON messages (guild_id, author_name COLLATE NOCASE);
