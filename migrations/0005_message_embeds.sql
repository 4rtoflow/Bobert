-- Embedの中身と、コマンドへの返答の情報を保存する(仕様: architecture.md「会話の文脈と過去の発言の保存」)

-- Embedの中身(JSON)。タイトル、説明、項目など、文字の部分だけ
ALTER TABLE messages ADD COLUMN embeds TEXT;
-- コマンドへの返答なら、どのコマンドを誰が使ったか(JSON)
ALTER TABLE messages ADD COLUMN command TEXT;
