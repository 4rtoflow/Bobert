-- エージェントに渡す秘密(#99。仕様: architecture.md「エージェント(Bobert Agent)」)。
-- 利用者ごとに、本人のAnthropicのアカウントに作ったvault(秘密を預ける場所)。
-- 秘密の値はvaultにだけ置き、Bobertは保存しない(名前と送り先も、そのつどvaultから読む)
CREATE TABLE agent_vaults (
	user_id TEXT PRIMARY KEY,
	vault_id TEXT NOT NULL,
	created_at INTEGER NOT NULL
);
