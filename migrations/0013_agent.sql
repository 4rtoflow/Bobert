-- エージェント(Bobert Agent、#61)の記録(仕様: architecture.md「エージェント」)

-- 利用者ごとに、本人のAnthropicのアカウントに作った、Managed Agentsのエージェントの設定と環境。
-- 中身(モデル、指示、道具)は、セッションを始めるときに、そのセッションだけの設定として渡す
CREATE TABLE agent_users (
	user_id TEXT PRIMARY KEY,
	agent_id TEXT NOT NULL,
	environment_id TEXT NOT NULL,
	created_at INTEGER NOT NULL
);

-- エージェントのチャンネル。セッションを終えても、チャンネルを消すまで残す(保存しない扱いと、本人以外の発言を消すことを続けるため)
CREATE TABLE agent_channels (
	channel_id TEXT PRIMARY KEY,
	guild_id TEXT NOT NULL,
	owner_id TEXT NOT NULL,
	-- その人がそのサーバーで作った順の番号。チャンネルの名前に使う
	number INTEGER NOT NULL,
	-- Managed Agentsのセッション。終えたらNULL
	session_id TEXT,
	-- チャンネルの最初のメッセージ(終えるボタンを付けたもの)
	first_message_id TEXT,
	created_at INTEGER NOT NULL,
	ended_at INTEGER
);
CREATE INDEX agent_channels_owner ON agent_channels (owner_id, guild_id);
CREATE INDEX agent_channels_guild ON agent_channels (guild_id);

-- 人ごと・サーバーごとの、最後に使ったチャンネルの番号。消したチャンネルの番号は使い直さない
CREATE TABLE agent_counters (
	guild_id TEXT NOT NULL,
	user_id TEXT NOT NULL,
	last_number INTEGER NOT NULL,
	PRIMARY KEY (guild_id, user_id)
);
