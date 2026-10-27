-- クレジットの寄付(仕様: llm-cost.md「クレジットの寄付」)

-- 寄付。サーバーと、寄付した人ごとに1行。金額は、100万分の1ドルを単位にした整数
CREATE TABLE donations (
	guild_id TEXT NOT NULL,
	donor_id TEXT NOT NULL,
	-- 寄付した人の、サーバーで見えている名前(最後に寄付したときのもの)
	donor_name TEXT NOT NULL,
	-- 寄付の残り。使い切る直前の返答の分だけ、負になることがある
	remaining_micros INTEGER NOT NULL,
	-- 寄付した日時。寄付は古い順に使う。寄付をやめてから寄付し直したら、そのときの日時にする
	donated_at INTEGER NOT NULL,
	-- 寄付をやめた日時(サーバーを抜けたときを含む)。NULLなら寄付している
	ended_at INTEGER,
	-- キーが無効か残高不足で、この日時まで使わない
	paused_until INTEGER,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (guild_id, donor_id)
);

-- /delete で、その人の寄付を消すため
CREATE INDEX idx_donations_donor ON donations (donor_id);
