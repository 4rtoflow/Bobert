-- TypeSafeのAPIキー(右クリックメニューの「Jevに聞く」で使う)。暗号化して保存する
-- (仕様: llm-cost.md「資格情報の登録・保存・削除」)。
-- AIのキー(credentials)とは別の表にする。credentialsのproviderの制約(CHECK)を変えるには、表を作り直す必要があり、
-- 本番のキーを移し替えることになるため。TypeSafeのキーは、AIの呼び出しにも寄付にも使わない。
CREATE TABLE typesafe_credentials (
	user_id TEXT PRIMARY KEY,
	-- 暗号化に使った鍵の番号(鍵の入れ替えのため)
	key_version INTEGER NOT NULL,
	-- AES-GCMの初期化ベクトルと暗号文(Base64)
	iv TEXT NOT NULL,
	ciphertext TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
