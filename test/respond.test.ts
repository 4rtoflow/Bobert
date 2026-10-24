import { env } from "cloudflare:workers";
import type { APIAttachment, APIMessage } from "discord-api-types/v10";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearModelInfoCache } from "../src/llm/model-info";
import type { RespondJob } from "../src/queue/messages";
import { handleRespondJob } from "../src/respond/handler";
import { saveCredential, updateUserSettings } from "../src/store/users";
import {
	ALICE,
	BOB,
	BOT,
	CHANNEL_ID,
	discordMessage,
	discordReply,
} from "./fixtures";
import { type FetchCall, mockFetch } from "./helpers";

afterEach(() => {
	vi.restoreAllMocks();
	clearModelInfoCache();
});

/** messageへの応答の仕事 */
function respondJob(message: APIMessage): RespondJob {
	return {
		kind: "respond",
		messageId: message.id,
		channelId: CHANNEL_ID,
		guildId: "900",
		authorId: message.author.id,
	};
}

/**
 * DiscordとAIのAPIの偽物。Discordにはmessagesのメッセージがあることにする。
 * aiはAnthropicとOpenRouterへのリクエストに応える。
 */
function mockApis(
	messages: APIMessage[],
	ai: (call: FetchCall) => Response = () => new Response(null, { status: 500 }),
): FetchCall[] {
	const stored = new Map(messages.map((message) => [message.id, message]));
	let nextId = 9000;
	return mockFetch((call) => {
		if (call.url.hostname !== "discord.com") {
			return ai(call);
		}
		const path = call.url.pathname.replace("/api/v10", "");
		const read = path.match(/^\/channels\/\d+\/messages\/(\d+)$/);
		if (call.method === "GET" && read) {
			const message = stored.get(read[1] ?? "");
			return message
				? Response.json(message)
				: Response.json({ code: 10008 }, { status: 404 });
		}
		if (call.method === "POST" && path.endsWith("/typing")) {
			return new Response(null, { status: 204 });
		}
		if (call.method === "POST" && path === `/channels/${CHANNEL_ID}/messages`) {
			return Response.json({ id: String(nextId++), channel_id: CHANNEL_ID });
		}
		return new Response(null, { status: 500 });
	});
}

/** 投稿した返信 */
function posted(calls: FetchCall[]) {
	return calls
		.filter(
			(call) =>
				call.method === "POST" &&
				call.url.pathname === `/api/v10/channels/${CHANNEL_ID}/messages`,
		)
		.map(
			(call) =>
				call.body as {
					content: string;
					message_reference: { message_id: string };
					allowed_mentions: { parse: string[]; replied_user: boolean };
				},
		);
}

/** AnthropicのAPIが、ストリーミングでtextを返す */
function anthropicStream(text: string): Response {
	const events: [string, unknown][] = [
		[
			"message_start",
			{
				type: "message_start",
				message: {
					id: "msg_test",
					type: "message",
					role: "assistant",
					model: "claude-haiku-5-5",
					content: [],
					stop_reason: null,
					stop_sequence: null,
					usage: { input_tokens: 20, output_tokens: 1 },
				},
			},
		],
		[
			"content_block_start",
			{
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			},
		],
		[
			"content_block_delta",
			{
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text },
			},
		],
		["content_block_stop", { type: "content_block_stop", index: 0 }],
		[
			"message_delta",
			{
				type: "message_delta",
				delta: { stop_reason: "end_turn", stop_sequence: null },
				usage: { output_tokens: 5 },
			},
		],
		["message_stop", { type: "message_stop" }],
	];
	return new Response(
		events
			.map(
				([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
			)
			.join(""),
		{ headers: { "Content-Type": "text/event-stream" } },
	);
}

/** OpenRouterのAPIが、textを返す */
function openRouterChat(text: string): Response {
	return Response.json({
		choices: [{ message: { content: text }, finish_reason: "stop" }],
		usage: { prompt_tokens: 10, completion_tokens: 5 },
	});
}

/** OpenRouterのモデル一覧のAPIの応答 */
function openRouterModels(id: string, inputModalities: string[]): Response {
	return Response.json({
		data: [{ id, architecture: { input_modalities: inputModalities } }],
	});
}

const CAT_URL = "https://cdn.discordapp.com/attachments/800/1/cat.png";

const CAT_IMAGE: APIAttachment = {
	id: "1",
	filename: "cat.png",
	size: 1000,
	url: CAT_URL,
	proxy_url: CAT_URL,
	content_type: "image/png",
};

describe("メンションと返信への応答", () => {
	it("キーを登録していない人には、登録方法を返信する", async () => {
		const trigger = discordMessage("5001", BOB, `<@${BOT.id}> こんにちは`, {
			mentions: [BOT],
		});
		const calls = mockApis([trigger]);

		await handleRespondJob(respondJob(trigger), env);

		const [reply] = posted(calls);
		expect(reply?.content).toContain("`/setup`");
		expect(reply?.message_reference.message_id).toBe(trigger.id);
		expect(reply?.allowed_mentions).toEqual({ parse: [], replied_user: true });
	});

	it("同じメッセージには2回返信しない", async () => {
		const trigger = discordMessage("5002", BOB, `<@${BOT.id}> こんにちは`, {
			mentions: [BOT],
		});
		const calls = mockApis([trigger]);

		await handleRespondJob(respondJob(trigger), env);
		await handleRespondJob(respondJob(trigger), env);

		expect(posted(calls)).toHaveLength(1);
	});

	it("返信のつながりを会話としてAIに渡し、返答を返信する", async () => {
		const user = { ...ALICE, id: "110" };
		await saveCredential(env, user.id, "anthropic", {
			apiKey: "sk-ant-test",
			workspaceId: null,
		});
		const first = discordMessage("5010", user, `<@${BOT.id}> やあ`, {
			mentions: [BOT],
		});
		const answer = discordReply("5011", BOT, "やあ!", first);
		const trigger = discordReply("5012", user, "元気?", answer, {
			referenced_message: answer,
		});
		const calls = mockApis([first, answer, trigger], () =>
			anthropicStream("元気だよ!"),
		);

		await handleRespondJob(respondJob(trigger), env);

		const request = calls.find(
			(call) => call.url.hostname === "api.anthropic.com",
		);
		expect(request?.url.pathname).toBe("/v1/messages");
		expect(request?.headers.get("authorization")).toBe("Bearer sk-ant-test");
		expect(request?.body).toMatchObject({
			model: "claude-haiku-5-5",
			stream: true,
			cache_control: { type: "ephemeral" },
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "Alice: @Bobert やあ" }],
				},
				{ role: "assistant", content: [{ type: "text", text: "やあ!" }] },
				{ role: "user", content: [{ type: "text", text: "Alice: 元気?" }] },
			],
		});
		expect(posted(calls).map((reply) => reply.content)).toEqual(["元気だよ!"]);
	});

	it("ワークスペースIDを登録した人のキーでは、ワークスペースをヘッダーで指定する", async () => {
		const user = { ...ALICE, id: "113" };
		await saveCredential(env, user.id, "anthropic", {
			apiKey: "sk-ant-usr-test",
			workspaceId: "wrkspc_01TEST",
		});
		const trigger = discordMessage("5040", user, `<@${BOT.id}> こんにちは`, {
			mentions: [BOT],
		});
		const calls = mockApis([trigger], () => anthropicStream("こんにちは!"));

		await handleRespondJob(respondJob(trigger), env);

		const request = calls.find(
			(call) => call.url.hostname === "api.anthropic.com",
		);
		expect(request?.headers.get("anthropic-workspace-id")).toBe(
			"wrkspc_01TEST",
		);
		expect(posted(calls)[0]?.content).toBe("こんにちは!");
	});

	it("長い返答は分けて投稿し、2通目からは前の返信につなげる", async () => {
		const user = { ...ALICE, id: "111" };
		await saveCredential(env, user.id, "anthropic", {
			apiKey: "sk-ant-test",
			workspaceId: null,
		});
		const trigger = discordMessage("5020", user, `<@${BOT.id}> 長く話して`, {
			mentions: [BOT],
		});
		const longText = `${"あ".repeat(1500)}\n\n${"い".repeat(1500)}`;
		const calls = mockApis([trigger], () => anthropicStream(longText));

		await handleRespondJob(respondJob(trigger), env);

		const replies = posted(calls);
		expect(replies.map((reply) => reply.content)).toEqual([
			"あ".repeat(1500),
			"い".repeat(1500),
		]);
		expect(replies[0]?.message_reference.message_id).toBe(trigger.id);
		expect(replies[0]?.allowed_mentions.replied_user).toBe(true);
		expect(replies[1]?.message_reference.message_id).toBe("9000");
		expect(replies[1]?.allowed_mentions.replied_user).toBe(false);
	});

	it("OpenRouterの残高が足りないときは、理由を返信する", async () => {
		const user = { ...ALICE, id: "112" };
		await saveCredential(env, user.id, "openrouter", {
			apiKey: "sk-or-test",
			workspaceId: null,
		});
		const trigger = discordMessage("5030", user, `<@${BOT.id}> こんにちは`, {
			mentions: [BOT],
		});
		const calls = mockApis([trigger], () =>
			Response.json(
				{ error: { code: 402, message: "Insufficient credits" } },
				{ status: 402 },
			),
		);

		await handleRespondJob(respondJob(trigger), env);

		const request = calls.find((call) => call.url.hostname === "openrouter.ai");
		expect(request?.body).toMatchObject({
			model: "anthropic/claude-haiku-5.5",
			provider: { data_collection: "deny" },
		});
		expect(posted(calls)[0]?.content).toContain("OpenRouterの残高が不足");
	});

	it("「その他」で選んだOpenRouterのモデルが画像を読めるなら、画像を渡す", async () => {
		const user = { ...ALICE, id: "114" };
		await saveCredential(env, user.id, "openrouter", {
			apiKey: "sk-or-test",
			workspaceId: null,
		});
		await updateUserSettings(env.DB, user.id, {
			modelKey: "custom",
			customModelId: "x-ai/grok-4.7-mini",
		});
		const trigger = discordMessage("5050", user, `<@${BOT.id}> これ何?`, {
			mentions: [BOT],
			attachments: [CAT_IMAGE],
		});
		const calls = mockApis([trigger], (call) =>
			call.url.pathname === "/api/v1/models"
				? openRouterModels("x-ai/grok-4.7-mini", ["text", "image"])
				: openRouterChat("猫だね!"),
		);

		await handleRespondJob(respondJob(trigger), env);

		const request = calls.find(
			(call) => call.url.pathname === "/api/v1/chat/completions",
		);
		expect(request?.body).toMatchObject({
			model: "x-ai/grok-4.7-mini",
			messages: [
				{ role: "system" },
				{
					role: "user",
					content: [
						{ type: "text", text: "Alice: @Bobert これ何?" },
						{ type: "image_url", image_url: { url: CAT_URL } },
					],
				},
			],
		});
		expect(posted(calls)[0]?.content).toBe("猫だね!");
	});

	it("「その他」で選んだOpenRouterのモデルが画像を読めないなら、本文だけで答えて一言添える", async () => {
		const user = { ...ALICE, id: "115" };
		await saveCredential(env, user.id, "openrouter", {
			apiKey: "sk-or-test",
			workspaceId: null,
		});
		await updateUserSettings(env.DB, user.id, {
			modelKey: "custom",
			customModelId: "z-ai/glm-5.3",
		});
		const trigger = discordMessage("5060", user, `<@${BOT.id}> これ何?`, {
			mentions: [BOT],
			attachments: [CAT_IMAGE],
		});
		const calls = mockApis([trigger], (call) =>
			call.url.pathname === "/api/v1/models"
				? openRouterModels("z-ai/glm-5.3", ["text"])
				: openRouterChat("猫だね!"),
		);

		await handleRespondJob(respondJob(trigger), env);

		const request = calls.find(
			(call) => call.url.pathname === "/api/v1/chat/completions",
		);
		expect(request?.body).toMatchObject({
			messages: [
				{ role: "system" },
				{ role: "user", content: "Alice: @Bobert これ何?\n[画像: cat.png]" },
			],
		});
		expect(posted(calls)[0]?.content).toBe(
			"猫だね!\n-# このモデルは画像を読めません",
		);
	});
});
