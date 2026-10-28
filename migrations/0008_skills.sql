-- サーバー共通のスキル(仕様: behavior.md「スキル」)

-- スキル。サーバーの中で、名前ごとに1行。誰でも登録・編集・削除できる
CREATE TABLE skills (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	guild_id TEXT NOT NULL,
	-- 英小文字、数字、ハイフンで64文字まで(Agent Skillsの規則)
	name TEXT NOT NULL,
	description TEXT NOT NULL,
	body TEXT NOT NULL,
	-- 登録した人と、そのときにサーバーで見えていた名前
	created_by_id TEXT NOT NULL,
	created_by_name TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	-- 最後に編集した人と、そのときにサーバーで見えていた名前。編集されていなければNULL
	edited_by_id TEXT,
	edited_by_name TEXT,
	-- 最後に登録か編集をした日時。編集の画面を開いた後に、ほかの人が変えていないかを確かめるのにも使う
	updated_at INTEGER NOT NULL,
	UNIQUE (guild_id, name)
);
