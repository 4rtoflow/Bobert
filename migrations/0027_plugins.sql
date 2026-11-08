-- Claude Codeのプラグインを、スキルとは別の機能にする(#108。仕様: behavior.md「プラグイン」、architecture.md「エージェント(Bobert Agent)」)。
-- プラグインを、入れる・更新する・消す単位にする。プラグインはエージェントだけで使う

-- 入れたプラグイン。サーバーの中で、名前ごとに1行
CREATE TABLE plugins (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	guild_id TEXT NOT NULL,
	-- プラグインの名前(一覧の marketplace.json の name)
	name TEXT NOT NULL,
	-- 一覧(マーケットプレイス)のGitHubのリポジトリ(持ち主/名前)
	repository TEXT NOT NULL,
	-- スキルのファイルを読んだコミット(一覧と別のリポジトリから配られていれば、そのリポジトリのコミット)
	commit_sha TEXT NOT NULL,
	-- 入れた人と、そのときにサーバーで見えていた名前
	installed_by_id TEXT NOT NULL,
	installed_by_name TEXT NOT NULL,
	installed_at INTEGER NOT NULL,
	-- 最後に入れ直した(更新した)日時
	updated_at INTEGER NOT NULL,
	UNIQUE (guild_id, name)
);

-- プラグインに入っているスキル。エージェントには「<プラグイン名>:<スキル名>」の名前で渡す
CREATE TABLE plugin_skills (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	plugin_id INTEGER NOT NULL REFERENCES plugins (id) ON DELETE CASCADE,
	name TEXT NOT NULL,
	description TEXT NOT NULL,
	body TEXT NOT NULL,
	UNIQUE (plugin_id, name)
);

-- プラグインのスキルのフォルダの、SKILL.md以外のファイル(スクリプトなど)
CREATE TABLE plugin_files (
	plugin_skill_id INTEGER NOT NULL REFERENCES plugin_skills (id) ON DELETE CASCADE,
	-- スキルのフォルダからの位置(例: scripts/run.mjs)
	path TEXT NOT NULL,
	content BLOB NOT NULL,
	PRIMARY KEY (plugin_skill_id, path)
);

-- /regskills でプラグインから入れたスキル(skills の source_plugin が空でないもの)を、プラグインの表へ移す
INSERT INTO plugins (guild_id, name, repository, commit_sha, installed_by_id, installed_by_name, installed_at, updated_at)
SELECT guild_id, source_plugin, MIN(source_repository), MIN(source_commit), MIN(created_by_id), MIN(created_by_name), MIN(created_at), MAX(updated_at)
FROM skills
WHERE source_plugin IS NOT NULL AND source_plugin <> ''
GROUP BY guild_id, source_plugin;

INSERT INTO plugin_skills (plugin_id, name, description, body)
SELECT plugins.id, skills.name, skills.description, skills.body
FROM skills JOIN plugins ON plugins.guild_id = skills.guild_id AND plugins.name = skills.source_plugin
WHERE skills.source_plugin IS NOT NULL AND skills.source_plugin <> '';

INSERT INTO plugin_files (plugin_skill_id, path, content)
SELECT plugin_skills.id, skill_files.path, skill_files.content
FROM skill_files
JOIN skills ON skills.id = skill_files.skill_id
JOIN plugins ON plugins.guild_id = skills.guild_id AND plugins.name = skills.source_plugin
JOIN plugin_skills ON plugin_skills.plugin_id = plugins.id AND plugin_skills.name = skills.name
WHERE skills.source_plugin IS NOT NULL AND skills.source_plugin <> '';

DELETE FROM skill_files WHERE skill_id IN (
	SELECT id FROM skills WHERE source_plugin IS NOT NULL AND source_plugin <> ''
);
DELETE FROM skills WHERE source_plugin IS NOT NULL AND source_plugin <> '';

-- プラグインは置き換えの確認をしなくなった(更新は /plugins の「更新」で行う)
DROP TABLE pending_plugin_skills;
