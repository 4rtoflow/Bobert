-- OpenRouterとの連携(OAuth PKCE)の途中の状態(仕様: llm-cost.md「資格情報の登録・保存・削除」)
-- /setup で連携のリンクを作るときに入れ、コールバックで使ったら消す。
CREATE TABLE oauth_states (
	state TEXT PRIMARY KEY,
	-- /setup を実行した人。この人のキーとして保存する
	user_id TEXT NOT NULL,
	code_verifier TEXT NOT NULL,
	-- この時刻を過ぎたら使えない
	expires_at INTEGER NOT NULL,
	created_at INTEGER NOT NULL
);
