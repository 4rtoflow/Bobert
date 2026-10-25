import { env } from "cloudflare:workers";
import type { APIUser } from "discord-api-types/v10";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MODEL_CANDIDATES } from "../src/config/models";
import {
	ComponentType,
	InteractionResponseType,
	InteractionType,
	MessageFlags,
} from "../src/discord/constants";
import { describeCandidate } from "../src/interactions/model";
import { clearModelInfoCache } from "../src/llm/model-info";
import { getUserSettings, updateUserSettings } from "../src/store/users";
import {
	editedMessage,
	guildInteraction,
	mockFetch,
	mockModelApis,
	sendInteraction,
	userFactory,
} from "./helpers";

afterEach(() => {
	vi.restoreAllMocks();
	clearModelInfoCache();
});

/** 資格情報を登録した、新しいユーザー(テストごとに別の人にする) */
const userWith = userFactory(300);

function modelCommand(user: APIUser) {
	return guildInteraction(
		InteractionType.ApplicationCommand,
		{ id: "12", name: "model", type: 1 },
		user,
	);
}

/** セレクトメニューでvalueを選ぶ */
function select(user: APIUser, value: string) {
	return guildInteraction(
		InteractionType.MessageComponent,
		{
			custom_id: "model:select",
			component_type: ComponentType.StringSelect,
			values: [value],
		},
		user,
	);
}

/** 「その他」のモーダルで、モデルIDを送る */
function submitModelId(user: APIUser, modelId: string) {
	return guildInteraction(
		InteractionType.ModalSubmit,
		{
			custom_id: "model:custom",
			components: [
				{
					type: ComponentType.Label,
					id: 1,
					component: {
						type: ComponentType.TextInput,
						id: 2,
						custom_id: "model_id",
						value: modelId,
					},
				},
			],
		},
		user,
	);
}

describe("/model", () => {
	it("キーを登録していなければ、メニューの代わりに登録を案内する", async () => {
		const body = await sendInteraction(modelCommand(await userWith()));

		expect(body.type).toBe(InteractionResponseType.ChannelMessageWithSource);
		expect(body.data.flags).toBe(MessageFlags.Ephemeral);
		expect(body.data.content).toContain("`/setup`");
		expect(body.data.components).toEqual([]);
	});

	it("OpenRouterと連携していれば、候補の20個と「その他」を、今のモデルを選んだ状態で出す", async () => {
		const body = await sendInteraction(
			modelCommand(await userWith("openrouter")),
		);

		expect(body.data.flags).toBe(MessageFlags.Ephemeral);
		expect(body.data.content).toBe("使うモデルを選んでください。");
		const menu = body.data.components[0].components[0];
		expect(menu).toMatchObject({
			type: ComponentType.StringSelect,
			custom_id: "model:select",
			placeholder: "モデルを選ぶ",
		});
		expect(menu.options).toHaveLength(21);
		expect(menu.options[0]).toEqual({
			label: "Claude Haiku 5.5(既定)",
			value: "claude-haiku-5.5",
			description: "$0.10 / $0.50(入力が10万トークンを超えると 0.50 / 2.50)",
			default: true,
		});
		expect(menu.options.at(-1)).toEqual({
			label: "その他",
			value: "custom",
			description: "モデルIDを入力する(例: openai/gpt-6.1-sol)",
		});
		expect(
			menu.options.filter((option: { default?: boolean }) => option.default),
		).toHaveLength(1);
	});

	it("Anthropicのキーだけなら、Claudeの4つと「その他」だけを出す", async () => {
		const body = await sendInteraction(
			modelCommand(await userWith("anthropic")),
		);

		const menu = body.data.components[0].components[0];
		expect(
			menu.options.map((option: { value: string }) => option.value),
		).toEqual([
			"claude-haiku-5.5",
			"claude-sonnet-5.5",
			"claude-opus-5.5",
			"claude-fable-5.1",
			"custom",
		]);
	});

	it("「その他」のモデルを使っていれば、どの選択肢も選んでいない状態で出す", async () => {
		const user = await userWith("openrouter");
		await updateUserSettings(env.DB, user.id, {
			modelKey: "custom",
			customModelId: "openai/gpt-6.1-sol",
		});

		const body = await sendInteraction(modelCommand(user));

		expect(body.data.content).toBe("使うモデルを選んでください。");
		const menu = body.data.components[0].components[0];
		expect(
			menu.options.some((option: { default?: boolean }) => option.default),
		).toBe(false);
	});

	it("選択肢の説明は、価格と備考を書き、Discordの上限(100文字)に収まる", () => {
		const descriptions = MODEL_CANDIDATES.map(describeCandidate);
		expect(descriptions).toContain("$2 / $10");
		expect(descriptions).toContain("$1.40 / $4.40(画像を読めない)");
		expect(descriptions).toContain("$0.435 / $0.87");
		for (const description of descriptions) {
			expect(description.length).toBeLessThanOrEqual(100);
		}
	});

	it("メニューで選んだモデルを保存し、メニューのメッセージを結果に書き換える", async () => {
		const user = await userWith("openrouter");
		const calls = mockModelApis([]);

		const body = await sendInteraction(select(user, "gpt-6-luna"));

		// 思考の深さを確かめることがあるので、まず保留の応答を返す
		expect(body).toEqual({
			type: InteractionResponseType.DeferredMessageUpdate,
		});
		expect(editedMessage(calls)).toEqual({
			content: "使うモデルを「GPT-6 Luna」に変えました。",
			components: [],
		});
		expect((await getUserSettings(env.DB, user.id)).modelKey).toBe(
			"gpt-6-luna",
		);
		// 思考の深さを設定していなければ、モデル情報は取得しない
		expect(calls.some((call) => call.url.hostname === "openrouter.ai")).toBe(
			false,
		);
	});

	it("登録した資格情報で使えないモデルなら保存せず、必要な登録を案内する", async () => {
		const user = await userWith("anthropic");
		const calls = mockModelApis([]);

		await sendInteraction(select(user, "gpt-6-luna"));

		expect(editedMessage(calls)?.content).toContain("OpenRouterとの連携が必要");
		expect((await getUserSettings(env.DB, user.id)).modelKey).toBeNull();
	});

	it("保存した思考の深さを新しいモデルで選べなければ、既定に戻す", async () => {
		const user = await userWith("openrouter");
		await updateUserSettings(env.DB, user.id, { effort: "medium" });
		const calls = mockModelApis([
			{
				id: "z-ai/glm-5.3",
				efforts: ["max", "high", "low"],
				defaultEffort: "max",
			},
		]);

		await sendInteraction(select(user, "glm-5.3"));

		const settings = await getUserSettings(env.DB, user.id);
		expect(settings.modelKey).toBe("glm-5.3");
		expect(settings.effort).toBeNull();
		expect(editedMessage(calls)?.content).toBe(
			"使うモデルを「GLM 5.3」に変えました。このモデルでは思考の深さ「medium」を選べないため、既定に戻しました。",
		);
	});

	it("保存した思考の深さを新しいモデルでも選べるなら、そのまま残す", async () => {
		const user = await userWith("openrouter");
		await updateUserSettings(env.DB, user.id, { effort: "high" });
		const calls = mockModelApis([
			{
				id: "z-ai/glm-5.3",
				efforts: ["max", "high", "low"],
				defaultEffort: "max",
			},
		]);

		await sendInteraction(select(user, "glm-5.3"));

		expect((await getUserSettings(env.DB, user.id)).effort).toBe("high");
		expect(editedMessage(calls)?.content).toBe(
			"使うモデルを「GLM 5.3」に変えました。",
		);
	});

	it("Claudeは low〜max を選べるので、Anthropicで直接呼ぶならモデル情報を取得せずに確かめる", async () => {
		const user = await userWith("anthropic");
		await updateUserSettings(env.DB, user.id, { effort: "xhigh" });
		const calls = mockModelApis([]);

		await sendInteraction(select(user, "claude-opus-5.5"));

		const settings = await getUserSettings(env.DB, user.id);
		expect(settings.modelKey).toBe("claude-opus-5.5");
		expect(settings.effort).toBe("xhigh");
		expect(calls.some((call) => call.url.hostname === "openrouter.ai")).toBe(
			false,
		);
	});

	it("「その他」を選ぶと、前に入力したIDを入れたモーダルを開く", async () => {
		const user = await userWith("openrouter");
		await updateUserSettings(env.DB, user.id, {
			modelKey: "gpt-6-luna",
			customModelId: "x-ai/grok-4.7-mini",
		});

		const body = await sendInteraction(select(user, "custom"));

		expect(body.type).toBe(InteractionResponseType.Modal);
		expect(body.data.custom_id).toBe("model:custom");
		expect(body.data.components[0].component).toMatchObject({
			custom_id: "model_id",
			required: true,
			value: "x-ai/grok-4.7-mini",
		});
	});
});

describe("/model の「その他」", () => {
	it("OpenRouterのモデル一覧にあれば保存し、メニューのメッセージを結果に書き換える", async () => {
		const user = await userWith("openrouter");
		const calls = mockModelApis([
			{ id: "openai/gpt-6.1-sol", inputModalities: ["text", "image"] },
		]);

		// 全角の文字や空白は、整えてから確かめる
		const body = await sendInteraction(
			submitModelId(user, " ｏｐｅｎａｉ/gpt-6.1-sol\n"),
		);

		// 確かめるのに時間がかかることがあるので、まず保留の応答を返す
		expect(body).toEqual({
			type: InteractionResponseType.DeferredMessageUpdate,
		});
		const settings = await getUserSettings(env.DB, user.id);
		expect(settings.modelKey).toBe("custom");
		expect(settings.customModelId).toBe("openai/gpt-6.1-sol");
		const edit = calls.find((call) => call.url.hostname === "discord.com");
		expect(edit?.method).toBe("PATCH");
		expect(edit?.url.pathname).toBe(
			`/api/v10/webhooks/${env.DISCORD_APPLICATION_ID}/interaction-token/messages/@original`,
		);
		expect(editedMessage(calls)).toEqual({
			content: "使うモデルを「openai/gpt-6.1-sol」に変えました。",
			components: [],
		});
	});

	it("OpenRouterのモデル一覧になければ保存せず、そう知らせる", async () => {
		const user = await userWith("openrouter");
		const calls = mockModelApis([
			{ id: "openai/gpt-6.1-sol", inputModalities: ["text"] },
		]);

		await sendInteraction(submitModelId(user, "openai/gpt-9"));

		expect((await getUserSettings(env.DB, user.id)).modelKey).toBeNull();
		expect(editedMessage(calls)?.content).toBe(
			"モデル「openai/gpt-9」が見つかりませんでした。IDを確かめて、もう一度入力してください。",
		);
	});

	it("OpenRouterのモデル一覧を取得できなければ、確かめられなかったと知らせる", async () => {
		const user = await userWith("openrouter");
		const calls = mockFetch(({ url }) =>
			url.hostname === "openrouter.ai"
				? new Response(null, { status: 503 })
				: Response.json({}),
		);

		await sendInteraction(submitModelId(user, "openai/gpt-6.1-sol"));

		expect((await getUserSettings(env.DB, user.id)).modelKey).toBeNull();
		expect(editedMessage(calls)?.content).toContain("確かめられませんでした");
	});

	it("OpenRouterのモデル一覧は、取得したらしばらく使い回す", async () => {
		const user = await userWith("openrouter");
		const calls = mockModelApis([
			{ id: "openai/gpt-6.1-sol", inputModalities: ["text"] },
			{ id: "x-ai/grok-4.7-mini", inputModalities: ["text"] },
		]);

		await sendInteraction(submitModelId(user, "openai/gpt-6.1-sol"));
		await sendInteraction(submitModelId(user, "x-ai/grok-4.7-mini"));

		expect(
			calls.filter((call) => call.url.hostname === "openrouter.ai"),
		).toHaveLength(1);
		expect((await getUserSettings(env.DB, user.id)).customModelId).toBe(
			"x-ai/grok-4.7-mini",
		);
	});

	it("claude-で始まるIDは、本人のキーでAnthropicに確かめる", async () => {
		const user = await userWith("anthropic");
		const calls = mockModelApis([], () =>
			Response.json({
				type: "model",
				id: "claude-sonnet-4-6",
				display_name: "Claude Sonnet 4.6",
				created_at: "2026-02-17T00:00:00Z",
			}),
		);

		await sendInteraction(submitModelId(user, "claude-sonnet-4-6"));

		const check = calls.find(
			(call) => call.url.hostname === "api.anthropic.com",
		);
		expect(check?.method).toBe("GET");
		expect(check?.url.pathname).toBe("/v1/models/claude-sonnet-4-6");
		expect(check?.headers.get("authorization")).toBe("Bearer key-anthropic");
		expect(calls.some((call) => call.url.hostname === "openrouter.ai")).toBe(
			false,
		);
		expect((await getUserSettings(env.DB, user.id)).customModelId).toBe(
			"claude-sonnet-4-6",
		);
		expect(editedMessage(calls)?.content).toBe(
			"使うモデルを「claude-sonnet-4-6」に変えました。",
		);
	});

	it("Anthropicで見つからなければ保存せず、そう知らせる", async () => {
		const user = await userWith("anthropic");
		const calls = mockModelApis([], () =>
			Response.json(
				{
					type: "error",
					error: { type: "not_found_error", message: "test" },
				},
				{ status: 404 },
			),
		);

		await sendInteraction(submitModelId(user, "claude-unknown-9"));

		expect((await getUserSettings(env.DB, user.id)).modelKey).toBeNull();
		expect(editedMessage(calls)?.content).toContain("見つかりませんでした");
	});

	it("claude-で始まるIDでも、Anthropicのキーがなければ確かめずに登録を案内する", async () => {
		const user = await userWith("openrouter");
		const calls = mockModelApis([]);

		await sendInteraction(submitModelId(user, "claude-sonnet-4-6"));

		expect(
			calls.some((call) => call.url.hostname === "api.anthropic.com"),
		).toBe(false);
		expect(editedMessage(calls)?.content).toContain(
			"AnthropicのAPIキーの登録が必要",
		);
	});

	it("保存した思考の深さをそのモデルで選べなければ、既定に戻す", async () => {
		const user = await userWith("openrouter");
		await updateUserSettings(env.DB, user.id, { effort: "xhigh" });
		const calls = mockModelApis([
			{ id: "z-ai/glm-5.3", efforts: ["max", "high", "low"] },
		]);

		await sendInteraction(submitModelId(user, "z-ai/glm-5.3"));

		const settings = await getUserSettings(env.DB, user.id);
		expect(settings.customModelId).toBe("z-ai/glm-5.3");
		expect(settings.effort).toBeNull();
		expect(editedMessage(calls)?.content).toContain(
			"このモデルでは思考の深さ「xhigh」を選べないため、既定に戻しました。",
		);
	});

	it("Claudeで選べる段階は、Anthropicのモデル情報から確かめる", async () => {
		const user = await userWith("anthropic");
		await updateUserSettings(env.DB, user.id, { effort: "high" });
		const calls = mockModelApis([], () =>
			Response.json({
				type: "model",
				id: "claude-haiku-4-5",
				display_name: "Claude Haiku 4.5",
				created_at: "2025-10-01T00:00:00Z",
				capabilities: {
					effort: {
						supported: false,
						low: { supported: false },
						medium: { supported: false },
						high: { supported: false },
						xhigh: null,
						max: { supported: false },
					},
				},
			}),
		);

		await sendInteraction(submitModelId(user, "claude-haiku-4-5"));

		expect((await getUserSettings(env.DB, user.id)).effort).toBeNull();
		expect(editedMessage(calls)?.content).toContain("「high」を選べないため");
	});
});
