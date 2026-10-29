import { env } from "cloudflare:workers";
import type { APIMessage } from "discord-api-types/v10";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InteractionType, MessageType } from "../src/discord/constants";
import { COMMANDS } from "../src/interactions/commands";
import { helpText } from "../src/interactions/help";
import { clearModelInfoCache } from "../src/llm/model-info";
import type {
	ExplainJob,
	QueueMessage,
	RespondJob,
} from "../src/queue/messages";
import { handleExplainJob } from "../src/respond/explain";
import { handleRespondJob } from "../src/respond/handler";
import { fromDiscord } from "../src/respond/history";
import { saveExplainTarget } from "../src/store/explain";
import { saveMessages } from "../src/store/messages";
import { saveCredential } from "../src/store/users";
import {
	ALICE,
	at,
	BOB,
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
/** 説明を頼まれた時刻(日本時間で2026-10-28(水) 10:00) */
const REQUESTED_AT = Date.parse("2026-10-28T01:00:00.000Z");

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
async function anthropicUser(user: typeof ALICE) {
	await saveCredential(env, user.id, "anthropic", {
		apiKey: "sk-ant-test",
		workspaceId: null,
	});
	return user;
}

/**
 * DiscordとAIのAPIの偽物。Discordにはmessagesがあることにする。
 * 保留にした応答を書き換えたら、9960のメッセージになる。新しく投稿したメッセージには、9961から続くIDを付ける
 */
function mockApis(
	messages: APIMessage[],
	ai: (call: FetchCall) => Response,
): FetchCall[] {
	const stored = new Map(messages.map((message) => [message.id, message]));
	let nextId = 9961;
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
		if (call.method === "PATCH" && path.endsWith("/messages/@original")) {
			return Response.json({ id: "9960", channel_id: CHANNEL_ID });
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

/** Anthropicに送った、答えを頼むリクエスト */
function anthropicRequests(calls: FetchCall[]) {
	return calls
		.filter((call) => call.url.hostname === "api.anthropic.com")
		.map(
			(call) =>
				call.body as {
					messages: { role: string; content: { text: string }[] }[];
					tools?: { name: string }[];
				},
		);
}

function explainJob(
	user: typeof ALICE,
	userName: string,
	target: APIMessage,
	interactionId: string,
): ExplainJob {
	return {
		kind: "explain",
		interactionId,
		interactionToken: "interaction-token",
		userId: user.id,
		userName,
		channelId: CHANNEL_ID,
		guildId: GUILD_ID,
		target: fromDiscord(target, GUILD_ID),
		requestedAt: REQUESTED_AT,
	};
}

describe("右クリックメニューの「Bobertに聞く」", () => {
	it("右クリックメニューに「Bobertに聞く」を登録し、/helpにも書く", () => {
		expect(COMMANDS).toContainEqual(
			expect.objectContaining({ type: 3, name: "Bobertに聞く" }),
		);
		expect(helpText()).toContain(
			"- メッセージの右クリックメニュー(アプリ)の「Bobertに聞く」: そのメッセージの意味を説明します",
		);
	});

	it("キーを登録していれば、チャンネルに見える保留の応答を返し、説明の仕事を入れる", async () => {
		const { environment, sent } = fakeQueues();
		const user = await anthropicUser({ ...BOB, id: "180" });
		const target = discordMessage("8000", ALICE, "おはよう、元気?");

		const body = await sendInteraction(
			guildInteraction(
				InteractionType.ApplicationCommand,
				{
					id: "18",
					name: "Bobertに聞く",
					type: 3,
					target_id: "8000",
					resolved: { messages: { "8000": target } },
				},
				user,
			),
			environment,
		);

		// 保留の応答は、本人だけでなくチャンネルに見える(flagsを付けない)
		expect(body).toEqual({ type: 5 });
		expect(sent).toEqual([
			{
				kind: "explain",
				interactionId: "1",
				interactionToken: "interaction-token",
				userId: user.id,
				userName: "bob",
				channelId: CHANNEL_ID,
				guildId: GUILD_ID,
				target: fromDiscord(target, GUILD_ID),
				requestedAt: expect.any(Number),
			},
		]);
	});

	it("キーを登録していなければ、登録方法を本人にだけ見せ、仕事は入れない", async () => {
		const { environment, sent } = fakeQueues();
		const target = discordMessage("8010", ALICE, "おはよう");

		const body = await sendInteraction(
			guildInteraction(
				InteractionType.ApplicationCommand,
				{
					id: "18",
					name: "Bobertに聞く",
					type: 3,
					target_id: "8010",
					resolved: { messages: { "8010": target } },
				},
				{ ...BOB, id: "181" },
			),
			environment,
		);

		expect(body.type).toBe(4);
		expect(body.data.flags).toBe(64);
		expect(body.data.content).toContain("`/setup`");
		expect(sent).toEqual([]);
	});
});

describe("説明の仕事", () => {
	it("説明するメッセージと、頼んだ人の依頼をAIに渡し、保留の応答を書き換えて投稿する", async () => {
		const { environment } = fakeQueues();
		const user = await anthropicUser({ ...BOB, id: "182" });
		const target = discordMessage("8020", ALICE, "おはよう、元気?");
		const calls = mockApis([], () =>
			anthropicStreamOf([{ type: "text", text: "朝のあいさつだよ" }]),
		);

		await handleExplainJob(
			explainJob(user, "ぼぶ", target, "8021"),
			environment,
		);

		const [request] = anthropicRequests(calls);
		expect(request?.messages).toEqual([
			{
				role: "user",
				content: [
					expect.objectContaining({ text: at("Alice: おはよう、元気?") }),
				],
			},
			{
				role: "user",
				content: [
					expect.objectContaining({
						text: "[2026-10-28(水) 10:00] ぼぶ: 上のメッセージの意味を説明して",
					}),
				],
			},
		]);
		// 説明するメッセージが返信でなければ、返信先を読む道具は渡さない
		expect(request?.tools?.map((tool) => tool.name)).toEqual([
			"read_channel_history",
			"search_channel_messages",
			"list_channels",
			"read_file",
		]);
		const edit = calls.find((call) => call.method === "PATCH");
		expect(edit?.url.pathname).toBe(
			`/api/v10/webhooks/${env.DISCORD_APPLICATION_ID}/interaction-token/messages/@original`,
		);
		expect(edit?.body).toEqual({
			content: "朝のあいさつだよ",
			allowed_mentions: { parse: [] },
		});
		// 返答に返信して会話を続けられるよう、返答と説明の対象の対応を保存する
		const saved = await env.DB.prepare(
			"SELECT target_message_id FROM explain_targets WHERE response_message_id = ?",
		)
			.bind("9960")
			.first<string>("target_message_id");
		expect(saved).toBe("8020");
		const usage = await env.DB.prepare(
			"SELECT input_tokens FROM reply_usage WHERE message_id = ?",
		)
			.bind("9960")
			.first<number>("input_tokens");
		expect(usage).toBe(10);
	});

	it("説明するメッセージが返信なら、返信先を読む道具を渡す(返信のつながりは最初から渡さない)", async () => {
		const { environment } = fakeQueues();
		const user = await anthropicUser({ ...BOB, id: "183" });
		const parent = discordMessage("8030", ALICE, "明日の集まり、何時から?");
		const target = discordReply("8031", BOB, "いつもどおり", parent);
		const calls = mockApis([parent], () =>
			anthropicStreamOf([{ type: "text", text: "集まりの時間のことだよ" }]),
		);

		await handleExplainJob(
			explainJob(user, "ぼぶ", target, "8032"),
			environment,
		);

		const [request] = anthropicRequests(calls);
		expect(request?.messages).toHaveLength(2);
		expect(request?.tools?.map((tool) => tool.name)).toEqual([
			"read_channel_history",
			"search_channel_messages",
			"list_channels",
			"read_file",
			"read_reply_chain",
		]);
	});

	it("長い説明は分けて、2通目からは前のメッセージへの返信にする。同じ仕事は2回投稿しない", async () => {
		const { environment } = fakeQueues();
		const user = await anthropicUser({ ...BOB, id: "184" });
		const target = discordMessage("8040", ALICE, "長い話");
		const longText = `${"あ".repeat(1500)}\n\n${"い".repeat(1500)}`;
		const calls = mockApis([], () =>
			anthropicStreamOf([{ type: "text", text: longText }]),
		);
		const job = explainJob(user, "ぼぶ", target, "8041");

		await handleExplainJob(job, environment);
		await handleExplainJob(job, environment);

		const posts = calls.filter(
			(call) =>
				call.method === "POST" &&
				call.url.pathname === `/api/v10/channels/${CHANNEL_ID}/messages`,
		);
		expect(posts.map((call) => call.body)).toEqual([
			{
				content: "い".repeat(1500),
				message_reference: { message_id: "9960", fail_if_not_exists: false },
				allowed_mentions: { parse: [], replied_user: false },
			},
		]);
		expect(calls.filter((call) => call.method === "PATCH")).toHaveLength(1);
	});
});

describe("説明に返信して、会話を続ける", () => {
	it("説明の返答をたどった先に、説明の対象のメッセージを入れる(その返信先まではたどらない)", async () => {
		const { environment } = fakeQueues();
		const user = await anthropicUser({ ...BOB, id: "185" });
		const parent = discordMessage("8050", BOB, "明日の集まり、何時から?");
		const target = discordReply("8051", ALICE, "いつもどおり", parent);
		// 「Bobertに聞く」の返答は、返信ではない(右クリックメニューのコマンドへの返答)
		const explanation = discordMessage("8052", BOT, "集まりの時間のことだよ", {
			type: MessageType.ContextMenuCommand,
		});
		await saveMessages(
			env.DB,
			[parent, target, explanation].map((message) =>
				fromDiscord(message, GUILD_ID),
			),
		);
		await saveExplainTarget(env.DB, "8052", "8051");
		const followUp = discordReply("8053", user, "いつもって何時?", explanation);
		const calls = mockApis([followUp], () =>
			anthropicStreamOf([{ type: "text", text: "10時だね" }]),
		);
		const job: RespondJob = {
			kind: "respond",
			messageId: followUp.id,
			channelId: CHANNEL_ID,
			guildId: GUILD_ID,
			authorId: user.id,
		};

		await handleRespondJob(job, environment);

		const [request] = anthropicRequests(calls);
		expect(
			request?.messages.map(
				(message) => `${message.role}: ${message.content[0]?.text}`,
			),
		).toEqual([
			`user: ${at("Alice: いつもどおり")}`,
			"assistant: 集まりの時間のことだよ",
			`user: ${at("bob: いつもって何時?")}`,
		]);
	});
});
