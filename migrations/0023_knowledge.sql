-- 知識チャンネル(送られたファイルを、AIが要約して覚え、返答で読めるチャンネル。#96)
-- 仕様: behavior.md「知識チャンネル」、architecture.md「知識チャンネル」
-- 番号は、先に出ているPR(#100)の0022を避けて、0023にした

-- 知識チャンネル。サーバー管理者が /knowledge で指定する(1つのサーバーに、いくつでも)。
-- スレッドとフォーラムの投稿は指定できず、親のチャンネルに従う
CREATE TABLE knowledge_channels (
	channel_id TEXT PRIMARY KEY,
	guild_id TEXT NOT NULL,
	-- 指定した人
	designated_by TEXT NOT NULL,
	-- 指定した日時(UNIX時間のミリ秒)。これより後に送られたファイルだけを、知識に加える
	designated_at INTEGER NOT NULL
);
CREATE INDEX idx_knowledge_channels_guild ON knowledge_channels (guild_id);

-- 知識のファイル(知識チャンネルに送られた添付ファイル。1つの添付ファイルに1行)。
-- 知識に加えなかったファイルも、同じ添付ファイルで二度知らせないよう、状態をrejectedにして残す
CREATE TABLE knowledge_files (
	-- AIに見せるID(k12の12)
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	guild_id TEXT NOT NULL,
	-- 指定された知識チャンネル(スレッドの中のファイルなら、親のチャンネル)
	knowledge_channel_id TEXT NOT NULL,
	-- ファイルのメッセージがあるチャンネル(スレッドの中なら、スレッド)
	channel_id TEXT NOT NULL,
	message_id TEXT NOT NULL,
	-- 添付ファイルのID(DiscordのURLにある、添付ファイルのID)
	attachment_id TEXT NOT NULL,
	filename TEXT NOT NULL,
	-- 形式(pdf、docx、xlsx、xls、csv、text)
	format TEXT NOT NULL,
	-- 大きさ(バイト)
	size INTEGER NOT NULL,
	-- 送った人と、そのときにサーバーで見えていた名前
	author_id TEXT NOT NULL,
	author_name TEXT NOT NULL,
	-- 送った日時(メッセージの投稿時刻)
	posted_at INTEGER NOT NULL,
	-- 状態。pending(受け付けた)、converted(文字にした。要約を待つ)、ready(知識に入った)、rejected(知識に加えなかった)
	state TEXT NOT NULL,
	-- 知識に加えなかった理由(no_key、too_large、unreadable、summary_failed、retry_failed)
	rejected_reason TEXT,
	-- 文字にした内容の長さ(UTF-16の長さ)。文字にするまではNULL
	text_length INTEGER,
	-- 要約(200文字まで)。要約するまではNULL
	summary TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	UNIQUE (message_id, attachment_id)
);
-- AIに渡す一覧(新しい順)を読むため
CREATE INDEX idx_knowledge_files_guild ON knowledge_files (guild_id, state, posted_at);
-- チャンネルが消されたときや、共有しなくなったときに、まとめて消すため
CREATE INDEX idx_knowledge_files_channel ON knowledge_files (channel_id);
-- 知識チャンネルを解除したときに、まとめて消すため
CREATE INDEX idx_knowledge_files_knowledge_channel ON knowledge_files (knowledge_channel_id);

-- 文字にした内容。D1の上限(1行2MB、1つのSQL文100KB)に収めるため、区切って入れる
CREATE TABLE knowledge_texts (
	file_id INTEGER NOT NULL,
	-- 区切りの番号(0から)
	part INTEGER NOT NULL,
	-- この区切りが、全体のどこからどこまでか(start_offsetの文字から、end_offsetの文字の手前まで)。
	-- 読む道具が、文字数(UTF-16の長さ)で位置を指定するため、同じ数え方で入れる(SQLのlength()は数え方が違う)
	start_offset INTEGER NOT NULL,
	end_offset INTEGER NOT NULL,
	text TEXT NOT NULL,
	PRIMARY KEY (file_id, part)
);
