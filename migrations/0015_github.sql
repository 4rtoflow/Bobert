-- GitHubとの連携(Bobert Agent、#61)の記録(仕様: architecture.md「エージェント」、llm-cost.md「資格情報の登録・保存・削除」)
-- 時刻はすべてUNIX時間のミリ秒。

-- 本人のGitHubのトークン。Bobert用のGitHub Appで、本人に代わって操作するトークン(ユーザーアクセストークン)と、
-- それを更新するためのトークンを、まとめてAPIキーと同じ鍵で暗号化する(暗号文は本人に結び付ける)
CREATE TABLE github_links (
	user_id TEXT PRIMARY KEY,
	-- 暗号化に使った鍵の番号と、AES-GCMの初期化ベクトルと暗号文(Base64)
	key_version INTEGER NOT NULL,
	iv TEXT NOT NULL,
	ciphertext TEXT NOT NULL,
	-- アクセストークンの有効期限(発行から8時間)。期限のないトークンならNULL
	expires_at INTEGER,
	-- 更新用のトークンの有効期限(発行から6か月)。分からなければNULL
	refresh_expires_at INTEGER,
	-- トークンを入れ替えるたびに1つ増やす。同時に更新したときに、ほかの処理が入れ替えたトークンを上書きしないために使う。
	-- エージェントのセッションに渡したトークンが古くなったかどうかも、これで見分ける
	version INTEGER NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);

-- 連携のリンクの途中の状態。「GitHubと連携」を押したときに入れ、コールバックで使ったら消す(10分で使えなくなる)
CREATE TABLE github_link_states (
	state TEXT PRIMARY KEY,
	-- ボタンを押した人。この人のトークンとして保存する
	user_id TEXT NOT NULL,
	-- ボタンへの返事(本人にだけ見える)のInteractionのトークン(15分有効)。連携できたら、この返事を書き換えて知らせる。
	-- 15分で使えなくなり、行も使ったら消すので、暗号化しない
	interaction_token TEXT NOT NULL,
	-- authorize: リンクの先の、承認の画面から戻るのを待っている。
	-- install: 承認したが、まだアプリを入れていなかったので、アプリを入れる画面(触らせるリポジトリを選ぶ画面)へ進めた
	stage TEXT NOT NULL CHECK (stage IN ('authorize', 'install')),
	-- 承認の画面のPKCEのcode_verifier。アプリを入れる画面からの戻りでは、GitHubがPKCEを使わないのでNULL
	code_verifier TEXT,
	expires_at INTEGER NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE INDEX github_link_states_user ON github_link_states (user_id);
