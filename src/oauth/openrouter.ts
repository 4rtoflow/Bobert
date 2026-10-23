import type { APIUser } from "discord-api-types/v10";
import { randomToken, sha256Base64Url } from "../crypto";
import { exchangeOpenRouterCode } from "../llm/openrouter";
import { logEvent } from "../log";
import { saveOAuthState, takeOAuthState } from "../store/oauth";
import { saveCredential } from "../store/users";

/** OpenRouterとの連携(OAuth PKCE)のコールバックのパス */
export const OPENROUTER_CALLBACK_PATH = "/oauth/openrouter/callback";

const AUTH_URL = "https://openrouter.ai/auth";

/** 連携のリンクの有効期間。OpenRouterのcodeの有効期間(10分)に合わせる */
const AUTH_LINK_TTL_MS = 10 * 60_000;

/**
 * /setup で見せる、OpenRouterとの連携のリンクを作る
 * (仕様: docs/spec/llm-cost.md「資格情報の登録・保存・削除」)。
 * stateで、コールバックを受けたときに誰のキーとして保存するかを決める。
 */
export async function createOpenRouterAuthLink(
	env: Env,
	origin: string,
	user: APIUser,
): Promise<string> {
	const state = randomToken();
	const codeVerifier = randomToken();
	const now = Date.now();
	await saveOAuthState(
		env.DB,
		state,
		{ userId: user.id, codeVerifier },
		now + AUTH_LINK_TTL_MS,
		now,
	);
	const url = new URL(AUTH_URL);
	url.searchParams.set("callback_url", `${origin}${OPENROUTER_CALLBACK_PATH}`);
	url.searchParams.set("code_challenge", await sha256Base64Url(codeVerifier));
	url.searchParams.set("code_challenge_method", "S256");
	url.searchParams.set("state", state);
	// OpenRouterに作られるキーの名前。どのDiscordアカウントと連携するのかを、承認の画面で確かめられるようにする
	url.searchParams.set("key_label", `Bobert (Discord: ${user.username})`);
	return url.toString();
}

/** OpenRouterからのコールバック: codeを本人のキーと交換し、暗号化して保存する */
export async function handleOpenRouterCallback(
	request: Request,
	env: Env,
): Promise<Response> {
	const url = new URL(request.url);
	const code = url.searchParams.get("code");
	const state = url.searchParams.get("state");
	if (!code || !state) {
		return page(
			400,
			"連携できませんでした",
			"連携がキャンセルされたか、リンクが正しくありません。Discordで /setup からやり直してください。",
		);
	}

	const saved = await takeOAuthState(env.DB, state);
	if (saved === null) {
		return page(
			400,
			"連携できませんでした",
			"リンクの有効期限(10分)が切れたか、すでに使われています。Discordで /setup からやり直してください。",
		);
	}

	try {
		const apiKey = await exchangeOpenRouterCode(code, saved.codeVerifier);
		await saveCredential(env, saved.userId, "openrouter", {
			apiKey,
			workspaceId: null,
		});
	} catch (error) {
		logEvent("oauth", "openrouter_link_failed", {
			userId: saved.userId,
			error: error instanceof Error ? error.message : "unknown",
		});
		return page(
			502,
			"連携できませんでした",
			"OpenRouterとのやり取りでエラーが起きました。少し待ってから、Discordで /setup からやり直してください。",
		);
	}
	logEvent("oauth", "openrouter_linked", { userId: saved.userId });
	return page(
		200,
		"OpenRouterと連携しました",
		"Discordに戻って、Bobertにメンションして話しかけてみてください。このページは閉じてかまいません。",
	);
}

/** 結果を知らせる簡単なページ。文言は固定の文字列だけを入れる */
function page(status: number, title: string, message: string): Response {
	const html = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} - Bobert</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.7}</style>
</head>
<body>
<h1>${title}</h1>
<p>${message}</p>
</body>
</html>
`;
	return new Response(html, {
		status,
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "no-store",
			// URLにcodeが含まれるので、ほかのサイトに渡さない
			"Referrer-Policy": "no-referrer",
		},
	});
}
