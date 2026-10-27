-- メッセージの保存で、会話の組み立てに要る情報を足す
-- (仕様: architecture.md「会話の文脈と過去の発言の保存」)

-- メンションされた人のIDと名前(JSON)。本文のメンションを名前に置き換えるのに使う
ALTER TABLE messages ADD COLUMN mentions TEXT;

-- サーバーで見えている名前(ニックネーム、なければ表示名、それもなければユーザー名)。人ごとに、最後に分かったもの。
-- 分かるのは、Gatewayで届いたメッセージの発言者と、メンションされた人だけ。
-- Discordから読み直したメッセージには、ニックネームが含まれないため。
CREATE TABLE guild_members (
	guild_id TEXT NOT NULL,
	user_id TEXT NOT NULL,
	name TEXT NOT NULL,
	-- この名前が分かったメッセージの時刻
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (guild_id, user_id)
);

-- 削除されたメッセージのID。削除が保存より先に処理されても(やり直しで順番が入れ替わる)、保存し直さないため。
-- やり直しの間だけ要るので、1日たったら消す。
CREATE TABLE deleted_messages (
	message_id TEXT PRIMARY KEY,
	deleted_at INTEGER NOT NULL
);
