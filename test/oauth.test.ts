import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Base64Url } from "../src/crypto";
import {
	createOpenRouterAuthLink,
	handleOpenRouterCallback,
} from "../src/oauth/openrouter";
import { saveOAuthState } from "../src/store/oauth";
import { loadCredential } from "../src/store/users";
import { ALICE } from "./fixtures";
import { mockFetch } from "./helpers";

afterEach(() => {
	vi.restoreAllMocks();
});

function callback(query: string): Promise<Response> {
	return handleOpenRouterCallback(
		new Request(`https://bobert.example/oauth/openrouter/callback?${query}`),
		env,
	);
}

describe("OpenRouterとの連携", () => {
	it("戻ってきたcodeを本人のキーと交換し、暗号化して保存する", async () => {
		const link = new URL(
			await createOpenRouterAuthLink(env, "https://bobert.example", ALICE),
		);
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
			{ userId: ALICE.id, codeVerifier: "verifier" },
			now - 1,
			now - 600_001,
		);
		const calls = mockFetch(() => Response.json({ key: "sk-or-v1-test" }));

		const response = await callback("code=the-code&state=expired-state");

		expect(response.status).toBe(400);
		expect(calls).toEqual([]);
	});
});
