import {
	createExecutionContext,
	waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { insertAgentChannel } from "../src/agent/store";
import {
	DELETE_GITHUB_NOTE,
	GITHUB_LINK_PROMPT,
	GITHUB_LINKED,
	GITHUB_PAGE_CANCELLED,
	GITHUB_PAGE_ERROR,
	GITHUB_PAGE_EXPIRED,
} from "../src/agent/texts";
import { sha256Base64Url } from "../src/crypto";
import {
	ApplicationCommandType,
	ComponentType,
	InteractionResponseType,
	InteractionType,
	MessageFlags,
} from "../src/discord/constants";
import {
	findAllowedRepository,
	gitHubAccessToken,
	openPullRequest,
} from "../src/github/account";
import {
	createGitHubAuthLink,
	handleGitHubCallback,
} from "../src/oauth/github";
import {
	type GitHubTokens,
	loadGitHubLink,
	saveGitHubLink,
	saveGitHubLinkState,
} from "../src/store/github";
import {
	type FetchCall,
	guildInteraction,
	mockFetch,
	sendInteraction,
	userFactory,
} from "./helpers";

const newUser = userFactory(63000);
const ORIGIN = "https://bobert.example";
const CALLBACK = `${ORIGIN}/oauth/github/callback`;
/** 「GitHubと連携」へのInteractionのトークン */
const BUTTON_TOKEN = "github-button-token";
const HOUR = 60 * 60_000;

afterEach(() => {
	vi.restoreAllMocks();
});

/** コールバックを受け、応答と、裏で続けた処理(Discordで知らせる)が終わるのを待つ */
async function callback(query: string): Promise<Response> {
	const ctx = createExecutionContext();
	const response = await handleGitHubCallback(
		new Request(`${CALLBACK}?${query}`),
		env,
		ctx,
	);
	await waitOnExecutionContext(ctx);
	return response;
}

/** 連携のリンクを作り、そのURLを返す */
async function createLink(userId: string): Promise<URL> {
	return new URL(await createGitHubAuthLink(env, ORIGIN, userId, BUTTON_TOKEN));
}

/** GitHubがトークンを発行したときの応答 */
function issuedTokens(accessToken: string, refreshToken: string): Response {
	return Response.json({
		access_token: accessToken,
		expires_in: 28800,
		refresh_token: refreshToken,
		refresh_token_expires_in: 15897600,
		scope: "",
		token_type: "bearer",
	});
}

/** トークンの発行や更新で送った本文 */
function formOf(call: FetchCall | undefined): Map<string, string> {
	return new Map(Object.entries((call?.body ?? {}) as Record<string, string>));
}

function tokenCalls(calls: FetchCall[]): FetchCall[] {
	return calls.filter(
		(call) => call.url.href === "https://github.com/login/oauth/access_token",
	);
}

/** 保存する、期限の切れていないトークン */
function freshTokens(accessToken = "ghu_fresh"): GitHubTokens {
	return {
		accessToken,
		refreshToken: "ghr_fresh",
		expiresAt: Date.now() + 8 * HOUR,
		refreshExpiresAt: Date.now() + 1000 * HOUR,
	};
}

/** 本人が許可したリポジトリを返す、GitHubのAPIの偽物 */
function installationsApi(
	call: FetchCall,
	repositories: string[] = ["octocat/hello"],
): Response | null {
	if (call.url.pathname === "/user/installations") {
		return Response.json({
			total_count: 1,
			installations: [{ id: 11, account: { login: "octocat" } }],
		});
	}
	if (call.url.pathname === "/user/installations/11/repositories") {
		return Response.json({
			total_count: repositories.length,
			repositories: repositories.map((fullName) => ({
				full_name: fullName,
				default_branch: "main",
			})),
		});
	}
	return null;
}

describe("GitHubとの連携のリンク", () => {
	it("「GitHubと連携」を押すと、承認の画面へのリンクを、本人にだけ見せる", async () => {
		const owner = await newUser("anthropic");
		await insertAgentChannel(env.DB, {
			channelId: "63101",
			guildId: "900",
			ownerId: owner.id,
			number: 1,
			sessionId: "sesn_1",
			createdAt: Date.now(),
		});

		const response = await sendInteraction({
			...guildInteraction(
				InteractionType.MessageComponent,
				{ custom_id: "agent:github", component_type: ComponentType.Button },
				owner,
			),
			channel_id: "63101",
			channel: { id: "63101", type: 0 },
		});

		expect(response.type).toBe(
			InteractionResponseType.ChannelMessageWithSource,
		);
		expect(response.data.flags).toBe(MessageFlags.Ephemeral);
		expect(response.data.content).toBe(GITHUB_LINK_PROMPT);
		const button = response.data.components[0].components[0];
		expect(button).toMatchObject({ style: 5, label: "GitHubを開く" });
		const link = new URL(button.url);
		expect(`${link.origin}${link.pathname}`).toBe(
			"https://github.com/login/oauth/authorize",
		);
		expect(link.searchParams.get("client_id")).toBe("Iv23test");
		// コールバックのURLは、Interactionを受けたWorkerのURLから作る
		expect(link.searchParams.get("redirect_uri")).toBe(CALLBACK);
		expect(link.searchParams.get("state")).toBeTruthy();
		expect(link.searchParams.get("code_challenge_method")).toBe("S256");
	});

	it("/agent の返事に付けたボタン(エージェントのチャンネルの外)を押しても、連携のリンクを見せる", async () => {
		const owner = await newUser("anthropic");

		const response = await sendInteraction({
			...guildInteraction(
				InteractionType.MessageComponent,
				{ custom_id: "agent:github", component_type: ComponentType.Button },
				owner,
			),
			channel_id: "63150",
			channel: { id: "63150", type: 0 },
		});

		expect(response.type).toBe(
			InteractionResponseType.ChannelMessageWithSource,
		);
		expect(response.data.flags).toBe(MessageFlags.Ephemeral);
		expect(response.data.content).toBe(GITHUB_LINK_PROMPT);
		const link = new URL(response.data.components[0].components[0].url);
		expect(`${link.origin}${link.pathname}`).toBe(
			"https://github.com/login/oauth/authorize",
		);
	});

	it("戻ってきたcodeをトークンと交換して暗号化して保存し、「GitHubと連携」への返事を書き換える", async () => {
		const owner = await newUser("anthropic");
		const link = await createLink(owner.id);
		const state = link.searchParams.get("state") ?? "";
		const calls = mockFetch((call) => {
			if (call.url.hostname === "github.com") {
				return issuedTokens("ghu_new", "ghr_new");
			}
			return installationsApi(call) ?? Response.json({});
		});

		const response = await callback(
			`code=the-code&state=${state}&installation_id=11&setup_action=install`,
		);

		expect(response.status).toBe(200);
		expect(await response.text()).toContain("GitHubと連携しました");
		const exchange = formOf(tokenCalls(calls)[0]);
		expect(exchange.get("client_id")).toBe("Iv23test");
		expect(exchange.get("client_secret")).toBe("test-github-client-secret");
		expect(exchange.get("code")).toBe("the-code");
		expect(exchange.get("redirect_uri")).toBe(CALLBACK);
		// リンクに入れたcode_challengeと、交換に使ったcode_verifierが対になっている
		expect(await sha256Base64Url(exchange.get("code_verifier") ?? "")).toBe(
			link.searchParams.get("code_challenge"),
		);
		const saved = await loadGitHubLink(env, owner.id);
		expect(saved).toMatchObject({
			accessToken: "ghu_new",
			refreshToken: "ghr_new",
			version: 1,
		});
		expect(saved?.expiresAt).toBeGreaterThan(Date.now() + 7 * HOUR);
		// D1には暗号化して入れる
		const row = await env.DB.prepare(
			"SELECT ciphertext FROM github_links WHERE user_id = ?",
		)
			.bind(owner.id)
			.first<{ ciphertext: string }>();
		expect(row?.ciphertext).not.toContain("ghu_new");
		// 「GitHubと連携」への返事を書き換える
		const notice = calls.find(
			(call) =>
				call.method === "PATCH" &&
				call.url.pathname ===
					`/api/v10/webhooks/${env.DISCORD_APPLICATION_ID}/${BUTTON_TOKEN}/messages/@original`,
		);
		expect(notice?.body).toEqual({ content: GITHUB_LINKED, components: [] });
		// リポジトリは、/agent で始めるセッションにつなぐので、エージェントのチャンネルのメッセージは触らない
		expect(
			calls.some((call) => call.url.pathname.startsWith("/api/v10/channels/")),
		).toBe(false);

		// 同じリンクは2回使えない
		const again = await callback(`code=the-code&state=${state}`);
		expect(again.status).toBe(400);
		expect(await again.text()).toContain(GITHUB_PAGE_EXPIRED);
	});

	it("承認したが、まだアプリを入れていなければ、アプリを入れる画面へ進め、戻ってきたら保存する", async () => {
		const owner = await newUser("anthropic");
		const link = await createLink(owner.id);
		const state = link.searchParams.get("state") ?? "";
		let installed = false;
		const calls = mockFetch((call) => {
			if (call.url.hostname === "github.com") {
				return issuedTokens(
					installed ? "ghu_installed" : "ghu_authorized",
					"ghr_x",
				);
			}
			if (call.url.pathname === "/user/installations") {
				return Response.json({
					total_count: installed ? 1 : 0,
					installations: installed
						? [{ id: 11, account: { login: "octocat" } }]
						: [],
				});
			}
			return Response.json({});
		});

		const first = await callback(`code=authorize-code&state=${state}`);

		expect(first.status).toBe(302);
		const install = new URL(first.headers.get("Location") ?? "");
		expect(`${install.origin}${install.pathname}`).toBe(
			"https://github.com/apps/bobert-test/installations/new",
		);
		expect(install.searchParams.get("state")).toBe(state);
		expect(await loadGitHubLink(env, owner.id)).toBeNull();

		// アプリを入れると、GitHubがcodeと同じstateを付けて戻す
		installed = true;
		const second = await callback(
			`code=install-code&state=${state}&installation_id=11&setup_action=install`,
		);

		expect(second.status).toBe(200);
		// アプリを入れる画面からの戻りは、PKCEもredirect_uriも使わない
		const exchange = formOf(tokenCalls(calls).at(-1));
		expect(exchange.get("code")).toBe("install-code");
		expect(exchange.has("code_verifier")).toBe(false);
		expect(exchange.has("redirect_uri")).toBe(false);
		expect((await loadGitHubLink(env, owner.id))?.accessToken).toBe(
			"ghu_installed",
		);
	});

	it("アプリを入れる画面からも、入れずに戻ってきたら、保存しない", async () => {
		const owner = await newUser("anthropic");
		const now = Date.now();
		await saveGitHubLinkState(env.DB, "install-state", {
			userId: owner.id,
			interactionToken: BUTTON_TOKEN,
			stage: "install",
			codeVerifier: null,
			expiresAt: now + 60_000,
			createdAt: now,
		});
		mockFetch((call) =>
			call.url.hostname === "github.com"
				? issuedTokens("ghu_x", "ghr_x")
				: Response.json({ total_count: 0, installations: [] }),
		);

		const response = await callback("code=c&state=install-state");

		expect(response.status).toBe(400);
		expect(await response.text()).toContain(GITHUB_PAGE_CANCELLED);
		expect(await loadGitHubLink(env, owner.id)).toBeNull();
	});

	it("キャンセルされて、codeなしで戻ってきたら、やり直しを案内する", async () => {
		const response = await callback("error=access_denied&state=unknown");
		expect(response.status).toBe(400);
		expect(await response.text()).toContain(GITHUB_PAGE_CANCELLED);
	});

	it("有効期限が切れたリンクは使えない", async () => {
		const owner = await newUser("anthropic");
		const now = Date.now();
		await saveGitHubLinkState(
			env.DB,
			"expired-state",
			{
				userId: owner.id,
				interactionToken: BUTTON_TOKEN,
				stage: "authorize",
				codeVerifier: "verifier",
				expiresAt: now - 1,
				createdAt: now - 600_001,
			},
			now - 600_001,
		);
		const calls = mockFetch(() => issuedTokens("ghu_x", "ghr_x"));

		const response = await callback("code=c&state=expired-state");

		expect(response.status).toBe(400);
		expect(await response.text()).toContain(GITHUB_PAGE_EXPIRED);
		expect(calls).toEqual([]);
	});

	it("トークンと交換できなければ、エラーのページを出し、保存しない", async () => {
		const owner = await newUser("anthropic");
		const state = (await createLink(owner.id)).searchParams.get("state") ?? "";
		mockFetch(() =>
			Response.json({
				error: "bad_verification_code",
				error_description: "The code passed is incorrect or expired.",
			}),
		);

		const response = await callback(`code=wrong&state=${state}`);

		expect(response.status).toBe(502);
		expect(await response.text()).toContain(GITHUB_PAGE_ERROR);
		expect(await loadGitHubLink(env, owner.id)).toBeNull();
	});
});

describe("GitHubのトークン", () => {
	it("期限が近ければ、更新用のトークンで更新して、入れ替える", async () => {
		const owner = await newUser("anthropic");
		await saveGitHubLink(env, owner.id, {
			accessToken: "ghu_old",
			refreshToken: "ghr_old",
			expiresAt: Date.now() + 60_000,
			refreshExpiresAt: Date.now() + 1000 * HOUR,
		});
		const calls = mockFetch(() => issuedTokens("ghu_new", "ghr_new"));

		const token = await gitHubAccessToken(env, owner.id, 5 * 60_000);

		expect(token).toMatchObject({ value: "ghu_new", version: 2 });
		const refresh = formOf(tokenCalls(calls)[0]);
		expect(refresh.get("grant_type")).toBe("refresh_token");
		expect(refresh.get("refresh_token")).toBe("ghr_old");
		expect(await loadGitHubLink(env, owner.id)).toMatchObject({
			accessToken: "ghu_new",
			refreshToken: "ghr_new",
			version: 2,
		});
	});

	it("期限まで余裕があれば、更新しない", async () => {
		const owner = await newUser("anthropic");
		await saveGitHubLink(env, owner.id, freshTokens());
		const calls = mockFetch(() => issuedTokens("ghu_new", "ghr_new"));

		const token = await gitHubAccessToken(env, owner.id, 5 * 60_000);

		expect(token?.value).toBe("ghu_fresh");
		expect(calls).toEqual([]);
	});

	it("更新用のトークンが使えなければ(GitHubで外された)、連携を消す", async () => {
		const owner = await newUser("anthropic");
		await saveGitHubLink(env, owner.id, {
			accessToken: "ghu_old",
			refreshToken: "ghr_revoked",
			expiresAt: Date.now() - 1,
			refreshExpiresAt: Date.now() + 1000 * HOUR,
		});
		mockFetch(() => Response.json({ error: "bad_refresh_token" }));

		expect(await gitHubAccessToken(env, owner.id, 5 * 60_000)).toBeNull();
		expect(await loadGitHubLink(env, owner.id)).toBeNull();
	});

	it("更新に失敗しても、ほかの処理が先に更新していれば、そのトークンを使う", async () => {
		const owner = await newUser("anthropic");
		await saveGitHubLink(env, owner.id, {
			accessToken: "ghu_old",
			refreshToken: "ghr_used",
			expiresAt: Date.now() - 1,
			refreshExpiresAt: Date.now() + 1000 * HOUR,
		});
		mockFetch(async () => {
			// ほかのチャンネルが、同じ更新用のトークンで先に更新した
			await saveGitHubLink(env, owner.id, freshTokens("ghu_other"));
			return Response.json({ error: "bad_refresh_token" });
		});

		const token = await gitHubAccessToken(env, owner.id, 5 * 60_000);

		expect(token?.value).toBe("ghu_other");
		expect((await loadGitHubLink(env, owner.id))?.accessToken).toBe(
			"ghu_other",
		);
	});
});

describe("許可されたリポジトリ", () => {
	it("本人が許可したリポジトリを、名前で探す(大文字と小文字は区別しない)", async () => {
		const owner = await newUser("anthropic");
		await saveGitHubLink(env, owner.id, freshTokens());
		const calls = mockFetch(
			(call) =>
				installationsApi(call, ["Octocat/Hello", "octocat/world"]) ??
				new Response(null, { status: 404 }),
		);

		const found = await findAllowedRepository(
			env,
			owner.id,
			"octocat/hello",
			5 * 60_000,
		);
		const missing = await findAllowedRepository(
			env,
			owner.id,
			"octocat/secret",
			5 * 60_000,
		);

		expect(found).toMatchObject({
			status: "found",
			repository: { fullName: "Octocat/Hello", defaultBranch: "main" },
			token: { value: "ghu_fresh" },
		});
		expect(missing).toEqual({
			status: "not_allowed",
			allowed: ["Octocat/Hello", "octocat/world"],
		});
		expect(calls[0]?.headers.get("Authorization")).toBe("Bearer ghu_fresh");
		expect(calls[0]?.headers.get("User-Agent")).toContain("Bobert");
	});

	it("トークンが断られたら(401)、更新してもう一度試す", async () => {
		const owner = await newUser("anthropic");
		await saveGitHubLink(env, owner.id, freshTokens("ghu_rejected"));
		mockFetch((call) => {
			if (call.url.hostname === "github.com") {
				return issuedTokens("ghu_refreshed", "ghr_refreshed");
			}
			if (call.headers.get("Authorization") === "Bearer ghu_rejected") {
				return Response.json({ message: "Bad credentials" }, { status: 401 });
			}
			return installationsApi(call) ?? new Response(null, { status: 404 });
		});

		const found = await findAllowedRepository(
			env,
			owner.id,
			"octocat/hello",
			5 * 60_000,
		);

		expect(found).toMatchObject({
			status: "found",
			token: { value: "ghu_refreshed" },
		});
	});

	it("承認が取り消されていたら(401のあと更新もできない)、連携を消す", async () => {
		const owner = await newUser("anthropic");
		await saveGitHubLink(env, owner.id, freshTokens());
		mockFetch((call) =>
			call.url.hostname === "github.com"
				? Response.json({ error: "bad_refresh_token" })
				: Response.json({ message: "Bad credentials" }, { status: 401 }),
		);

		const result = await findAllowedRepository(
			env,
			owner.id,
			"octocat/hello",
			5 * 60_000,
		);

		expect(result).toEqual({ status: "unlinked" });
		expect(await loadGitHubLink(env, owner.id)).toBeNull();
	});

	it("アプリがどこにも入っていなければ(GitHubで外された)、連携を消す", async () => {
		const owner = await newUser("anthropic");
		await saveGitHubLink(env, owner.id, freshTokens());
		mockFetch(() => Response.json({ total_count: 0, installations: [] }));

		const result = await findAllowedRepository(
			env,
			owner.id,
			"octocat/hello",
			5 * 60_000,
		);

		expect(result).toEqual({ status: "unlinked" });
		expect(await loadGitHubLink(env, owner.id)).toBeNull();
	});

	it("連携していなければ、GitHubを呼ばない", async () => {
		const owner = await newUser("anthropic");
		const calls = mockFetch(() => Response.json({}));

		expect(
			await findAllowedRepository(env, owner.id, "octocat/hello", 60_000),
		).toEqual({ status: "unlinked" });
		expect(calls).toEqual([]);
	});
});

describe("PRを作る", () => {
	it("本人のトークンでPRを作り、URLを返す", async () => {
		const owner = await newUser("anthropic");
		await saveGitHubLink(env, owner.id, freshTokens());
		const calls = mockFetch(() =>
			Response.json(
				{ html_url: "https://github.com/octocat/hello/pull/3" },
				{ status: 201 },
			),
		);

		const outcome = await openPullRequest(env, owner.id, {
			repository: "octocat/hello",
			head: "fix/login-error",
			base: "main",
			title: "直す",
			body: "説明",
		});

		expect(outcome).toEqual({
			status: "created",
			url: "https://github.com/octocat/hello/pull/3",
		});
		expect(calls[0]?.method).toBe("POST");
		expect(calls[0]?.url.href).toBe(
			"https://api.github.com/repos/octocat/hello/pulls",
		);
		expect(calls[0]?.body).toEqual({
			title: "直す",
			head: "fix/login-error",
			base: "main",
			body: "説明",
		});
	});

	it("GitHubに断られたら、その理由を返す", async () => {
		const owner = await newUser("anthropic");
		await saveGitHubLink(env, owner.id, freshTokens());
		mockFetch(() =>
			Response.json(
				{
					message: "Validation Failed",
					errors: [
						{
							resource: "PullRequest",
							code: "custom",
							message: "A pull request already exists for octocat:fix.",
						},
					],
				},
				{ status: 422 },
			),
		);

		const outcome = await openPullRequest(env, owner.id, {
			repository: "octocat/hello",
			head: "fix",
			base: "main",
			title: "直す",
			body: "",
		});

		expect(outcome).toEqual({
			status: "failed",
			reason:
				"Validation Failed: A pull request already exists for octocat:fix.",
		});
	});
});

describe("/delete とGitHub", () => {
	it("確認で、GitHubとの連携も外すことを書き、消したらGitHubの側の承認も取り消す", async () => {
		const owner = await newUser("anthropic");
		await saveGitHubLink(env, owner.id, freshTokens());
		const command = await sendInteraction(
			guildInteraction(
				InteractionType.ApplicationCommand,
				{ id: "64", name: "delete", type: ApplicationCommandType.ChatInput },
				owner,
			),
		);
		expect(command.data.content).toBe(
			`登録したAPIキー(AnthropicとOpenRouter)と設定を、すべて削除します。${DELETE_GITHUB_NOTE}よろしいですか?`,
		);
		const calls = mockFetch(() => new Response(null, { status: 204 }));

		const done = await sendInteraction(
			guildInteraction(
				InteractionType.MessageComponent,
				{ custom_id: "delete:confirm", component_type: ComponentType.Button },
				owner,
			),
		);

		expect(done.type).toBe(InteractionResponseType.UpdateMessage);
		expect(await loadGitHubLink(env, owner.id)).toBeNull();
		const revoke = calls.find((call) => call.url.hostname === "api.github.com");
		expect(revoke?.method).toBe("DELETE");
		expect(revoke?.url.pathname).toBe("/applications/Iv23test/grant");
		expect(revoke?.headers.get("Authorization")).toBe(
			`Basic ${btoa("Iv23test:test-github-client-secret")}`,
		);
		expect(revoke?.body).toEqual({ access_token: "ghu_fresh" });
	});

	it("連携していなければ、確認にGitHubのことを書かない", async () => {
		const owner = await newUser("anthropic");

		const command = await sendInteraction(
			guildInteraction(
				InteractionType.ApplicationCommand,
				{ id: "64", name: "delete", type: ApplicationCommandType.ChatInput },
				owner,
			),
		);

		expect(command.data.content).not.toContain("GitHub");
	});
});
