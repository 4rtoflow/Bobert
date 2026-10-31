# 開発環境とアカウントの準備

最終更新: 2026-10-31

仕様は[docs/spec/](spec/)を参照。ここでは、開発を始めるために用意するアカウント、サービス、手元の環境をまとめる。

## アカウントとサービス

### Discord(Developer Portal)

- **アプリ:** Bot用のアプリを2つ作る。開発用(例: Bobert Dev)と本番用(Bobert)。
- **各アプリの設定:**
  - **Bot:** トークンを発行する。Workerのシークレットに入れる。
  - **Public Bot:** OFFにする。開発者だけがサーバーに追加できるようにするため。
  - **Privileged Gateway Intents:** Message Content IntentをONにする(必須)。Server Members IntentもONにする。AIがメンバーを名前で探すときに、サーバーの全員の一覧を読むため。OFFでも動くが、そのときは、発言したことのある人とメンションされた人しか探せない。
  - **General Information:** Application IDとPublic Keyを控える。Public KeyはInteractionsの署名の確認に使う。
  - **Interactions Endpoint URL:** WorkerのURLを、デプロイした後に設定する。保存するとDiscordが確認の要求(PING)を送るので、その時点でWorker側が応答できている必要がある。
  - **OAuth2 → URL Generator:** スコープは`bot`と`applications.commands`。権限は「チャンネルを見る」「メッセージを送信」「スレッドでメッセージを送信」「メッセージ履歴を読む」と、エージェント(`/agent`)のための「チャンネルの管理」「メッセージの管理」「埋め込みリンク」「ファイルを添付」。生成した招待URLで、Botをサーバーに追加する。
    - すでにBotを入れたサーバーでは、サーバーの管理者が、Botの役職に、エージェントのための4つの権限を足す。
- **テストサーバー:** 開発用のテストサーバーを1つ作る。開発用のBotは、このサーバーだけで使う。
- **障害の通知先:** 開発者用のチャンネルを作り、そのWebhook URLを発行する。開発用と本番用でそれぞれ用意する。

### Cloudflare

- **アカウント:** 1つのアカウントに、開発用と本番用の2つの環境を作る(Wranglerの環境機能を使う)。
- **プラン:** Workersの有料プラン(月$5)。アカウント単位の料金なので、開発用と本番用の両方が含まれる。
- **環境ごとに作るもの:**
  - Worker(Durable Objectを含む)
  - Queue
  - D1データベース
  - Vectorizeの索引。発言者ID、時刻、サーバーIDで絞り込むためのメタデータ索引を、最初のデータを入れる前に作っておく
  - Workers AI(バインディングの設定だけ)
- **シークレット(環境ごと):**
  - DiscordのBotトークン
  - DiscordのPublic Key
  - キーを暗号化するための鍵
  - 管理用エンドポイントのトークン
  - 障害通知用のWebhook URL
- **URL:** `workers.dev`のURLで足りる。独自ドメインは不要。
- **GitHub Actions用:** APIトークン(Workers、D1、Queues、Vectorizeを編集できる権限)と、アカウントID。

### GitHub

- **リポジトリ:** [4rtoflow/Bobert](https://github.com/4rtoflow/Bobert)。作成済みで、まだ空。
- **Actionsのシークレット:** CloudflareのAPIトークンと、アカウントID。

### GitHub App(エージェントのGitHubとの連携)

エージェント(`/agent`)が、利用者のGitHubのリポジトリを使うための、Bobert用のGitHub App。運営者が1つ登録する(2026-11-01に`bobert-agent-app`を登録し、4rtoflowの組織に移した)。仕組みは[アーキテクチャ](spec/architecture.md)「エージェント(Bobert Agent)」の「GitHub」を参照。
1. 組織の設定の「Developer settings」→「GitHub Apps」→「New GitHub App」で、登録の画面を開く(個人のアカウントでもよい)。
2. 次のとおりに埋める。
   - **GitHub App name:** GitHub全体で重ならない名前。利用者が連携するときの画面に出る
   - **Homepage URL:** `https://github.com/4rtoflow/Bobert`
   - **Redirect URI:** `https://bobert.4rna-y.workers.dev/oauth/github/callback`。ワイルドカード(wildcard matching)はOFF。2026-08-03から、この欄の名前は「Callback URL」ではなくなっている。開発用の環境でも使うなら、開発用のWorkerのURLの同じパスも足す(10個まで登録できる)
   - **Expire user authorization tokens:** ON(トークンが8時間で切れ、Bobertが更新する)
   - **Request user authorization (OAuth) during installation:** ON(リポジトリを選んだ後、そのまま連携まで進む)。「Setup URL」は空のまま
   - **Enable Device Flow:** OFF
   - **Redirect on update:** OFF(Setup URLが空なので効かない)
   - **Webhook**の**Active:** OFF
   - **Repository permissions:** Contents(Read and write)と、Pull requests(Read and write)。Metadata(Read-only)は自動で付く。将来、エージェントからIssueやActionsなども扱うために([issue #76](https://github.com/4rtoflow/Bobert/issues/76))、Actions、Issues、Pages、Repository projects、Workflowsも先に読み書きにしてある。後から権限を足すと、アプリを入れた人がそれぞれ承認し直す必要があるため。Workflowsがあると、エージェントは`.github/workflows`の中のファイルを変えたコミットもpushできる
   - **Where can this GitHub App be installed?:** Any account(利用者がそれぞれ、自分のGitHubで連携するため)
3. 作った後の画面で「Client ID」を控え、「Generate a new client secret」でシークレットを作って控える(その画面でしか見られない)。アプリの公開ページのURL(`https://github.com/apps/〇〇`)の「〇〇」が、アプリのURL上の名前。App IDと秘密鍵(Private key)は使わない。
4. 3つの値を、本番のシークレット(`.env.production`)に書く: `GITHUB_APP_CLIENT_ID`、`GITHUB_APP_CLIENT_SECRET`、`GITHUB_APP_SLUG`。デプロイのときに、`--secrets-file .env.production`で入れる(README「Cloudflareのリソースを作る」)。

### LLM(テスト用)

- **Anthropic:** 開発者自身のClaude ConsoleのAPIキー。テストに使う分の費用は開発者が払う。利用者は各自のキーを使う。
- **OpenRouter:** 開発者自身のアカウントと、少額のクレジット。OAuth連携のテストに使う。アプリの事前登録は不要で、コールバックURLを指定するだけでよい。

## 手元の開発環境

| ツール                    | 状態(2026-10-23時点)      | 備考                                                                                                     |
| ------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------- |
| Node.js 24                | インストール済み(v24.0.2) |                                                                                                          |
| pnpm                      | インストール済み(12.15.0) | `npm install -g pnpm`で、ユーザー用のフォルダに入れた。Corepackはpnpm 11以降に対応していないため使わない |
| Git                       | インストール済み          |                                                                                                          |
| Wrangler(CloudflareのCLI) | プロジェクトに導入済み    | `pnpm exec wrangler`で使う。最初に`pnpm exec wrangler login`でCloudflareにログインする                   |

## 手元での動かし方(案)

- **起動:** `wrangler dev`で手元で動かす。D1、Queues、Durable Objectは手元で再現される。
- **Workers AIとVectorize:** 手元では再現できない。バインディングに`remote: true`を指定し、開発用環境のリソースにつなぐ(Wrangler 4.37以降)。
- **Gateway:** Durable Objectは手元からでもDiscordに接続できる。開発用Botのトークンを使う。
- **Interactions(スラッシュコマンドなど):** DiscordからHTTPSで届く必要があるので、手元には直接届かない。開発用環境にデプロイして試すか、Cloudflare Tunnelで手元を公開する。
- **シークレット:** 手元では`.env`(`.env.example`をコピーして作る。Gitに入れない)、Cloudflareでは`wrangler secret put`で設定する。

## 準備の順番(案)

1. Cloudflareのアカウントを作り、有料プランに切り替えて、`wrangler login`する。
2. Discordで、開発用のアプリとテストサーバーを作る。
3. 手元で、プロジェクトの雛形(pnpm、Wrangler、Vitest、Biome)を作る(2026-10-23に作成済み)。
4. 開発用環境のリソース(D1、Queue、Vectorize)を作る。
5. Gatewayの接続処理から実装を始める。
6. 本番用のDiscordアプリとCloudflareの環境は、自分たちのサーバーで使い始める前に用意する。

## 開発中の費用

- **Cloudflare:** 月$5(有料プラン。開発用と本番用の両方を含む)。
- **LLM:** テストで使った分(開発者自身のキー)。

## 参考

- Discord: [Developer Portal](https://discord.com/developers/applications) / [Receiving and Responding(Interactions)](https://docs.discord.com/developers/interactions/receiving-and-responding)
- Cloudflare: [Local development](https://developers.cloudflare.com/workers/local-development/) / [Workersの料金](https://developers.cloudflare.com/workers/platform/pricing/)
- OpenRouter: [OAuth PKCE](https://openrouter.ai/docs/guides/overview/auth/oauth)
