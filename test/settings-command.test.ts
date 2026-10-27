import { env } from "cloudflare:workers";
import type { APIUser } from "discord-api-types/v10";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	InteractionResponseType,
	InteractionType,
	MessageFlags,
} from "../src/discord/constants";
import { clearModelInfoCache } from "../src/llm/model-info";
import { updateUserSettings } from "../src/store/users";
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
const userWith = userFactory(800);

function settingsCommand(user: APIUser) {
	return guildInteraction(
		InteractionType.ApplicationCommand,
		{ id: "15", name: "settings", type: 1 },
		user,
	);
}

/** 書き換えたメッセージの行 */
function lines(calls: FetchCall[]): string[] {
	return (editedMessage(calls)?.content ?? "").split("\n");
}

describe("/settings", () => {
	it("今の設定を、本人にだけ見せる", async () => {
		const user = await userWith("anthropic");
		const calls = mockModelApis([]);

		const body = await sendInteraction(settingsCommand(user));

		// 思考の深さは、モデル情報を見て決めることがあるので、まず保留の応答を返す
		expect(body).toEqual({
			type: InteractionResponseType.DeferredChannelMessageWithSource,
			data: { flags: MessageFlags.Ephemeral },
		});
		expect(editedMessage(calls)).toEqual({
			content: [
				"- Anthropic: 登録済み",
				"- OpenRouter: 未連携",
				"- モデル: Claude Haiku 5.5(Anthropicで直接呼ぶ)",
				"- 思考の深さ: low(既定)",
				"- Web検索: OFF",
				"- 利用量の表示: OFF",
				"- 画像の読み取り: ON",
				"- 自分用の指示: なし",
			].join("\n"),
			components: [],
		});
	});

	it("変えた設定を書き、自分用の指示は先頭の50文字だけ出す", async () => {
		const user = await userWith("anthropic", "openrouter");
		await updateUserSettings(env.DB, user.id, {
			modelKey: "gpt-6-luna",
			effort: "high",
			featWebSearch: true,
			featUsageDisplay: true,
			featImageInput: false,
			customPrompt: `${"あ".repeat(30)}\n${"い".repeat(30)}`,
		});
		const calls = mockModelApis([
			{
				id: "openai/gpt-6-luna",
				efforts: ["max", "xhigh", "high", "medium", "low", "none"],
			},
		]);

		await sendInteraction(settingsCommand(user));

		expect(lines(calls)).toEqual([
			"- Anthropic: 登録済み",
			"- OpenRouter: 連携済み",
			"- モデル: GPT-6 Luna(OpenRouter経由)",
			"- 思考の深さ: high",
			"- Web検索: ON",
			"- 利用量の表示: ON",
			"- 画像の読み取り: OFF",
			// 改行は空白にする
			`- 自分用の指示: ${"あ".repeat(30)} ${"い".repeat(19)}…`,
		]);
	});

	it("lowを選べないモデルでは、代わりに使う段階に「(既定)」を付ける", async () => {
		const user = await userWith("openrouter");
		await updateUserSettings(env.DB, user.id, { modelKey: "mistral-large-4" });
		const calls = mockModelApis([
			{ id: "mistralai/mistral-large-4-0", efforts: ["high", "none"] },
		]);

		await sendInteraction(settingsCommand(user));

		expect(lines(calls)).toContain("- 思考の深さ: high(既定)");
	});

	it("思考の深さを選べないモデルでは、そう書く", async () => {
		const user = await userWith("openrouter");
		await updateUserSettings(env.DB, user.id, { modelKey: "mimo-v2.6-pro" });
		const calls = mockModelApis([{ id: "xiaomi/mimo-v2.6-pro" }]);

		await sendInteraction(settingsCommand(user));

		expect(lines(calls)).toContain("- 思考の深さ: このモデルでは選べません");
	});

	it("キーを登録していなければ、モデルを使うには登録が必要だと書く", async () => {
		const calls = mockModelApis([]);

		await sendInteraction(settingsCommand(await userWith()));

		expect(lines(calls)).toEqual(
			expect.arrayContaining([
				"- Anthropic: 未登録",
				"- OpenRouter: 未連携",
				"- モデル: Claude Haiku 5.5(`/setup`で登録が必要)",
				"- 思考の深さ: low(既定)",
			]),
		);
	});

	it("モデル情報を取得できなければ、そう知らせる", async () => {
		const user = await userWith("openrouter");
		await updateUserSettings(env.DB, user.id, { modelKey: "glm-5.3" });
		const calls = mockFetch(({ url }) =>
			url.hostname === "openrouter.ai"
				? new Response(null, { status: 503 })
				: Response.json({}),
		);

		await sendInteraction(settingsCommand(user));

		expect(editedMessage(calls)).toEqual({
			content:
				"モデルの情報を取得できませんでした。少し待ってから、もう一度試してください。",
			components: [],
		});
	});
});
