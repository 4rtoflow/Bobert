# Bobert

Discord上でAIと会話できるBot。Botへのメンションや返信で話しかけると、AIが答える。LLMの費用は、各ユーザーが自分のキー(AnthropicのAPIキー、またはOpenRouter)で負担する。サーバーの全員が使えるクレジットを、寄付することもできる。

## 仕様

| 文書                                                   | 内容                                                                    |
| ------------------------------------------------------ | ----------------------------------------------------------------------- |
| [docs/spec/llm-cost.md](docs/spec/llm-cost.md)         | LLMの費用の負担、資格情報の登録と保存、モデルの候補、クレジットの寄付   |
| [docs/spec/architecture.md](docs/spec/architecture.md) | Cloudflareでの構成、Gateway接続処理の設計、会話の文脈と過去の発言の保存 |
| [docs/spec/behavior.md](docs/spec/behavior.md)         | 公開範囲、AIの性格、返答の出し方、スラッシュコマンド                    |
| [docs/setup.md](docs/setup.md)                         | 開発に必要なアカウントと環境の準備                                      |

## 構成

Cloudflare Workers上で動く。1つのWorkerプロジェクトに、次のものをまとめている。

| ファイル               | 役割                                                                                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`         | エントリポイント(HTTPの受付とQueueの処理)                                                                                                                           |
| `src/admin.ts`         | 管理用エンドポイント(Gatewayの起動、停止、状態確認、コマンドの登録)                                                                                                 |
| `src/alert.ts`         | 開発者用のDiscordチャンネルへの障害の通知                                                                                                                           |
| `src/gateway/`         | Discord Gatewayへの常時接続を持つDurable Object(自作の接続処理)                                                                                                     |
| `src/import/`          | `/import`(Botが見られるチャンネルの過去ログの取り込みの始め方と、進み具合を見張るDurable Object)                                                                    |
| `src/interactions/`    | スラッシュコマンドなどのInteractionsの受け口と、署名の確認                                                                                                          |
| `src/oauth/`           | OpenRouterとの連携(OAuth PKCE)のリンクとコールバック                                                                                                                |
| `src/queue/`           | Queueで受け渡す仕事(応答の生成、メッセージの保存、過去ログの取り込み)                                                                                               |
| `src/respond/`         | メンションや返信への応答(会話の組み立て、返答の分割と投稿)                                                                                                          |
| `src/llm/`             | AnthropicとOpenRouterの呼び出しと、モデル情報の取得                                                                                                                 |
| `src/jev/`             | 右クリックメニューの「Jevに聞く」(TypeSafeのJevの呼び出し、AIに渡す道具と指示、回答の整形)                                                                          |
| `src/voice/`           | 音声メッセージの文字起こし(Workers AIのWhisperの呼び出し、1回の返答の長さの上限、前もって文字にする仕事、表示する文言)                                              |
| `src/store/`           | D1の読み書き(設定、暗号化したキー、連携の途中の状態、保存したメッセージ、リアクション、寄付、スキル、Bobert.md、音声メッセージを文字にした内容)と、検索用のデータ化 |
| `src/crypto.ts`        | キーの暗号化と、ランダムな文字列                                                                                                                                    |
| `src/config/models.ts` | `/model`で選べるモデルの候補                                                                                                                                        |
| `src/discord/`         | Discord APIの定数と呼び出し                                                                                                                                         |
| `migrations/`          | D1のスキーマ                                                                                                                                                        |
| `test/`                | テスト(Workersの実行環境で動かす)                                                                                                                                   |

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
pnpm exec wrangler vectorize create-metadata-index bobert-messages-dev --propertyName=guild_id --type=string

# シークレット(.env.example にある名前をすべて設定する)
pnpm exec wrangler secret put DISCORD_BOT_TOKEN --env=""

# D1にスキーマを作る
pnpm db:migrate:dev
```

本番のシークレットは、Gitに入らない`.env.production`(書式は`.env.example`と同じ)に書き、環境を作ったときの最初のデプロイで、まとめて入れる。本番の環境は2026-10-29に作成済み。その後のデプロイは、mainへのpushで自動で行う(次の「本番へのデプロイ」)。

```sh
pnpm db:migrate:production
pnpm exec wrangler deploy --env production --secrets-file .env.production
```

## 本番へのデプロイ

mainにpushすると(PRのマージを含む)、GitHub Actions(`.github/workflows/deploy.yml`)が、次の順に本番へデプロイする。途中の手順が失敗したら、そこで止まる。
1. リント、型チェック、テストを実行する(PRのときと同じ`ci.yml`)。
2. D1のマイグレーションを反映する(`pnpm db:migrate:production`)。新しいコードが新しいテーブルや列を使うことがあるため、デプロイより先に行う。
3. Workerをデプロイする(`pnpm deploy:production`)。
4. スラッシュコマンドを登録する(`src/interactions/commands.ts`の一覧で丸ごと置き換える)。デプロイの直後は、前の版が応答して、前の一覧のまま登録することがある。そのため、デプロイした版が応答するまでやり直す。
5. What's NewをDiscordに送り、版のタグを付ける(下の「版とWhat's New」)。

デプロイが重ならないよう、実行は1つずつ、pushした順に進む。待っている間に新しいpushが来たら、待っていた方の実行は取り消され、新しい方だけがデプロイされる(新しい方に、取り消された方の変更も含まれている)。失敗した実行をやり直す(Re-run)ときは、そのコミットがmainの最新かを確かめる。最新でなければ、古い版で上書きしないよう、デプロイせずに失敗にする。

### 最初に1回だけ: GitHubのシークレット

リポジトリの「Settings → Secrets and variables → Actions」か、`gh secret set 名前`で入れる。

| 名前                    | 中身                                                                                                                                                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`  | CloudflareのAPIトークン。ダッシュボードの「Account API Tokens」で、テンプレート「Edit Cloudflare Workers」から作る。権限に「D1」「Queues」「Vectorize」の「Edit」がなければ足し、対象のアカウントはBobertのアカウントだけにする |
| `CLOUDFLARE_ACCOUNT_ID` | CloudflareのアカウントID(`pnpm exec wrangler whoami`で表示される)                                                                                                                                                               |
| `ADMIN_TOKEN`           | 本番の管理用エンドポイントのトークン(`.env.production`の値)。スラッシュコマンドの登録に使う                                                                                                                                     |
| `WHATS_NEW_WEBHOOK_URL` | What's Newを送るDiscordのWebhookのURL。送り先のチャンネルの設定の「連携サービス」で、ウェブフックを作ってURLをコピーする。送ったメッセージには、ウェブフックに付けた名前とアイコンが出る                                        |

### 自動ではしないこと

- **Workerのシークレット:** 自動デプロイでは入れず、Cloudflareに入っている値をそのまま使う。シークレットを足す変更は、マージの前に本番へ入れておく。1つなら`pnpm exec wrangler secret put 名前 --env production`、`.env.production`からまとめてなら`pnpm exec wrangler secret bulk .env.production --env production`で入れる。`wrangler.jsonc`の`secrets.required`にあるものが入っていないと、デプロイは止まる。
- **Cloudflareのリソース:** QueueやVectorizeの索引などは作らない。リソースを足す変更は、マージの前に作っておく(上の「Cloudflareのリソースを作る」)。
- **Gatewayの始め直し:** Gatewayのコードやインテントを変えたときは、デプロイの後に手で始め直す(次の「Gatewayとコマンドを準備する」)。
- **開発用の環境:** 自動でデプロイするのは本番だけ。開発用の環境には、今までどおり手元からデプロイする。

### 版とWhat's New

版の番号は`1.{major}.{minor}`の形で、GitHubのタグ(`v1.3.0`など)で記録する。最初の`1`は変えない。
デプロイが済むと、前の版のタグを付けたコミットの後にmainへ入ったPRを調べ、PRのラベルで次のように扱う。

| PRのラベル   | What's Newでの扱い                               | 版の上げ方                                              |
| ------------ | ------------------------------------------------ | ------------------------------------------------------- |
| `機能追加`   | 「機能追加」の箇条書きに、PRのタイトルを載せる   | majorを1つ上げ、minorを0に戻す(1.2.3 → 1.3.0)           |
| `軽微な修正` | 「軽微な修正」の箇条書きに、PRのタイトルを載せる | 機能追加のPRがなければ、minorを1つ上げる(1.2.3 → 1.2.4) |
| どちらもない | 載せない(文書、CI、テストだけの変更など)         | 上げない                                                |
- 両方のラベルがあるPRは、機能追加として扱う。
- 続けてマージしたPRが1回のデプロイにまとまっても、版は1つだけ上げる。
- 載せるPRが1つもなければ、版を上げず、Discordにも送らない。
- ラベルは、マージの時ではなく、デプロイの後に読む。付け忘れたPRも、次の版が出る前にラベルを付ければ、その版に載る。
- PRを通さずにmainへpushしたコミットは、載せない。

Discordには、`WHATS_NEW_WEBHOOK_URL`のウェブフックで、次の形の埋め込みを送る。PRがない方の項目は出さない。

```text
What's New v1.3.0

機能追加
• クレジットの寄付を実装
• 右クリックメニューの「Bobertに聞く」を実装

軽微な修正
• AIの返答の先頭に付いた「[時刻] Bobert: 」を外す

(送った日時)
```

- **最初の1回:** 版のタグがまだなければ、そのコミットを`v1.0.0`として記録するだけで、Discordには送らない。
- **送れなかったとき:** タグを付けずに、What's Newのジョブを失敗にする(デプロイはそのまま)。シークレットなどを直してから、失敗したジョブをやり直す(Re-run failed jobs)と、同じ内容を送り直す。
- **送る内容を前もって見る:** 次のコマンドで、次の版と送る内容を表示する。Discordへの送信と、タグの作成はしない。

```sh
GITHUB_TOKEN=$(gh auth token) GITHUB_REPOSITORY=4rtoflow/Bobert GITHUB_SHA=$(git rev-parse origin/main) node scripts/whats-new.ts --dry-run
```

## Gatewayとコマンドを準備する

デプロイしたあと、管理用エンドポイントから次の操作をする。`ADMIN_TOKEN`は`.env`(本番では`.env.production`)の値。
- **Gateway:** 環境ごとに最初の1回だけ、接続を始める。以降はアラームで動き続け、デプロイで切れてもResumeでつなぎ直す。
- **スラッシュコマンド:** 本番では、自動デプロイが毎回登録する。開発用の環境では、コマンドを追加・変更したら、登録し直す(`src/interactions/commands.ts`の一覧で丸ごと置き換える)。デプロイの直後は、古い版が応答することがある。登録の結果に新しいコマンドがなければ、少し待ってからやり直す。
- **D1のスキーマ:** 本番では、自動デプロイが反映する。開発用の環境では、`migrations/`にファイルが増えたら、デプロイの前に`pnpm db:migrate:dev`で反映する。
- **Gatewayのコードやインテントを変えたとき:** デプロイの後に、Gatewayを止め、4分ほど待ってから始め直す。Gatewayを持つDurable Objectは、アラームとWebSocketで動き続けるので、デプロイしても前の版のコードのまま残ることがある(2026-10-28に、開発用の環境で起きた)。止めてしばらくたつと片付けられ、次に始めたときに新しい版で動く。インテントは、Resumeでは反映されないので、始め直しが要る。新しい版で動いているかは、`wrangler tail`のGatewayのイベントの版で確かめられる。
- **ベクトルの入れ直し:** ベクトルのメタデータを足したら(サーバーIDを足したときなど)、メタデータ索引を作ってから、保存したメッセージのベクトルを入れ直す。

```sh
URL=https://bobert-dev.<サブドメイン>.workers.dev
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" $URL/admin/gateway/start      # Gatewayを始める
curl -H "Authorization: Bearer $ADMIN_TOKEN" $URL/admin/gateway/status              # 状態を見る
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" $URL/admin/gateway/stop       # 止める
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" $URL/admin/commands/register  # コマンドを登録する
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" $URL/admin/vectors/reindex    # ベクトルを入れ直す
```

## よく使うコマンド

| コマンド                 | 内容                                                             |
| ------------------------ | ---------------------------------------------------------------- |
| `pnpm dev`               | 手元で起動する                                                   |
| `pnpm test`              | テストを実行する                                                 |
| `pnpm lint`              | リントと整形のチェック                                           |
| `pnpm format`            | 整形して、直せるものを直す                                       |
| `pnpm typecheck`         | 型チェック                                                       |
| `pnpm cf-typegen`        | `wrangler.jsonc`から型を作り直す(設定を変えたら実行する)         |
| `pnpm deploy:dev`        | 開発用の環境にデプロイする                                       |
| `pnpm deploy:production` | 本番用の環境に、手元からデプロイする(ふだんはmainへのpushで自動) |
