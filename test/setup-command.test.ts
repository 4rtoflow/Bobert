import {
	createExecutionContext,
	waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ComponentType,
	InteractionResponseType,
	InteractionType,
	MessageFlags,
} from "../src/discord/constants";
import { handleInteraction } from "../src/interactions/handler";
import {
	getRegisteredProviders,
	loadCredential,
	saveCredential,
} from "../src/store/users";
import { ALICE } from "./fixtures";
import { type FetchCall, mockFetch, signedInteractionRequest } from "./helpers";

afterEach(() => {
	vi.restoreAllMocks();
});

/** サーバーの中で、userが起こしたInteraction */
function interaction(type: number, data: unknown, user = ALICE) {
	return {
		id: "1",
		application_id: env.DISCORD_APPLICATION_ID,
		type,
		token: "interaction-token",
		version: 1,
		guild_id: "900",
		channel_id: "800",
		member: {
			user,
			roles: [],
			joined_at: "2026-10-01T00:00:00.000Z",
			deaf: false,
			mute: false,
			flags: 0,
			permissions: "0",
		},
		data,
	};
}

/** Interactionを送り、応答と、裏で続けた処理が終わるのを待つ */
async function send(payload: unknown) {
	const ctx = createExecutionContext();
	const response = await handleInteraction(
		await signedInteractionRequest(payload),
		env,
		ctx,
	);
	await waitOnExecutionContext(ctx);
	// biome-ignore lint/suspicious/noExplicitAny: 応答の形はテストの中で確かめる
	return (await response.json()) as any;
}

/** キーの登録のモーダルの送信。ワークスペースIDの欄は、空なら空文字で届く */
function modalSubmit(apiKey: string, user = ALICE, workspaceId = "") {
	const input = (id: number, customId: string, value: string) => ({
		type: ComponentType.Label,
		id,
		component: {
			type: ComponentType.TextInput,
			id: id + 1,
			custom_id: customId,
			value,
		},
	});
	return interaction(
		InteractionType.ModalSubmit,
		{
			custom_id: "setup:anthropic",
			components: [
				input(1, "api_key", apiKey),
				input(3, "workspace_id", workspaceId),
			],
		},
		user,
	);
}

/** Anthropicのモデル一覧のAPIの、成功の応答 */
function modelsListed(): Response {
	return Response.json({
		data: [],
		has_more: false,
		first_id: null,
		last_id: null,
	});
}

/** AnthropicのAPIのエラーの応答 */
function anthropicError(status: number, type: string): Response {
	return Response.json(
		{ type: "error", error: { type, message: "test" } },
		{ status },
	);
}

/** Discordへの書き換え(保留にした応答の中身)を取り出す */
function editedContent(calls: FetchCall[]): string | undefined {
	const edit = calls.find((call) => call.url.hostname === "discord.com");
	return (edit?.body as { content?: string } | undefined)?.content;
}

describe("/setup", () => {
	it("登録の状態と、登録・連携のボタンを本人にだけ見せる", async () => {
		const body = await send(
			interaction(InteractionType.ApplicationCommand, {
				id: "10",
				name: "setup",
				type: 1,
			}),
		);

		expect(body.type).toBe(InteractionResponseType.ChannelMessageWithSource);
		expect(body.data.flags).toBe(MessageFlags.Ephemeral);
		expect(body.data.content).toContain("Anthropic: 未登録");
		const [anthropicButton, openRouterButton] =
			body.data.components[0].components;
		expect(anthropicButton.custom_id).toBe("setup:anthropic");

		// OpenRouterとの連携のリンク(OAuth PKCE)
		const link = new URL(openRouterButton.url);
		expect(link.origin + link.pathname).toBe("https://openrouter.ai/auth");
		expect(link.searchParams.get("callback_url")).toBe(
			"https://bobert.example/oauth/openrouter/callback",
		);
		expect(link.searchParams.get("code_challenge_method")).toBe("S256");
		const row = await env.DB.prepare(
			"SELECT user_id FROM oauth_states WHERE state = ?",
		)
			.bind(link.searchParams.get("state"))
			.first<{ user_id: string }>();
		expect(row?.user_id).toBe(ALICE.id);
	});

	it("ボタンを押すと、キーを入力するモーダルを開く", async () => {
		const body = await send(
			interaction(InteractionType.MessageComponent, {
				custom_id: "setup:anthropic",
				component_type: ComponentType.Button,
			}),
		);

		expect(body.type).toBe(InteractionResponseType.Modal);
		const [apiKeyField, workspaceField] = body.data.components;
		expect(apiKeyField.type).toBe(ComponentType.Label);
		expect(apiKeyField.component).toMatchObject({
			custom_id: "api_key",
			required: true,
		});
		expect(workspaceField.component).toMatchObject({
			custom_id: "workspace_id",
			required: false,
		});
	});

	it("入力されたキーが有効なら、暗号化して保存し、結果を知らせる", async () => {
		const calls = mockFetch(({ url }) =>
			url.hostname === "api.anthropic.com" ? modelsListed() : Response.json({}),
		);

		const body = await send(modalSubmit("sk-ant-valid"));

		// キーの確認には時間がかかるので、まず保留の応答を返す
		expect(body).toEqual({
			type: InteractionResponseType.DeferredChannelMessageWithSource,
			data: { flags: MessageFlags.Ephemeral },
		});
		const check = calls.find(
			(call) => call.url.hostname === "api.anthropic.com",
		);
		expect(check?.url.pathname).toBe("/v1/models");
		expect(check?.headers.get("authorization")).toBe("Bearer sk-ant-valid");
		// ワークスペースIDを入力しなければ、ヘッダーは付けない
		expect(check?.headers.get("anthropic-workspace-id")).toBeNull();
		expect(await loadCredential(env, ALICE.id, "anthropic")).toEqual({
			apiKey: "sk-ant-valid",
			workspaceId: null,
		});

		const edit = calls.find((call) => call.url.hostname === "discord.com");
		expect(edit?.method).toBe("PATCH");
		expect(edit?.url.pathname).toBe(
			`/api/v10/webhooks/${env.DISCORD_APPLICATION_ID}/interaction-token/messages/@original`,
		);
		expect(editedContent(calls)).toContain("登録しました");
	});

	it("キーが無効なら保存せず、そう知らせる", async () => {
		const user = { ...ALICE, id: "101" };
		const calls = mockFetch(({ url }) =>
			url.hostname === "api.anthropic.com"
				? anthropicError(401, "authentication_error")
				: Response.json({}),
		);

		await send(modalSubmit("sk-ant-invalid", user));

		expect(await getRegisteredProviders(env.DB, user.id)).toEqual(new Set());
		expect(editedContent(calls)).toContain("使えませんでした");
	});

	it("ワークスペースに属さないキーで、IDがなければ、IDが必要だと知らせる", async () => {
		const user = { ...ALICE, id: "105" };
		const calls = mockFetch(({ url }) =>
			url.hostname === "api.anthropic.com"
				? anthropicError(400, "invalid_request_error")
				: Response.json({}),
		);

		await send(modalSubmit("sk-ant-usr-test", user));

		expect(await getRegisteredProviders(env.DB, user.id)).toEqual(new Set());
		expect(editedContent(calls)).toContain("ワークスペースのIDも必要です");
	});

	it("ワークスペースIDを入力したら、ヘッダーで送り、キーと一緒に保存する", async () => {
		const user = { ...ALICE, id: "106" };
		const calls = mockFetch(({ url }) =>
			url.hostname === "api.anthropic.com" ? modelsListed() : Response.json({}),
		);

		await send(modalSubmit("sk-ant-usr-test", user, " wrkspc_01TEST "));

		const check = calls.find(
			(call) => call.url.hostname === "api.anthropic.com",
		);
		expect(check?.headers.get("anthropic-workspace-id")).toBe("wrkspc_01TEST");
		expect(await loadCredential(env, user.id, "anthropic")).toEqual({
			apiKey: "sk-ant-usr-test",
			workspaceId: "wrkspc_01TEST",
		});
		expect(editedContent(calls)).toContain("登録しました");
	});

	it("ワークスペースIDが見つからなければ、そう知らせる", async () => {
		const user = { ...ALICE, id: "107" };
		const calls = mockFetch(({ url }) =>
			url.hostname === "api.anthropic.com"
				? anthropicError(404, "not_found_error")
				: Response.json({}),
		);

		await send(modalSubmit("sk-ant-usr-test", user, "wrkspc_unknown"));

		expect(await getRegisteredProviders(env.DB, user.id)).toEqual(new Set());
		expect(editedContent(calls)).toContain("ワークスペースIDが正しくないか");
	});

	it("全角の文字や見えない文字が混ざっていても、整えてから確かめる", async () => {
		const user = { ...ALICE, id: "103" };
		const calls = mockFetch(({ url }) =>
			url.hostname === "api.anthropic.com"
				? Response.json({
						data: [],
						has_more: false,
						first_id: null,
						last_id: null,
					})
				: Response.json({}),
		);

		await send(modalSubmit(" ｓｋ-ant-ｖａｌｉｄ\u200b\n", user));

		const check = calls.find(
			(call) => call.url.hostname === "api.anthropic.com",
		);
		expect(check?.headers.get("authorization")).toBe("Bearer sk-ant-valid");
		expect((await loadCredential(env, user.id, "anthropic"))?.apiKey).toBe(
			"sk-ant-valid",
		);
	});

	it("整えても使えない文字が残るキーは、APIに送らずに知らせる", async () => {
		const user = { ...ALICE, id: "104" };
		const calls = mockFetch(() => Response.json({}));

		await send(modalSubmit("sk-ant-キー", user));

		expect(
			calls.some((call) => call.url.hostname === "api.anthropic.com"),
		).toBe(false);
		const edit = calls.find((call) => call.url.hostname === "discord.com");
		expect(edit?.body).toEqual({
			content: expect.stringContaining("使えない文字"),
		});
	});
});

describe("/delete", () => {
	it("確認のボタンを押すと、キーと設定を消す", async () => {
		const user = { ...ALICE, id: "102" };
		await saveCredential(env, user.id, "anthropic", {
			apiKey: "sk-ant-test",
			workspaceId: null,
		});

		const confirm = await send(
			interaction(
				InteractionType.ApplicationCommand,
				{ id: "11", name: "delete", type: 1 },
				user,
			),
		);
		expect(confirm.data.flags).toBe(MessageFlags.Ephemeral);
		expect(confirm.data.components[0].components[0].custom_id).toBe(
			"delete:confirm",
		);
		// 確かめるまでは消さない
		expect(await loadCredential(env, user.id, "anthropic")).not.toBeNull();

		const done = await send(
			interaction(
				InteractionType.MessageComponent,
				{ custom_id: "delete:confirm", component_type: ComponentType.Button },
				user,
			),
		);
		expect(done.type).toBe(InteractionResponseType.UpdateMessage);
		expect(await loadCredential(env, user.id, "anthropic")).toBeNull();
	});
});
