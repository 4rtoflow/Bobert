-- /regskills で、同じ名前のスキルがあったときに、置き換えるかを確かめている間の内容(仕様: behavior.md「スキル」)。
-- 人ごと・サーバーごとに1つだけ残し、置き換えたときか、同じ人が次に確かめるときに消す
CREATE TABLE pending_skills (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	guild_id TEXT NOT NULL,
	-- 登録しようとした人。置き換えのボタンは、この人しか押せない
	user_id TEXT NOT NULL,
	name TEXT NOT NULL,
	description TEXT NOT NULL,
	body TEXT NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE INDEX idx_pending_skills_user ON pending_skills (guild_id, user_id);
