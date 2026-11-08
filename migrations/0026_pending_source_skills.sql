-- /skills の source(npx skills add と同じ指定)で入れるときに、スキルを選んでもらっている間か、
-- 同じ名前のスキルを置き換えるかを確かめている間の入手元(#107。仕様: behavior.md「スキル」)。
-- 選んだ後や置き換えるときは、同じコミットを読み直す。pending_skills、pending_plugin_skills と合わせて、人ごと・サーバーごとに1つだけ残す
CREATE TABLE pending_source_skills (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	guild_id TEXT NOT NULL,
	-- 入れようとした人。選ぶメニューと置き換えのボタンは、この人しか使えない
	user_id TEXT NOT NULL,
	-- リポジトリ(持ち主/名前)
	repository TEXT NOT NULL,
	-- 探すフォルダ(根なら空)
	path TEXT NOT NULL,
	commit_sha TEXT NOT NULL,
	-- 置き換えるかを確かめているスキルの名前。選んでもらっている間はNULL
	skill_name TEXT,
	created_at INTEGER NOT NULL
);
CREATE INDEX idx_pending_source_skills_user ON pending_source_skills (guild_id, user_id);
