-- Claude Codeのプラグインから入れたスキル(仕様: behavior.md「スキル」、architecture.md「エージェント(Bobert Agent)」)

-- 入手元。/regskills の plugin と marketplace で入れたスキルにだけ入れる(手で登録したスキルはNULL)。
-- 同じ名前で入れ直すと、新しい入手元に書き換える
ALTER TABLE skills ADD COLUMN source_repository TEXT;
ALTER TABLE skills ADD COLUMN source_plugin TEXT;
ALTER TABLE skills ADD COLUMN source_commit TEXT;

-- スキルに付いたファイル(スクリプトなど)。SKILL.mdと同じフォルダの、SKILL.md以外のファイル。
-- ファイルが付いたスキルは、エージェントだけで使い、読まれたときにサンドボックスに置く。
-- プラグインから入れ直したときだけ書き換える(編集やファイルでの置き換えでは変えない)
CREATE TABLE skill_files (
	skill_id INTEGER NOT NULL REFERENCES skills (id) ON DELETE CASCADE,
	-- スキルのフォルダからの位置(例: scripts/nakamaba.mjs)
	path TEXT NOT NULL,
	content BLOB NOT NULL,
	PRIMARY KEY (skill_id, path)
);

-- /regskills でプラグインから入れるときに、同じ名前のスキルがあって、置き換えるかを確かめている間の入手元。
-- 置き換えるときは、同じコミットを読み直す。pending_skills と合わせて、人ごと・サーバーごとに1つだけ残す
CREATE TABLE pending_plugin_skills (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	guild_id TEXT NOT NULL,
	-- 入れようとした人。置き換えのボタンは、この人しか押せない
	user_id TEXT NOT NULL,
	repository TEXT NOT NULL,
	plugin TEXT NOT NULL,
	commit_sha TEXT NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE INDEX idx_pending_plugin_skills_user ON pending_plugin_skills (guild_id, user_id);
