# LLM利用コスト

最終更新: 2026-10-31

## 方針

- LLMの利用料は、使ったユーザー本人が自分の分を負担する。Botの運営者は負担しない。
- 例外として、会話の検索(RAG)のための埋め込みの費用は運営者が負担する。Cloudflare Workers AIを使い、少額で済む(bge-m3なら100万トークンあたり約$0.012)。
- もう1つの例外として、ユーザーは、サーバーの全員が使えるクレジットを寄付できる。寄付された額までは、寄付した人が、ほかの人の分を負担する(「クレジットの寄付」を参照)。
- 各ユーザーは自分の資格情報をBotに登録する。Botはそれを、登録したユーザー本人のリクエストに使う。寄付した人の資格情報は、寄付された額まで、同じサーバーのほかの人のリクエストにも使う。それ以外で、他人の資格情報で応答することはない。
- 資格情報を登録していないユーザーのために、運営者の資格情報でLLMを呼び出すことはしない。
- サブスクリプションの利用枠(Claude Pro/Max、ChatGPT、Google AI Pro/Ultra、GitHub Copilotなど)は使わない。
- 例: AさんとBotの会話にBさんが返信した場合、その返信への応答にはBさんの資格情報を使う(サーバーに寄付があれば、寄付した人の資格情報を先に使う)。
- 会話の履歴や検索結果に他の人の発言が含まれる場合も、そのまま文脈として、返信した人のプロバイダに送る。寄付で答えるときは、寄付した人のプロバイダに送る。個別の告知はしない。上の例では、Aさんの発言もBさんのプロバイダに送られる。
- Bot側では使用量の上限を設けない。使いすぎの防止は各ユーザーがプロバイダ側で行う(Anthropicはワークスペースごとに支出上限を設定できる)。寄付だけは、寄付された額を上限として、Botが使った額を数える。

## 対応する資格情報

| 方式              | 登録方法                                                                     | 課金先                         | 使えるモデル                                                |
| ----------------- | ---------------------------------------------------------------------------- | ------------------------------ | ----------------------------------------------------------- |
| Anthropic APIキー | ユーザーがClaude Consoleで発行したキーを登録する                             | ユーザーのClaude Console組織   | Claudeの各モデル                                            |
| OpenRouter        | OAuth(PKCE)でユーザーがOpenRouter上でBotを承認し、本人のキーを発行してもらう | ユーザーのOpenRouterクレジット | OpenRouterで提供される各社のモデル(GPT、Gemini、Claudeなど) |
- Anthropicに直接対応する理由: Claude Max/Teamの契約者は、プラン付属の月額APIクレジットを、紐付けたConsole組織のAPIキーで使える。月額はMax 5xが$100、Max 20xが$200、Teamが最大$500。
- OpenRouterのモデル単価は各社と同額。クレジット購入時に手数料がかかる(約5.5%、最低$0.80。2026-10時点の第三者による解説)。
- OpenRouterへのリクエストには、データを保存・学習しないプロバイダだけを使う指定(`provider.data_collection: "deny"`)を付ける。会話には他の人の発言も含まれるため。この指定により、使えなくなるモデルもある。

## 資格情報の登録・保存・削除

- **Anthropic:** `/setup`のボタンでモーダルを開き、APIキーを入力してもらう。
  - キーがワークスペースに属さない場合(Claude Consoleで、ワークスペースを指定せずに作った個人キーなど)は、使うワークスペースのID(`wrkspc_`で始まる)も入力してもらう。リクエストのたびに`anthropic-workspace-id`ヘッダーで送る。IDは秘密の情報ではないので、暗号化せずに保存する。
  - ワークスペースIDが足りないとき、IDが正しくないときは、確認の結果でその理由を表示する。
  - 入力は、全角の英数字を半角にし、空白と見えない文字を取り除いてから使う。
- **OpenRouter:** `/setup`で連携用のリンクを送り、OAuth(PKCE)で連携する。コールバックはWorkerで受ける。
  - リンクは`/setup`を実行した本人にだけ見える形で送り、10分間だけ有効にする(OpenRouterのcodeの有効期間に合わせる)。1回使うと無効になる。
  - リンクに付ける`state`で、どのDiscordユーザーのキーとして保存するかを決める。
  - OpenRouterに作られるキーの名前に、Discordのユーザー名を入れる(例: `Bobert (Discord: alice)`)。承認の画面で、どのアカウントと連携するのかを確かめられるようにするため。
  - 連携が済んだら、`/setup`への追加の返信で、本人にメンションして「OpenRouterとの連携が完了しました。」と知らせる。`/setup`の返信と同じく、本人にだけ見える形にする。そのために、`/setup`のInteractionのトークン(15分有効)を`state`と一緒に保存しておく。
- **GitHub(エージェント):** エージェントのGitHubとの連携で受け取るトークン(本人に代わって操作するトークンと、更新用のトークン)は、`/setup`ではなく、エージェントの「GitHubと連携」のボタンから連携して受け取る(仕組みは[アーキテクチャ](architecture.md)「エージェント(Bobert Agent)」の「GitHub」を参照)。GitHubのトークンにはLLMの費用がかからないので、寄付とは関係しない。
- **有効性の確認:** 登録時に、料金のかからないAPI(Anthropicのモデル一覧API)を呼び、キーが有効か確かめる。OpenRouterのキーは、OpenRouterから受け取ったものをそのまま使う。
- **保存:** Workerのシークレットにある鍵で暗号化して(AES-256-GCM)、D1に保存する。ログには出さない。GitHubのトークンも、同じ鍵で暗号化して保存する。
  - 暗号文は持ち主(ユーザーIDとプロバイダ)に結び付ける。ほかの人の行に移しても復号できない。
- **暗号鍵の入れ替え:** 暗号化したデータに鍵の番号を付けて、鍵を入れ替えられるようにする。
- **バックアップ:** D1標準の復元機能(Time Travel)に任せる。過去30日の任意の時点に戻せて、追加料金はかからない。
- **削除:** 本人がスラッシュコマンド(`/delete`)で、いつでも削除できる。確認のボタンを押すと、キーと設定を消す。キーがなくなるので、寄付も消す。自動では削除しない。キーや設定は個人に紐づくので、Botがサーバーから外されても残す。OpenRouterで発行されたキーは、OpenRouterのサイトでも削除できることを案内する。
  - エージェントのセッションは、本人のキーでないと消せない。そのため、キーを読んでおき、記録を消した後に、エージェントのチャンネルとセッションを消す。本人のアカウントに作った環境は削除し、エージェントの設定はアーカイブする(削除できないため)。
  - GitHubと連携していれば、連携の記録を消し、GitHubへの承認も取り消す。確認の文に「GitHubとの連携も外します。」を足す。

## ユーザーごとの設定

- 各ユーザーが自分の設定(使うモデル、AIへの自分用の指示など)を持つ。AIへの指示については[Botの振る舞い](behavior.md)を参照。
- モデルは、スラッシュコマンドで送るセレクトメニューから選んで変更する。
- 既定のモデルはClaude Haiku 5.5。
- 思考の深さ(effort)の既定は`low`。モデルが`low`を選べなければ、いちばん近い段階を使う。近さが同じなら浅い方にし、`none`(考えない)は、ほかに選べる段階がないときだけ使う。
- ユーザーごとの設定を変更するためのメッセージは、本人にしか見えないメッセージ(エフェメラル)で送る。

## モデルの候補

`/model`のセレクトメニューには、次の20個と「その他」を並べる。価格は2026-10-23時点で、100万トークンあたりの入力/出力(USD)。

| 区分       | モデル                 | Anthropic / OpenRouterのID                          | 価格          | 備考                                                       |
| ---------- | ---------------------- | --------------------------------------------------- | ------------- | ---------------------------------------------------------- |
| Claude     | Claude Haiku 5.5(既定) | `claude-haiku-5-5` / `anthropic/claude-haiku-5.5`   | 0.10 / 0.50   | 入力が10万トークンを超えると0.50 / 2.50                    |
| Claude     | Claude Sonnet 5.5      | `claude-sonnet-5-5` / `anthropic/claude-sonnet-5.5` | 2 / 10        |                                                            |
| Claude     | Claude Opus 5.5        | `claude-opus-5-5` / `anthropic/claude-opus-5.5`     | 4 / 20        |                                                            |
| Claude     | Claude Fable 5.1       | `claude-fable-5-1` / `anthropic/claude-fable-5.1`   | 10 / 50       |                                                            |
| 上位       | GPT-6 Astra            | `openai/gpt-6-astra`                                | 10 / 50       |                                                            |
| 上位       | Gemini 4 Argon         | `google/gemini-4-argon`                             | 2 / 10        | 2026-12-01に約2倍へ値上げ予定                              |
| 上位       | GPT-6.1 Sol            | `openai/gpt-6.1-sol`                                | 2 / 10        |                                                            |
| 上位       | Grok 4.7               | `x-ai/grok-4.7`                                     | 2 / 6         |                                                            |
| 上位       | Qwen3.8 Max            | `qwen/qwen3.8-max-0902`                             | 2 / 6         |                                                            |
| 上位       | Kimi K3                | `moonshotai/kimi-k3`                                | 3 / 15        |                                                            |
| 上位       | Meta Muse Spark 1.3    | `meta/muse-spark-1.3`                               | 1.25 / 4.25   |                                                            |
| 上位       | Mistral Large 4        | `mistralai/mistral-large-4-0`                       | 1.36 / 4.18   |                                                            |
| 上位       | GLM 5.3                | `z-ai/glm-5.3`                                      | 1.40 / 4.40   | 画像を読めない                                             |
| 中・低価格 | Gemini 3.8 Flash       | `google/gemini-3.8-flash`                           | 0.75 / 3.75   | 2027-01-01に約2倍へ値上げ予定                              |
| 中・低価格 | MiMo-V2.6-Pro          | `xiaomi/mimo-v2.6-pro`                              | 0.435 / 0.87  |                                                            |
| 中・低価格 | Gemini 3.5 Flash-Lite  | `google/gemini-3.5-flash-lite`                      | 0.30 / 2.50   |                                                            |
| 中・低価格 | DeepSeek V4.1 Flash    | `deepseek/deepseek-v4.1-flash-1017`                 | 約0.30 / 1.20 | DeepSeek自身の窓口は学習に使うため、他社の提供分だけを使う |
| 中・低価格 | MiniMax M3.1 Flash     | `minimax/minimax-m3.1-flash`                        | 0.15 / 0.60   |                                                            |
| 中・低価格 | GLM 5.3 Flash          | `z-ai/glm-5.3-flash`                                | 0.15 / 0.50   |                                                            |
| 中・低価格 | GPT-6 Luna             | `openai/gpt-6-luna`                                 | 0.10 / 0.50   |                                                            |
- **PDFを読めるか:** OpenRouterのモデル情報の入力の種類(`input_modalities`)に`file`があるものを、読めるとする(2026-10-30時点)。候補のうち、Qwen3.8 Max、Kimi K3、Mistral Large 4、GLM 5.3、MiMo-V2.6-Pro、DeepSeek V4.1 Flash、MiniMax M3.1 Flash、GLM 5.3 Flashの8つは、PDFを読めない。読めるかは設定ファイルに書き、メニューの備考には書かない([アーキテクチャ](architecture.md)「添付ファイルの読み取り」を参照)。
- **メニューの出し分け:** そのユーザーが登録した資格情報で使えるモデルだけを出す。Claudeは、Anthropicのキーがあれば直接呼び(Max/Teamの付属クレジットが使える)、なければOpenRouter経由で呼ぶ。
- **メニューの表示:** 選択肢の説明に、価格(100万トークンあたりの入力 / 出力)と備考を書く。今のモデルを選んだ状態で出す。「その他」のモデルを使っているときは、どれも選んでいない状態で出す(選んだ状態の選択肢を選び直しても、Discordは知らせてこないため)。
- **「その他」:** 選ぶとモーダルが開き、モデルIDを入力できる(例: `openai/gpt-6.1-sol`)。
  - `claude-`で始まるIDは、Anthropicのキーで直接呼ぶ。それ以外はOpenRouterで呼ぶ。
  - 入力されたIDは、OpenRouterやAnthropicのモデル一覧で存在を確かめる。
  - 学習に使わないプロバイダでは使えないモデルの場合は、使うときにエラーで知らせる。
  - 画像とPDFを読めるかは、Claudeは読めるものとし、それ以外はOpenRouterのモデル情報(入力の種類)で判断する。モデル情報(モデル一覧)は、取得したら1時間使い回す。
- **`/effort`の選択肢:** モデルごとに選べる段階が違うので、OpenRouterのモデル情報(対応する段階)から作る。
  - Claudeは`low`〜`max`。
  - 「その他」で入力したClaudeは、本人のキーで、Anthropicのモデル情報から作る。古いモデルには、選べない段階があるため。このモデル情報も、取得したら1時間使い回す。
  - 既定の段階に「(既定)」を付ける。モデルが`low`を選べなければ、代わりに使う段階に付ける。既定の段階を選ぶと、設定を消して既定に従う(モデルを変えても、そのモデルで代わりに使う段階になる)。
  - 返答のたびに、使うモデルでその段階を選べるか確かめ、選べなければ、いちばん近い段階を送る。
  - モデルを変えたときに、保存した段階を新しいモデルで選べなければ、既定に戻す。
- **Web検索の費用:** 1回の返答での検索は5回までにする。利用量の表示の費用には、検索の費用も含める。
  - OpenRouter経由: 1回あたり約$0.005〜0.014と、検索結果のトークン分。
  - Anthropicのキーで直接使う場合: 1,000回あたり$10。
- **一覧の管理:** 候補の一覧は設定ファイルで管理し、定期的に見直す。モデルの入れ替わりが速いため。

## クレジットの寄付

ユーザーは、指定した額のクレジットを、サーバーの全員が使えるように寄付できる。寄付された分は、寄付した人のキーで答える。
- **寄付のしかた:** `/donate`で、寄付、残りの確認、寄付をやめる操作をする(画面と文言は[Botの振る舞い](behavior.md)を参照)。寄付はサーバーごと。
  - 1回の寄付は$1〜$100で、小数点以下2桁まで。打ち間違いで大きな額を寄付しないよう、上限を付ける。何度でも足せる。
  - 寄付するには、キーの登録が必要。
  - 寄付をやめると、残りは使われない。やめた後に寄付し直したら、その額から数え直す。
- **使う順番:** 寄付があれば、キーのない人も使える。キーを登録している人の返答にも、先に寄付を使う。寄付が複数あれば、古い順に使う。
  - 寄付した本人の返答には、本人の寄付は使わない。同じキーなので、寄付が減るだけのため。
- **モデル:** 使う人の設定のモデルで答える。キーのない人は、既定のモデル(Claude Haiku 5.5)で答える。
  - 寄付した人のキーで呼べないモデルには使わず、本人のキーで答える。例えば、Anthropicのキーだけの人の寄付では、GPTやGeminiは呼べない。
  - 「その他」で入力したモデルには使わない。費用が分からないことがあり、単価に上限もないため。
- **対象:** メンションへの返答、「Bobertに聞く」、要約(自動と今すぐ)。
- **差し引き:** APIを呼ぶたびに、その分の費用を寄付から差し引く。
  - 費用は、利用量の表示と同じ計算で出す。それでも分からない回(単価を取得できなかったときなど)は、候補の一覧の単価で見積もる。
  - 費用は呼んだ後に分かるので、使い切る直前の返答の分だけ、寄付した額を少し超えることがある。同時にいくつか返答していると、超える分が増える。超えた分は、次に寄付したときの額から引かない。
- **チャンネル:** 寄付した人がサーバーにいれば、どのチャンネルでも使う。寄付した人が見られないチャンネルの会話も、寄付した人のアカウントに送られる。
  - 寄付を使う前に、寄付した人がサーバーにいるかをDiscordに問い合わせる。抜けていたら(アカウントを消していたら)、その寄付を終える。確かめられなかったとき(Discordの障害など)は、その返答では使わない。
- **キーが使えないとき:** 寄付した人のキーが無効か残高不足なら、その寄付を1時間止めて、次の寄付か本人のキーで答え直す。1時間たつか、寄付した人が寄付を足すと、また使う。
- **上限:** 1人あたりの上限は付けない。寄付した人は、残りを見て、いつでも寄付をやめられる。
- **削除:** `/delete`でキーを消すと、その人の寄付も消す。
- **規約(2026-10-28時点):** AnthropicもOpenRouterも、クレジットを他人に譲ることや売ることを禁じている。Anthropicは「クレジットは、アカウントの持ち主だけが使える」としている。
  - 寄付では、クレジットは寄付した人のアカウントに残り、Bobertは寄付した人のキーで呼ぶ。このため、譲渡ではなく、持ち主の利用と考える。
  - ただし、ほかの人への返答に使うことを、はっきり認めた記述はない。
  - キーでの利用は、すべてキーの持ち主の責任になる(OpenRouterの規約3.2)。
- **会話の扱い:** 寄付で答えた会話は、寄付した人のプロバイダに送られる。OpenRouterで入力と出力の記録(Input & Output Logging)をONにした人が寄付すると、寄付で答えた会話を、その人が読める。
  - 寄付するときの説明に、このことと、費用が概算であることを書く。

## エージェントの費用

`/agent`のエージェント(Claude Managed Agents。[アーキテクチャ](architecture.md)「エージェント(Bobert Agent)」を参照)の費用は、本人のAnthropicのアカウントにかかる。運営者は負担しない。
- **かかるもの:** トークン代(通常のAPIと同じ単価)と、セッションが動いている(`running`)間の1時間あたり$0.08。待っている(`idle`)間は数えない。コンテナの料金は別にかからない。Web検索を使えば、その料金もかかる。
- **使える人:** Anthropicのキーを登録した人だけ。Managed AgentsはAnthropicのAPIの機能なので、OpenRouterのキーでは使えない。
- **寄付は使わない:** 寄付された分は寄付した人のキーで答えるので、寄付で動かすと、セッションの記録が寄付した人のアカウントに残り、寄付した人が読めてしまうため。
- **上限:** 付けない。今の方針(Bot側では使用量の上限を設けない)に合わせる。Managed Agentsには、セッションごとの上限額の機能があるが、使わない。
- **記録:** セッションの記録(会話と作業の内容)は、消すまで本人のアカウントに残る(ゼロデータ保持の対象外)。本人は、Claude Consoleで読める。セッションを終えると消す。
- **スキル:** サーバーのスキルの一覧と、Anthropicの文書のスキルの説明の分、セッションの入力が少し増える。スキルを読めば、本文の分も増える。どちらも本人の負担。
- **ファイル:** 本人が添付したファイルは、本人のアカウントのFiles APIに上げてからサンドボックスに置く。上げた元のファイルは、置いた後に消す。サンドボックスに置いた写しと、エージェントが作ったファイルは、セッションと一緒に消える。
- **運営者の費用:** チャンネルごとのDurable Objectは、エージェントが動いている間だけイベントの流れを受けるので、待っている間のセッションは、運営者の費用を増やさない。

## 採用しない方式と理由

| 方式                                    | 理由                                                                                                                                                                                           |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Free/Pro/Maxのサブスクログイン   | Anthropicは、第三者のアプリがClaude.aiログインを提供することと、ユーザーに代わってサブスクの資格情報でリクエストを送ることを禁止している。資格情報やセッショントークンの収集・保存・仲介も禁止 |
| ChatGPTのサブスク(Sign in with ChatGPT) | サーバーでホストするアプリは申請制で、現在は選ばれた商用パートナーのみ                                                                                                                         |
| Google AI Pro/Ultraのサブスク           | Gemini CLIの個人ログインは2026-06-18に終了した。Antigravityの規約は、第三者のツールからのOAuth利用を違反としている                                                                             |
| GitHub Copilotのサブスク(Copilot SDK)   | 公式には可能(パブリックプレビュー)だが、サブスク枠は使わない方針のため                                                                                                                         |
| OpenAI APIキーの直接登録                | 契約の禁止事項に「APIキーを第三者と売買・譲渡すること」があり、グレー。OpenAIのモデルはOpenRouter経由で使う                                                                                    |
| Gemini APIキーの直接登録                | Googleの共通API規約は、資格情報を他のアプリに使わせないよう求めており、グレー。Gemini APIには18歳以上という条件もある。GeminiのモデルはOpenRouter経由で使う                                    |

## 未決事項

- なし

## 参考(2026-10時点の調査)

- Anthropic: [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) / [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) / [API credits for Max and Team plans](https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers) / [Commercial Terms](https://www.anthropic.com/legal/commercial-terms) / [クレジットの規約](https://www.anthropic.com/legal/credit-terms)
- OpenRouter: [OAuth PKCE](https://openrouter.ai/docs/guides/overview/auth/oauth) / [モデル一覧API](https://openrouter.ai/api/v1/models) / [プロバイダの選択(data_collection)](https://openrouter.ai/docs/guides/routing/provider-selection) / [Web検索](https://openrouter.ai/docs/guides/features/server-tools/web-search) / [推論(reasoning)の指定](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens) / [規約](https://openrouter.ai/terms) / [Input & Output Logging](https://openrouter.ai/docs/guides/features/input-output-logging)
- OpenAI: [Sign in with ChatGPT: Request a client ID](https://developers.openai.com/siwc/request-client-id) / [ChatGPT plan usage](https://developers.openai.com/siwc/token-sharing-open-source) / [Services Agreement](https://openai.com/policies/services-agreement/)
- Google: [Gemini Code Assist release notes](https://docs.cloud.google.com/gemini/docs/codeassist/release-notes) / [Antigravity terms](https://antigravity.google/terms) / [Google APIs Terms of Service](https://developers.google.com/terms) / [Gemini API Additional Terms](https://ai.google.dev/gemini-api/terms)
- GitHub: [Copilot SDK: GitHub OAuth](https://docs.github.com/en/copilot/how-tos/copilot-sdk/set-up-copilot-sdk/github-oauth)

各社の規約は2026年に何度も変わっているので、実装前と定期的に再確認する。
