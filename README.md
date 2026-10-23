# Bobert

Discord上でAIと会話できるBot。Botへのメンションや返信で話しかけると、AIが答える。LLMの費用は、各ユーザーが自分のキー(AnthropicのAPIキー、またはOpenRouter)で負担する。

## 仕様

| 文書                                                   | 内容                                                                    |
| ------------------------------------------------------ | ----------------------------------------------------------------------- |
| [docs/spec/llm-cost.md](docs/spec/llm-cost.md)         | LLMの費用の負担、資格情報の登録と保存、モデルの候補                     |
| [docs/spec/architecture.md](docs/spec/architecture.md) | Cloudflareでの構成、Gateway接続処理の設計、会話の文脈と過去の発言の保存 |
| [docs/spec/behavior.md](docs/spec/behavior.md)         | 公開範囲、AIの性格、返答の出し方、スラッシュコマンド                    |
| [docs/setup.md](docs/setup.md)                         | 開発に必要なアカウントと環境の準備                                      |

## 構成

Cloudflare Workers上で動く。1つのWorkerプロジェクトに、次のものをまとめている。

| ファイル                   | 役割                                                                  |
| -------------------------- | --------------------------------------------------------------------- |
| `src/index.ts`             | エントリポイント(HTTPの受付とQueueの処理)                             |
| `src/gateway/`             | Discord Gatewayへの常時接続を持つDurable Object(自作の接続処理)       |
| `src/interactions/`        | スラッシュコマンドなどのInteractionsの受け口と、署名の確認            |
| `src/oauth/`               | OpenRouterのOAuthのコールバック                                       |
| `src/queue/`               | Queueで受け渡す仕事(応答の生成、メッセージの保存、過去ログの取り込み) |
| `src/config/models.ts`     | `/model`で選べるモデルの候補                                          |
| `src/discord/constants.ts` | Discord APIの定数                                                     |
| `migrations/`              | D1のスキーマ                                                          |
| `test/`                    | テスト(Workersの実行環境で動かす)                                     |

## 必要なもの

- Node.js 24以上
- pnpm(`package.json`の`packageManager`に書いたバージョン。`npm install -g pnpm`で入れる)
- Cloudflareのアカウント(Workersの有料プラン)と、DiscordのBotアプリ(準備は[docs/setup.md](docs/setup.md))

## 手元で動かす

```sh
pnpm install
cp .env.example .env    # 値を入れる(Gitには入れない)
pnpm exec wrangler login
pnpm db:migrate:local   # 手元のD1にスキーマを作る
pnpm dev
```

VectorizeとWorkers AIは手元で再現できないため、`pnpm dev`でもCloudflare上の開発用リソースにつなぐ。先に下の「Cloudflareのリソースを作る」を済ませておく。

## Cloudflareのリソースを作る

開発用の例。本番用は名前の`-dev`を外し、`wrangler.jsonc`の`env.production`に合わせる。

```sh
# D1(表示されたIDを wrangler.jsonc の database_id に入れる)。
# 北米東部(enam)に置く。指定しないと作成した場所(日本ならアジア太平洋)の近くになる
pnpm exec wrangler d1 create bobert-dev --location=enam

# Queues
pnpm exec wrangler queues create bobert-respond-dev
pnpm exec wrangler queues create bobert-ingest-dev

# Vectorize(bge-m3は1024次元)。絞り込み用のメタデータ索引は、最初のデータを入れる前に作る
pnpm exec wrangler vectorize create bobert-messages-dev --dimensions=1024 --metric=cosine
pnpm exec wrangler vectorize create-metadata-index bobert-messages-dev --propertyName=author_id --type=string
pnpm exec wrangler vectorize create-metadata-index bobert-messages-dev --propertyName=created_at --type=number

# シークレット(.env.example にある名前をすべて設定する)
pnpm exec wrangler secret put DISCORD_BOT_TOKEN --env=""

# D1にスキーマを作る
pnpm db:migrate:dev
```

## よく使うコマンド

| コマンド                 | 内容                                                     |
| ------------------------ | -------------------------------------------------------- |
| `pnpm dev`               | 手元で起動する                                           |
| `pnpm test`              | テストを実行する                                         |
| `pnpm lint`              | リントと整形のチェック                                   |
| `pnpm format`            | 整形して、直せるものを直す                               |
| `pnpm typecheck`         | 型チェック                                               |
| `pnpm cf-typegen`        | `wrangler.jsonc`から型を作り直す(設定を変えたら実行する) |
| `pnpm deploy:dev`        | 開発用の環境にデプロイする                               |
| `pnpm deploy:production` | 本番用の環境にデプロイする                               |
