-- Bobert.md(サーバーの全員への返答で、AIに毎回渡す、サーバーの情報や指示。#87)
-- 仕様: behavior.md「Bobert.md」

-- サーバーごとに1行。誰でも編集できるので、最後に編集した人を残す
CREATE TABLE bobert_md (
	guild_id TEXT PRIMARY KEY,
	-- 中身(4000文字まで)。空にして送ったら空の文字列にする(誰が消したかを残すため、行は消さない)
	content TEXT NOT NULL,
	-- 最後に編集した人と、そのときにサーバーで見えていた名前
	edited_by_id TEXT NOT NULL,
	edited_by_name TEXT NOT NULL,
	-- 最後に編集した日時。編集の画面を開いた後に、ほかの人が変えていないかを確かめるのにも使う
	updated_at INTEGER NOT NULL
);
