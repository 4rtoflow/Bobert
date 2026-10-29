-- /setup のInteractionのトークン。OpenRouterとの連携が済んだことを、/setup への追加の返信で本人に知らせるのに使う
-- (仕様: llm-cost.md「資格情報の登録・保存・削除」)。トークンは15分で使えなくなり、行も使ったら消すので、
-- code_verifierと同じく暗号化しない。この列を足す前に作った行では空(NULL)になり、そのときは知らせない。
ALTER TABLE oauth_states ADD COLUMN interaction_token TEXT;
