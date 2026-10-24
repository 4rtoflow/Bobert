import { env } from "cloudflare:workers";
import type { APIUser } from "discord-api-types/v10";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ComponentType,
	InteractionResponseType,
	InteractionType,
	MessageFlags,
} from "../src/discord/constants";
import { clearModelInfoCache } from "../src/llm/model-info";
import { getUserSettings, updateUserSettings } from "../src/store/users";
import {
	editedMessage,
	type FetchCall,
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
const userWith = userFactory(500);

function effortCommand(user: APIUser) {
	return guildInteraction(
		InteractionType.ApplicationCommand,
		{ id: "13", name: "effort", type: 1 },
		user,
	);
}

/** セレクトメニューでvalueを選ぶ */
function select(user: APIUser, value: string) {
	return guildInteraction(
		InteractionType.MessageComponent,
		{
			custom_id: "effort:select",
			component_type: ComponentType.StringSelect,
			values: [value],
		},
		user,
	);
}

/** 書き換えたメッセージにある、メニューの選択肢 */
function menuOptions(calls: FetchCall[]) {
	return editedMessage(calls)?.components?.[0]?.components[0]?.options;
}

/** Anthropicのモデル情報のAPIの応答。effortは選べる思考の深さ */
function anthropicModel(id: string, effort: Record<string, unknown>) {
	return Response.json({
		type: "model",
		id,
		display_name: id,
		created_at: "2026-02-17T00:00:00Z",
		capabilities: { effort },
	});
}

describe("/effort", () => {
	it("モデル情報を取得することがあるので、まず本人にだけ見える保留の応答を返す", async () => {
		const user = await userWith("anthropic");
		mockModelApis([]);

		const body = await sendInteraction(effortCommand(user));

		expect(body).toEqual({
			type: InteractionResponseType.DeferredChannelMessageWithSource,
			data: { flags: MessageFlags.Ephemeral },
		});
	});

	it("キーを登録していなければ、登録を案内する", async () => {
		const calls = mockModelApis([]);

		await sendInteraction(effortCommand(await userWith()));

		expect(editedMessage(calls)).toEqual({
			content: expect.stringContaining("`/setup`"),
			components: [],
		});
	});

	it("Anthropicで直接呼ぶClaudeなら、low〜maxを出す。既定の段階は分からないので書かない", async () => {
		const user = await userWith("anthropic");
		const calls = mockModelApis([]);

		await sendInteraction(effortCommand(user));

		expect(editedMessage(calls)?.content).toBe(
			"思考の深さ(effort)を選んでください。今は「モデルの既定」です。",
		);
		expect(editedMessage(calls)?.components?.[0]?.components[0]).toMatchObject({
			type: ComponentType.StringSelect,
			custom_id: "effort:select",
			placeholder: "思考の深さを選ぶ",
		});
		expect(menuOptions(calls)).toEqual([
			{ label: "モデルの既定", value: "model_default", default: true },
			{
				label: "low",
				value: "low",
				description: "軽く考える。速く、安い",
				default: false,
			},
			{
				label: "medium",
				value: "medium",
				description: "ほどほどに考える",
				default: false,
			},
			{
				label: "high",
				value: "high",
				description: "よく考える",
				default: false,
			},
			{
				label: "xhigh",
				value: "xhigh",
				description: "さらによく考える",
				default: false,
			},
			{
				label: "max",
				value: "max",
				description: "いちばん深く考える。遅く、高い",
				default: false,
			},
		]);
		expect(calls.some((call) => call.url.hostname === "openrouter.ai")).toBe(
			false,
		);
	});

	it("OpenRouter経由のClaudeなら、既定の段階をOpenRouterのモデル情報から書く。noneは出さない", async () => {
		const user = await userWith("openrouter");
		await updateUserSettings(env.DB, user.id, { effort: "high" });
		const calls = mockModelApis([
			{
				id: "anthropic/claude-haiku-5.5",
				efforts: ["max", "xhigh", "high", "medium", "low", "none"],
				defaultEffort: "medium",
			},
		]);

		await sendInteraction(effortCommand(user));

		expect(editedMessage(calls)?.content).toBe(
			"思考の深さ(effort)を選んでください。今は「high」です。",
		);
		const options = menuOptions(calls);
		expect(options.map((option: { value: string }) => option.value)).toEqual([
			"model_default",
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]);
		expect(options[0]).toEqual({
			label: "モデルの既定(medium)",
			value: "model_default",
			default: false,
		});
		expect(
			options.find((option: { value: string }) => option.value === "high")
				?.default,
		).toBe(true);
	});

	it("Claude以外は、OpenRouterのモデル情報の段階を、浅い順に並べて出す", async () => {
		const user = await userWith("openrouter");
		await updateUserSettings(env.DB, user.id, { modelKey: "qwen3.8-max" });
		const calls = mockModelApis([
			{
				id: "qwen/qwen3.8-max-0902",
				efforts: ["xhigh", "high", "medium", "low", "minimal"],
				defaultEffort: "xhigh",
			},
		]);

		await sendInteraction(effortCommand(user));

		expect(
			menuOptions(calls).map((option: { label: string }) => option.label),
		).toEqual([
			"モデルの既定(xhigh)",
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
		]);
	});

	it("思考の深さを選べないモデルなら、そう知らせる", async () => {
		const user = await userWith("openrouter");
		await updateUserSettings(env.DB, user.id, { modelKey: "mimo-v2.6-pro" });
		const calls = mockModelApis([{ id: "xiaomi/mimo-v2.6-pro" }]);

		await sendInteraction(effortCommand(user));

		expect(editedMessage(calls)).toEqual({
			content: "「MiMo-V2.6-Pro」は、思考の深さを選べません。",
			components: [],
		});
	});

	it("モデル情報を取得できなければ、そう知らせる", async () => {
		const user = await userWith("openrouter");
		await updateUserSettings(env.DB, user.id, { modelKey: "glm-5.3" });
		const calls = mockFetch(({ url }) =>
			url.hostname === "openrouter.ai"
				? new Response(null, { status: 503 })
				: Response.json({}),
		);

		await sendInteraction(effortCommand(user));

		expect(editedMessage(calls)).toEqual({
			content:
				"モデルの情報を取得できませんでした。少し待ってから、もう一度試してください。",
			components: [],
		});
	});

	it("「その他」のClaudeは、本人のキーで、Anthropicのモデル情報から作る", async () => {
		const user = await userWith("anthropic");
		await updateUserSettings(env.DB, user.id, {
			modelKey: "custom",
			customModelId: "claude-sonnet-4-6",
		});
		const calls = mockModelApis([], () =>
			anthropicModel("claude-sonnet-4-6", {
				supported: true,
				low: { supported: true },
				medium: { supported: true },
				high: { supported: true },
				xhigh: null,
				max: { supported: true },
			}),
		);

		await sendInteraction(effortCommand(user));

		const check = calls.find(
			(call) => call.url.hostname === "api.anthropic.com",
		);
		expect(check?.headers.get("authorization")).toBe("Bearer key-anthropic");
		expect(
			menuOptions(calls).map((option: { value: string }) => option.value),
		).toEqual(["model_default", "low", "medium", "high", "max"]);
	});
});

describe("/effort のメニュー", () => {
	it("選んだ段階を保存し、メニューのメッセージを結果に書き換える", async () => {
		const user = await userWith("anthropic");
		const calls = mockModelApis([]);

		const body = await sendInteraction(select(user, "high"));

		expect(body).toEqual({
			type: InteractionResponseType.DeferredMessageUpdate,
		});
		expect((await getUserSettings(env.DB, user.id)).effort).toBe("high");
		expect(editedMessage(calls)).toEqual({
			content: "思考の深さを「high」に変えました。",
			components: [],
		});
	});

	it("「モデルの既定」を選ぶと、設定を消す", async () => {
		const user = await userWith("anthropic");
		await updateUserSettings(env.DB, user.id, { effort: "max" });
		const calls = mockModelApis([]);

		await sendInteraction(select(user, "model_default"));

		expect((await getUserSettings(env.DB, user.id)).effort).toBeNull();
		expect(editedMessage(calls)?.content).toBe(
			"思考の深さを「モデルの既定」に戻しました。",
		);
	});

	it("今のモデルで選べない段階なら保存せず、今のモデルのメニューを出し直す", async () => {
		// メニューを出した後に、/model でモデルを変えた場合
		const user = await userWith("openrouter");
		await updateUserSettings(env.DB, user.id, { modelKey: "glm-5.3" });
		const calls = mockModelApis([
			{
				id: "z-ai/glm-5.3",
				efforts: ["max", "high", "low"],
				defaultEffort: "max",
			},
		]);

		await sendInteraction(select(user, "medium"));

		expect((await getUserSettings(env.DB, user.id)).effort).toBeNull();
		expect(
			menuOptions(calls).map((option: { value: string }) => option.value),
		).toEqual(["model_default", "low", "high", "max"]);
	});
});
