-- 「GitHubと連携」を押した場面(仕様: architecture.md「エージェント(Bobert Agent)」の「GitHub」)
-- agent: /agent の返事から。連携できたら、同じメッセージを、リポジトリを選ぶセレクトメニューに書き換える
-- link: エージェントのチャンネルでの知らせなどから。連携できたら、「GitHubと連携しました。」とだけ書く
ALTER TABLE github_link_states ADD COLUMN purpose TEXT NOT NULL DEFAULT 'link' CHECK (purpose IN ('link', 'agent'));
