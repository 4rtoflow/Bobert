-- AnthropicのAPIキーのうち、ワークスペースに属さないもの(個人キーなど)で使うワークスペースのID
-- (仕様: llm-cost.md「資格情報の登録・保存・削除」)。リクエストのたびに anthropic-workspace-id ヘッダーで送る。
-- 秘密の情報ではないので、暗号化しない。
ALTER TABLE credentials ADD COLUMN workspace_id TEXT;
