import { env } from "cloudflare:workers";
import type { APIMessage } from "discord-api-types/v10";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InteractionType } from "../src/discord/constants";
import { COMMANDS } from "../src/interactions/commands";
import { clearModelInfoCache } from "../src/llm/model-info";
import type {
	CompactJob,
	QueueMessage,
	RespondJob,
} from "../src/queue/messages";
import { handleCompactJob } from "../src/respond/compact";
import { handleRespondJob } from "../src/respond/handler";
import { fromDiscord } from "../src/respond/history";
import { SUMMARY_SYSTEM_PROMPT } from "../src/respond/summary";
import { saveMessages } from "../src/store/messages";
import { saveCredential } from "../src/store/users";
import {
	ALICE,
	BOT,
	CHANNEL_ID,
	discordMessage,
	discordReply,
} from "./fixtures";
import {
	anthropicStreamOf,
	type FetchCall,
	guildInteraction,
	mockFetch,
	sendInteraction,
} from "./helpers";

afterEach(() => {
	vi.restoreAllMocks();
	clearModelInfoCache();
});

const GUILD_ID = "900";

/** 要約を勧める案内(Claude Haiku 5.5は、入力が10万トークンを超えると料金が上がる) */
const NOTICE =
	"-# 会話が長くなり、入力が10万トークンを超えました。このモデルは、ここから料金が上がります。「今すぐ要約」で古い部分を要約すると、次からの費用を抑えられます。";

/** 保存用と応答用のQueueの偽物。入れた仕事を記録する */
function fakeQueues() {
	const sent: QueueMessage[] = [];
	const queue = {
		send: async (body: QueueMessage) => {
			sent.push(body);
		},
		sendBatch: async () => {},
	} as unknown as Queue;
	const environment: Env = {
		...env,
		INGEST_QUEUE: queue,
		RESPOND_QUEUE: queue,
	};
	return { environment, sent };
}

/** Anthropicのキーを登録した人(既定のClaude Haiku 5.5をAnthropicで直接呼ぶ) */
async function anthropicUser(id: string) {
	const user = { ...ALICE, id };
	await saveCredential(env, user.id, "anthropic", {
		apiKey: "sk-ant-test",
		workspaceId: null,
	});
	return user;
}

/** 人(user)とBobertが交互に返信し合う会話。firstIdから続くIDで、count件 */
function conversation(
	user: typeof ALICE,
	firstId: number,
	count: number,
): APIMessage[] {
	const messages: APIMessage[] = [];
	for (let i = 0; i < count; i++) {
		const parent = messages.at(-1);
		const author = i % 2 === 0 ? user : BOT;
		const content = i % 2 === 0 ? `発言${i}` : `返答${i}`;
		messages.push(
			parent
				? discordReply(String(firstId + i), author, content, parent)
				: discordMessage(String(firstId + i), author, content),
		);
	}
	return messages;
}

/**
 * DiscordとAIのAPIの偽物。Discordにはmessagesがあることにする。
 * 投稿したメッセージには、9950から続くIDを付ける。aiは、AnthropicとOpenRouterへのリクエストに応える
 */
function mockApis(
	messages: APIMessage[],
	ai: (call: FetchCall) => Response,
): FetchCall[] {
	const stored = new Map(messages.map((message) => [message.id, message]));
	let nextId = 9950;
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
		if (call.method === "PATCH") {
			return Response.json({});
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
		.map((call) => call.body as { content: string; components?: unknown });
}

function respondJob(message: APIMessage): RespondJob {
	return {
		kind: "respond",
		messageId: message.id,
		channelId: CHANNEL_ID,
		guildId: GUILD_ID,
		authorId: message.author.id,
	};
}

describe("要約を勧める案内", () => {
	it("料金が上がる境目を超えたら、返答の末尾に案内と「今すぐ要約」ボタンを付ける。同じ会話では1回だけ", async () => {
		const { environment } = fakeQueues();
		const user = await anthropicUser("160");
		const first = discordMessage("7400", user, `<@${BOT.id}> 長い話`, {
			mentions: [BOT],
		});
		const firstCalls = mockApis([first], () =>
			anthropicStreamOf([{ type: "text", text: "答えです" }], {
				inputTokens: 120_000,
			}),
		);

		await handleRespondJob(respondJob(first), environment);

		const [reply] = posted(firstCalls);
		expect(reply?.content.split("\n")).toEqual(["答えです", NOTICE]);
		expect(reply?.components).toEqual([
			{
				type: 1,
				components: [
					{ type: 2, style: 1, label: "今すぐ要約", custom_id: "compact" },
				],
			},
		]);

		// 同じ会話の続きでは、境目を超えていても、もう付けない
		const answer = discordReply("9950", BOT, `答えです\n${NOTICE}`, first);
		const second = discordReply("7401", user, "続きは?", answer);
		const secondCalls = mockApis([first, answer, second], () =>
			anthropicStreamOf([{ type: "text", text: "続きです" }], {
				inputTokens: 130_000,
			}),
		);

		await handleRespondJob(respondJob(second), environment);

		const [next] = posted(secondCalls);
		expect(next?.content).toBe("続きです");
		expect(next).not.toHaveProperty("components");
	});

	it("境目を超えなければ、案内を付けない", async () => {
		const { environment } = fakeQueues();
		const user = await anthropicUser("161");
		const trigger = discordMessage("7410", user, `<@${BOT.id}> 短い話`, {
			mentions: [BOT],
		});
		const calls = mockApis([trigger], () =>
			anthropicStreamOf([{ type: "text", text: "答えです" }], {
				inputTokens: 50_000,
			}),
		);

		await handleRespondJob(respondJob(trigger), environment);

		const [reply] = posted(calls);
		expect(reply?.content).toBe("答えです");
		expect(reply).not.toHaveProperty("components");
	});
});

describe("「今すぐ要約」ボタンと、右クリックメニュー", () => {
	it("右クリックメニューに「会話を要約」を登録する", () => {
		expect(COMMANDS).toContainEqual(
			expect.objectContaining({ type: 3, name: "会話を要約" }),
		);
	});

	it("ボタンを押したら、押した人にだけ見える保留の応答を返し、要約の仕事を入れる", async () => {
		const { environment, sent } = fakeQueues();
		const question = discordMessage("7500", ALICE, "質問");
		const answer = discordReply("7501", BOT, `答えです\n${NOTICE}`, question);

		const body = await sendInteraction(
			{
				...guildInteraction(InteractionType.MessageComponent, {
					custom_id: "compact",
					component_type: 2,
				}),
				message: answer,
			},
			environment,
		);

		expect(body).toEqual({ type: 5, data: { flags: 64 } });
		expect(sent).toEqual([
			{
				kind: "compact",
				interactionToken: "interaction-token",
				userId: ALICE.id,
				channelId: CHANNEL_ID,
				guildId: GUILD_ID,
				start: fromDiscord(answer, GUILD_ID),
				buttonMessageId: "7501",
			},
		]);
	});

	it("右クリックメニューで選んだら、選んだメッセージまでの会話を要約する仕事を入れる", async () => {
		const { environment, sent } = fakeQueues();
		const target = discordMessage("7600", ALICE, "ここまでを要約したい");

		const body = await sendInteraction(
			guildInteraction(InteractionType.ApplicationCommand, {
				id: "17",
				name: "会話を要約",
				type: 3,
				target_id: "7600",
				resolved: { messages: { "7600": target } },
			}),
			environment,
		);

		expect(body).toEqual({ type: 5, data: { flags: 64 } });
		expect(sent).toEqual([
			expect.objectContaining({
				kind: "compact",
				start: fromDiscord(target, GUILD_ID),
				buttonMessageId: null,
			}),
		]);
	});
});

describe("要約の仕事", () => {
	function compactJob(
		userId: string,
		start: APIMessage,
		buttonMessageId: string | null,
	): CompactJob {
		return {
			kind: "compact",
			interactionToken: "interaction-token",
			userId,
			channelId: CHANNEL_ID,
			guildId: GUILD_ID,
			start: fromDiscord(start, GUILD_ID),
			buttonMessageId,
		};
	}

	/** 書き換えたもの(保留にした応答と、チャンネルのメッセージ) */
	function edits(calls: FetchCall[]) {
		return calls
			.filter((call) => call.method === "PATCH")
			.map((call) => ({
				path: call.url.pathname.replace("/api/v10", ""),
				body: call.body,
			}));
	}

	const summaryAi = (call: FetchCall) => {
		const body = call.body as { system?: { text: string }[] };
		return body.system?.[0]?.text === SUMMARY_SYSTEM_PROMPT
			? anthropicStreamOf([{ type: "text", text: "要約です" }])
			: new Response(null, { status: 500 });
	};

	it("押した人のキーで要約して保存し、結果を見せて、案内のボタンを消す", async () => {
		const user = await anthropicUser("170");
		const messages = conversation(user, 7700, 25);
		await saveMessages(
			env.DB,
			messages.map((message) => fromDiscord(message, GUILD_ID)),
		);
		const calls = mockApis([], summaryAi);

		await handleCompactJob(
			compactJob(user.id, messages.at(-1) as APIMessage, "7724"),
			env,
		);

		expect(edits(calls)).toEqual([
			{
				path: `/webhooks/${env.DISCORD_APPLICATION_ID}/interaction-token/messages/@original`,
				body: {
					content:
						"要約しました。次の返答から、要約と新しい20件の発言をAIに渡します。",
				},
			},
			{
				path: `/channels/${CHANNEL_ID}/messages/7724`,
				body: { components: [] },
			},
		]);
		// 新しい20件(7705〜7724)を残し、それより前の5件を要約した
		const saved = await env.DB.prepare(
			"SELECT root_message_id, summary, created_by_user_id FROM conversation_summaries WHERE covered_until_message_id = ?",
		)
			.bind("7704")
			.first();
		expect(saved).toEqual({
			root_message_id: "7700",
			summary: "要約です",
			created_by_user_id: user.id,
		});
	});

	it("要約するほど長くなければ、要約せずにそう伝える", async () => {
		const user = await anthropicUser("171");
		const messages = conversation(user, 7800, 5);
		await saveMessages(
			env.DB,
			messages.map((message) => fromDiscord(message, GUILD_ID)),
		);
		const calls = mockApis([], summaryAi);

		await handleCompactJob(
			compactJob(user.id, messages.at(-1) as APIMessage, null),
			env,
		);

		expect(edits(calls)).toEqual([
			expect.objectContaining({
				body: {
					content:
						"この会話は、まだ要約するほど長くありません(新しい20件より前の発言がありません)。",
				},
			}),
		]);
		expect(
			calls.filter((call) => call.url.hostname === "api.anthropic.com"),
		).toEqual([]);
	});

	it("キーを登録していなければ、登録方法を伝える", async () => {
		const calls = mockApis([], summaryAi);

		await handleCompactJob(
			compactJob("172", discordMessage("7900", ALICE, "要約して"), null),
			env,
		);

		const [edit] = edits(calls);
		const body = edit?.body as { content: string } | undefined;
		expect(body?.content).toContain("`/setup`");
	});

	it("AIに断られたら、そう伝えて、案内のボタンは残す", async () => {
		const user = await anthropicUser("173");
		const messages = conversation(user, 7950, 25);
		await saveMessages(
			env.DB,
			messages.map((message) => fromDiscord(message, GUILD_ID)),
		);
		const calls = mockApis([], () =>
			anthropicStreamOf([{ type: "text", text: "" }], {
				stopReason: "refusal",
			}),
		);

		await handleCompactJob(
			compactJob(user.id, messages.at(-1) as APIMessage, "7974"),
			env,
		);

		expect(edits(calls)).toEqual([
			expect.objectContaining({
				body: { content: "この内容には答えられません。" },
			}),
		]);
	});
});
