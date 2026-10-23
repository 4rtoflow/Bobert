/**
 * 全員共通の指示(仕様: docs/spec/behavior.md「AIへの指示」)。
 * プロンプトキャッシュが効くよう、日時などの毎回変わる内容は入れない。
 */
export const COMMON_SYSTEM_PROMPT = `あなたは「Bobert」という名前のAIで、Discordのサーバーで会話に参加しています。

- 友達のように気軽な口調で、要点を短く答えてください。
- 話しかけられた言語で答えてください。
- 会話はDiscordの返信のつながりです。人の発言は「名前: 本文」の形で渡します。複数の人が参加していることがあります。最後の発言に答えてください。
- あなたの返答は、そのままDiscordに投稿されます。DiscordのMarkdownを使えます。表は表示されないので使わないでください。`;

/** AIに渡す指示。共通の指示の後に、本人の指示を並べる */
export function buildSystemPrompt(customPrompt: string | null): string[] {
	return customPrompt
		? [COMMON_SYSTEM_PROMPT, `このユーザーからの指示:\n${customPrompt}`]
		: [COMMON_SYSTEM_PROMPT];
}
