-- AIが読むチャンネルと/importの対象を、Botが見られるチャンネル全体に広げる(仕様: architecture.md「サーバー全体の共有チャンネル」)

-- サーバーのロールの権限。Botがチャンネルを見られるかの計算に使う(@everyoneのロールのIDは、サーバーのIDと同じ)
CREATE TABLE guild_roles (
	guild_id TEXT NOT NULL,
	role_id TEXT NOT NULL,
	-- 権限のビット(10進数の文字列)
	permissions TEXT NOT NULL,
	-- この情報を受け取った時刻。古い通知で上書きしないため
	synced_at INTEGER NOT NULL,
	PRIMARY KEY (guild_id, role_id)
);
INSERT INTO guild_roles (guild_id, role_id, permissions, synced_at)
	SELECT guild_id, guild_id, permissions, synced_at FROM guild_everyone;
DROP TABLE guild_everyone;

-- サーバーごとの、Botが持つロール
CREATE TABLE bot_members (
	guild_id TEXT PRIMARY KEY,
	-- ロールのIDの配列(JSON)。@everyoneは含まない
	role_ids TEXT NOT NULL,
	-- この情報を受け取った時刻。古い通知で上書きしないため
	synced_at INTEGER NOT NULL
);

-- チャンネルの権限の上書きを、@everyoneへの分だけでなく、全部記録する(JSONの配列)。
-- 今の@everyoneへの上書きは、そのまま移す。ほかの上書きは、Gatewayを始め直したときのサーバーの情報で記録し直す
ALTER TABLE channels ADD COLUMN overwrites TEXT NOT NULL DEFAULT '[]';
UPDATE channels SET overwrites = json_array(json_object(
	'id', guild_id,
	'type', 0,
	'allow', coalesce(everyone_allow, '0'),
	'deny', coalesce(everyone_deny, '0')
)) WHERE everyone_allow IS NOT NULL OR everyone_deny IS NOT NULL;
ALTER TABLE channels DROP COLUMN everyone_allow;
ALTER TABLE channels DROP COLUMN everyone_deny;

-- 公開チャンネル(@everyoneが見られる)の印を、共有チャンネル(Botが見られて、年齢制限がない)の印に変える。
-- 値は、Botのロールが分かったときに決め直す
ALTER TABLE channels RENAME COLUMN public TO shared;
