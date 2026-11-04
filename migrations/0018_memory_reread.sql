-- 記憶の最初の一覧で、保存しているすべての発言を、いちばん古いものから読むようにした(それまでは、新しい方から5,000件だけを読んでいた)
-- 仕様: architecture.md「記憶」

-- すでに一覧を作った人も、いちばん古い発言から読み直す。今の一覧(本人が書いた項目を含む)は残し、読み直した発言で足したり直したりする。
-- 読み直しは、次にBobertが返答した後に始まる(OFFの人は、ONに戻したとき)。すぐに始まるよう、更新の記録も消す
UPDATE memory_settings
SET read_until = NULL, updated_at = NULL, attempted_at = NULL
WHERE read_until IS NOT NULL;
