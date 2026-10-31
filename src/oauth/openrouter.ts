import type { APIUser } from "discord-api-types/v10";
import { randomToken, sha256Base64Url } from "../crypto";
import { createFollowupMessage } from "../discord/api";
import { MessageFlags } from "../discord/constants";
import { exchangeOpenRouterCode } from "../llm/openrouter";
import { logEvent } from "../log";
import { saveOAuthState, takeOAuthState } from "../store/oauth";
import { saveCredential } from "../store/users";
import { resultPage as page } from "./page";

/** OpenRouterとの連携(OAuth PKCE)のコールバックのパス */
export const OPENROUTER_CALLBACK_PATH = "/oauth/openrouter/callback";

const AUTH_URL = "https://openrouter.ai/auth";

/** 連携のリンクの有効期間。OpenRouterのcodeの有効期間(10分)に合わせる */
const AUTH_LINK_TTL_MS = 10 * 60_000;

/**
 * /setup で見せる、OpenRouterとの連携のリンクを作る
 * (仕様: docs/spec/llm-cost.md「資格情報の登録・保存・削除」)。
 * stateで、コールバックを受けたときに誰のキーとして保存するかを決める。
 * /setup のInteractionのトークンも一緒に保存し、連携が済んだら、それを使って本人に知らせる。
 */
export async function createOpenRouterAuthLink(
	env: Env,
	origin: string,
	user: APIUser,
	interactionToken: string,
): Promise<string> {
	const state = randomToken();
	const codeVerifier = randomToken();
	const now = Date.now();
	await saveOAuthState(
		env.DB,
		state,
		{ userId: user.id, codeVerifier, interactionToken },
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

/** OpenRouterからのコールバック: codeを本人のキーと交換し、暗号化して保存する。済んだらDiscordでも知らせる */
export async function handleOpenRouterCallback(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
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
	if (saved.interactionToken !== null) {
		ctx.waitUntil(notifyLinked(env, saved.userId, saved.interactionToken));
	}
	return page(
		200,
		"OpenRouterと連携しました",
		"Discordに戻って、Bobertにメンションして話しかけてみてください。このページは閉じてかまいません。",
	);
}

/**
 * 連携が済んだことを、/setup への追加の返信で、本人にメンションして知らせる。
 * /setup の返信と同じく、本人にだけ見える形にする。知らせられなくても連携は済んでいるので、記録だけ残す
 */
async function notifyLinked(
	env: Env,
	userId: string,
	interactionToken: string,
): Promise<void> {
	try {
		await createFollowupMessage(env.DISCORD_APPLICATION_ID, interactionToken, {
			content: `<@${userId}> OpenRouterとの連携が完了しました。`,
			flags: MessageFlags.Ephemeral,
			allowed_mentions: { users: [userId] },
		});
	} catch (error) {
		logEvent("oauth", "openrouter_link_notify_failed", {
			userId,
			error: error instanceof Error ? error.message : "unknown",
		});
	}
}
