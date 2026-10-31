import {
	GITHUB_LINKED,
	GITHUB_PAGE_CANCELLED,
	GITHUB_PAGE_ERROR,
	GITHUB_PAGE_EXPIRED,
	GITHUB_PAGE_FAILED_TITLE,
	GITHUB_PAGE_LINKED,
	GITHUB_PAGE_LINKED_TITLE,
} from "../agent/texts";
import { randomToken, sha256Base64Url } from "../crypto";
import { editOriginalInteractionResponse } from "../discord/api";
import { exchangeGitHubCode, listInstallations } from "../github/api";
import { logEvent } from "../log";
import {
	type GitHubLinkState,
	type GitHubTokens,
	saveGitHubLink,
	saveGitHubLinkState,
	takeGitHubLinkState,
} from "../store/github";
import { resultPage } from "./page";

/** GitHubとの連携(Bobert用のGitHub App)のコールバックのパス */
export const GITHUB_CALLBACK_PATH = "/oauth/github/callback";

/** 承認の画面(OAuthのWebアプリケーションフロー) */
const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";

/** 連携のリンクの有効期間(OpenRouterとの連携と同じ10分) */
const LINK_TTL_MS = 10 * 60_000;

/**
 * 「GitHubと連携」のボタンで見せる、連携のリンクを作る(仕様: docs/spec/llm-cost.md「資格情報の登録・保存・削除」)。
 * リンクの先は、承認の画面。まだアプリを入れていない人は、承認の後に、アプリを入れる画面(触らせるリポジトリを選ぶ画面)へ進める。
 * 先にアプリを入れる画面へ送らないのは、すでにアプリを入れている人が、その画面からBobertに戻ってこないため
 * (アプリの設定を変えても、GitHubはコールバックへ戻さない)。
 * stateで、戻ってきたときに誰のトークンとして保存するかを決める。
 * ボタンへの返事のInteractionのトークンも一緒に保存し、連携できたら、その返事を書き換えて知らせる
 */
export async function createGitHubAuthLink(
	env: Env,
	origin: string,
	userId: string,
	interactionToken: string,
	now = Date.now(),
): Promise<string> {
	const state = randomToken();
	const codeVerifier = randomToken();
	await saveGitHubLinkState(
		env.DB,
		state,
		{
			userId,
			interactionToken,
			stage: "authorize",
			codeVerifier,
			expiresAt: now + LINK_TTL_MS,
			createdAt: now,
		},
		now,
	);
	const url = new URL(AUTHORIZE_URL);
	url.searchParams.set("client_id", env.GITHUB_APP_CLIENT_ID);
	url.searchParams.set("redirect_uri", callbackUrl(origin));
	url.searchParams.set("state", state);
	url.searchParams.set("code_challenge", await sha256Base64Url(codeVerifier));
	url.searchParams.set("code_challenge_method", "S256");
	return url.toString();
}

/**
 * GitHubからのコールバック: codeをトークンと交換し、暗号化して保存する。
 * - 承認の画面から戻ってきたが、まだアプリをどこにも入れていない: 同じstateで、アプリを入れる画面へ進める。
 *   アプリを入れると(「Request user authorization (OAuth) during installation」により)、GitHubがcodeとstateを付けて、またここへ戻す
 * - 済んだら、ボタンへの返事を「GitHubと連携しました。」に書き換える
 */
export async function handleGitHubCallback(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
): Promise<Response> {
	const url = new URL(request.url);
	const code = url.searchParams.get("code");
	const state = url.searchParams.get("state");
	if (!code || !state) {
		return failurePage(400, GITHUB_PAGE_CANCELLED);
	}
	const saved = await takeGitHubLinkState(env.DB, state);
	if (saved === null) {
		return failurePage(400, GITHUB_PAGE_EXPIRED);
	}

	let tokens: GitHubTokens;
	let installed: boolean;
	try {
		tokens = await exchangeGitHubCode(env, code, {
			codeVerifier: saved.codeVerifier,
			// 承認の画面へは、redirect_uriを付けて送ったので、交換でも同じものを送る
			redirectUri: saved.stage === "authorize" ? callbackUrl(url.origin) : null,
		});
		installed = (await listInstallations(tokens.accessToken)).length > 0;
	} catch (error) {
		logEvent("oauth", "github_link_failed", {
			userId: saved.userId,
			error: error instanceof Error ? error.name : "unknown",
		});
		return failurePage(502, GITHUB_PAGE_ERROR);
	}

	if (!installed) {
		if (saved.stage === "authorize") {
			// 承認はしたが、まだアプリを入れていない。アプリを入れる画面へ進める(リンクの期限はそのまま)
			await saveGitHubLinkState(env.DB, state, {
				...saved,
				stage: "install",
				codeVerifier: null,
			});
			return redirect(installUrl(env, state));
		}
		// アプリを入れる画面からも、入れずに戻ってきた
		logEvent("oauth", "github_link_not_installed", { userId: saved.userId });
		return failurePage(400, GITHUB_PAGE_CANCELLED);
	}

	await saveGitHubLink(env, saved.userId, tokens);
	logEvent("oauth", "github_linked", { userId: saved.userId });
	ctx.waitUntil(afterLinked(env, saved));
	return resultPage(200, GITHUB_PAGE_LINKED_TITLE, GITHUB_PAGE_LINKED);
}

/**
 * 連携できたことを、ボタンへの返事(本人にだけ見える)を書き換えて知らせる。
 * 知らせられなくても連携は済んでいるので、記録だけ残す
 */
async function afterLinked(env: Env, saved: GitHubLinkState): Promise<void> {
	try {
		await editOriginalInteractionResponse(
			env.DISCORD_APPLICATION_ID,
			saved.interactionToken,
			{ content: GITHUB_LINKED, components: [] },
		);
	} catch (error) {
		logEvent("oauth", "github_link_notify_failed", {
			userId: saved.userId,
			error: error instanceof Error ? error.message : "unknown",
		});
	}
}

/** アプリを入れる画面(触らせるリポジトリを選ぶ画面)。stateは、戻ってくるときにGitHubがそのまま付ける */
function installUrl(env: Env, state: string): string {
	const url = new URL(
		`https://github.com/apps/${encodeURIComponent(env.GITHUB_APP_SLUG)}/installations/new`,
	);
	url.searchParams.set("state", state);
	return url.toString();
}

function callbackUrl(origin: string): string {
	return `${origin}${GITHUB_CALLBACK_PATH}`;
}

function redirect(location: string): Response {
	return new Response(null, {
		status: 302,
		headers: {
			Location: location,
			"Cache-Control": "no-store",
			// URLにcodeが含まれるので、ほかのサイトに渡さない
			"Referrer-Policy": "no-referrer",
		},
	});
}

function failurePage(status: number, message: string): Response {
	return resultPage(status, GITHUB_PAGE_FAILED_TITLE, message);
}
