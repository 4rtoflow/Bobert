import {
	createExecutionContext,
	waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Base64Url } from "../src/crypto";
import { MessageFlags } from "../src/discord/constants";
import {
	createOpenRouterAuthLink,
	handleOpenRouterCallback,
} from "../src/oauth/openrouter";
import { saveOAuthState } from "../src/store/oauth";
import { loadCredential } from "../src/store/users";
import { ALICE } from "./fixtures";
import { mockFetch } from "./helpers";

/** /setup のInteractionのトークン */
const SETUP_TOKEN = "setup-interaction-token";

afterEach(() => {
	vi.restoreAllMocks();
});

/** コールバックを受け、応答と、裏で続けた処理(Discordで知らせる)が終わるのを待つ */
async function callback(query: string): Promise<Response> {
	const ctx = createExecutionContext();
	const response = await handleOpenRouterCallback(
		new Request(`https://bobert.example/oauth/openrouter/callback?${query}`),
		env,
		ctx,
	);
	await waitOnExecutionContext(ctx);
	return response;
}

/** /setup で連携のリンクを作る */
async function createLink(): Promise<URL> {
	return new URL(
		await createOpenRouterAuthLink(
			env,
			"https://bobert.example",
			ALICE,
			SETUP_TOKEN,
		),
	);
}

describe("OpenRouterとの連携", () => {
	it("戻ってきたcodeを本人のキーと交換し、暗号化して保存する", async () => {
		const link = await createLink();
		const state = link.searchParams.get("state") ?? "";
		const calls = mockFetch(() => Response.json({ key: "sk-or-v1-test" }));

		const response = await callback(`code=the-code&state=${state}`);

		expect(response.status).toBe(200);
		expect(await response.text()).toContain("OpenRouterと連携しました");
		expect(calls[0]?.url.href).toBe("https://openrouter.ai/api/v1/auth/keys");
		const exchange = calls[0]?.body as { code_verifier: string };
		expect(exchange).toEqual({
			code: "the-code",
			code_verifier: expect.any(String),
			code_challenge_method: "S256",
		});
		// リンクに入れたcode_challengeと、交換に使ったcode_verifierが対になっている
		expect(await sha256Base64Url(exchange.code_verifier)).toBe(
			link.searchParams.get("code_challenge"),
		);
		expect(await loadCredential(env, ALICE.id, "openrouter")).toEqual({
			apiKey: "sk-or-v1-test",
			workspaceId: null,
		});

		// 同じリンクは2回使えない
		const again = await callback(`code=the-code&state=${state}`);
		expect(again.status).toBe(400);
	});

	it("連携が済んだら、/setup への追加の返信で、本人にメンションして知らせる", async () => {
		const state = (await createLink()).searchParams.get("state") ?? "";
		const calls = mockFetch(() => Response.json({ key: "sk-or-v1-test" }));

		await callback(`code=the-code&state=${state}`);

		const notice = calls.find((call) => call.url.hostname === "discord.com");
		expect(notice?.method).toBe("POST");
		expect(notice?.url.pathname).toBe(
			`/api/v10/webhooks/${env.DISCORD_APPLICATION_ID}/${SETUP_TOKEN}`,
		);
		// /setup の返信と同じく、本人にだけ見える形にする
		expect(notice?.body).toEqual({
			content: `<@${ALICE.id}> OpenRouterとの連携が完了しました。`,
			flags: MessageFlags.Ephemeral,
			allowed_mentions: { users: [ALICE.id] },
		});
	});

	it("キーと交換できなければ、Discordでは知らせない", async () => {
		const state = (await createLink()).searchParams.get("state") ?? "";
		const calls = mockFetch(() => new Response(null, { status: 500 }));

		const response = await callback(`code=the-code&state=${state}`);

		expect(response.status).toBe(502);
		expect(calls.map((call) => call.url.hostname)).toEqual(["openrouter.ai"]);
	});

	it("キャンセルされて、codeなしで戻ってきたら、やり直しを案内する", async () => {
		const response = await callback("state=unknown");
		expect(response.status).toBe(400);
		expect(await response.text()).toContain("/setup からやり直してください");
	});

	it("有効期限が切れたリンクは使えない", async () => {
		const now = Date.now();
		await saveOAuthState(
			env.DB,
			"expired-state",
			{
				userId: ALICE.id,
				codeVerifier: "verifier",
				interactionToken: SETUP_TOKEN,
			},
			now - 1,
			now - 600_001,
		);
		const calls = mockFetch(() => Response.json({ key: "sk-or-v1-test" }));

		const response = await callback("code=the-code&state=expired-state");

		expect(response.status).toBe(400);
		expect(calls).toEqual([]);
	});
});
