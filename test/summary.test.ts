import { env } from "cloudflare:workers";
import type { APIMessage } from "discord-api-types/v10";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearModelInfoCache } from "../src/llm/model-info";
import type { QueueMessage, RespondJob } from "../src/queue/messages";
import { handleRespondJob } from "../src/respond/handler";
import { fromDiscord } from "../src/respond/history";
import type { ResolvedModel } from "../src/respond/model";
import {
	conversationSize,
	FALLBACK_INPUT_LIMIT,
	inputLimit,
	SUMMARY_SYSTEM_PROMPT,
} from "../src/respond/summary";
import { saveMessages } from "../src/store/messages";
import { recordReplyUsage, saveSummary } from "../src/store/summaries";
import { DEFAULT_USER_SETTINGS, saveCredential } from "../src/store/users";
import {
	ALICE,
	at,
	BOT,
	CHANNEL_ID,
	discordMessage,
	discordReply,
} from "./fixtures";
import { anthropicStreamOf, type FetchCall, mockFetch } from "./helpers";

afterEach(() => {
	vi.restoreAllMocks();
	clearModelInfoCache();
});

const GUILD_ID = "900";

/** 保存用のQueueの偽物。テストでは、本物の保存の処理を動かさない */
const testEnv: Env = {
	...env,
	INGEST_QUEUE: {
		send: async () => {},
		sendBatch: async (_batch: Iterable<MessageSendRequest<QueueMessage>>) => {},
	} as unknown as Queue,
};

/**
 * 人(user)とBobertが交互に返信し合う会話。firstIdから続くIDで、count件。
 * 偶数番目が人の発言(「発言i」)、奇数番目がBobertの返答(「返答i」)
 */
function conversation(
	user: typeof ALICE,
	firstId: number,
	count: number,
): APIMessage[] {
	const messages: APIMessage[] = [];
	for (let i = 0; i < count; i++) {
		const id = String(firstId + i);
		const parent = messages.at(-1);
		const author = i % 2 === 0 ? user : BOT;
		const content = i % 2 === 0 ? `発言${i}` : `返答${i}`;
		messages.push(
			parent
				? discordReply(id, author, content, parent)
				: discordMessage(id, author, content),
		);
	}
	return messages;
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

/**
 * DiscordとAIのAPIの偽物。Discordにはtriggerだけがある(それより前は保存してある)。
 * OpenRouterのモデル一覧では、Claude Haiku 5.5の上限をcontextLengthにする。
 * Anthropicは、要約を頼まれたら「要約です」、それ以外は「答えです」と返す
 */
function mockApis(trigger: APIMessage, contextLength: number): FetchCall[] {
	let nextId = 9900;
	return mockFetch((call) => {
		if (call.url.hostname === "discord.com") {
			const path = call.url.pathname.replace("/api/v10", "");
			if (call.method === "GET" && path.endsWith(`/messages/${trigger.id}`)) {
				return Response.json(trigger);
			}
			if (call.method === "POST" && path.endsWith("/typing")) {
				return new Response(null, { status: 204 });
			}
			if (
				call.method === "POST" &&
				path === `/channels/${CHANNEL_ID}/messages`
			) {
				return Response.json({ id: String(nextId++), channel_id: CHANNEL_ID });
			}
			return Response.json({ code: 10008 }, { status: 404 });
		}
		if (call.url.hostname === "openrouter.ai") {
			return Response.json({
				data: [
					{ id: "anthropic/claude-haiku-5.5", context_length: contextLength },
				],
			});
		}
		const body = call.body as { system?: { text: string }[] };
		return body.system?.[0]?.text === SUMMARY_SYSTEM_PROMPT
			? anthropicStreamOf([{ type: "text", text: "要約です" }])
			: anthropicStreamOf([{ type: "text", text: "答えです" }]);
	});
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

/** Anthropicに送ったリクエストのうち、要約を頼んだものと、答えを頼んだもの */
function anthropicRequests(calls: FetchCall[]) {
	const requests = calls
		.filter((call) => call.url.hostname === "api.anthropic.com")
		.map(
			(call) =>
				call.body as {
					system: { text: string }[];
					messages: { role: string; content: { text: string }[] }[];
				},
		);
	return {
		summaries: requests.filter(
			(request) => request.system[0]?.text === SUMMARY_SYSTEM_PROMPT,
		),
		answers: requests.filter(
			(request) => request.system[0]?.text !== SUMMARY_SYSTEM_PROMPT,
		),
	};
}

/** AIに渡した会話の、それぞれの発言の文 */
function texts(request: {
	messages: { role: string; content: { text: string }[] }[];
}) {
	return request.messages.map(
		(message) => `${message.role}: ${message.content[0]?.text}`,
	);
}

describe("長い会話の自動要約", () => {
	it("会話が入力の上限の8割を超えたら、新しい20件を残して、それより前を要約し、保存する", async () => {
		const user = await anthropicUser("150");
		const stored = conversation(user, 7000, 25);
		await saveMessages(
			env.DB,
			stored.map((message) => fromDiscord(message, GUILD_ID)),
		);
		const trigger = discordReply(
			"7025",
			user,
			"続きは?",
			stored.at(-1) as APIMessage,
		);
		// 直前の返答(7023)のときの入力は900トークンで、上限1000の8割を超えている
		await recordReplyUsage(env.DB, ["7023"], 900);
		const calls = mockApis(trigger, 1000);

		await handleRespondJob(respondJob(trigger), testEnv);

		const { summaries, answers } = anthropicRequests(calls);
		// 要約したのは、新しい20件(7006〜7025)より前の6件
		expect(summaries).toHaveLength(1);
		expect(summaries[0]?.messages[0]?.content[0]?.text.split("\n\n")).toEqual([
			at("Alice: 発言0"),
			"[2026-10-24(土) 09:00] Bobert: 返答1",
			at("Alice: 発言2"),
			"[2026-10-24(土) 09:00] Bobert: 返答3",
			at("Alice: 発言4"),
			"[2026-10-24(土) 09:00] Bobert: 返答5",
		]);
		// 答えるときは、要約と、新しい20件を渡す
		const answer = answers[0];
		expect(answer && texts(answer)[0]).toBe(
			"user: (これより前の会話の要約です)\n要約です",
		);
		expect(answer && texts(answer).slice(1, 3)).toEqual([
			`user: ${at("Alice: 発言6")}`,
			"assistant: 返答7",
		]);
		expect(answer?.messages).toHaveLength(21);
		const saved = await env.DB.prepare(
			"SELECT root_message_id, covered_until_message_id, summary, model_key, created_by_user_id FROM conversation_summaries WHERE covered_until_message_id = ?",
		)
			.bind("7005")
			.first();
		expect(saved).toEqual({
			root_message_id: "7000",
			covered_until_message_id: "7005",
			summary: "要約です",
			model_key: "claude-haiku-5-5",
			created_by_user_id: user.id,
		});
	});

	it("保存した要約があれば、要約した位置より前は読まず、要約と、それより後の発言を渡す", async () => {
		const user = await anthropicUser("151");
		const stored = conversation(user, 7100, 10);
		await saveMessages(
			env.DB,
			stored.map((message) => fromDiscord(message, GUILD_ID)),
		);
		await saveSummary(env.DB, {
			rootMessageId: "7100",
			coveredUntilMessageId: "7103",
			summary: "前の要約",
			modelKey: "claude-haiku-5-5",
			createdByUserId: user.id,
		});
		const trigger = discordReply(
			"7110",
			user,
			"続きは?",
			stored.at(-1) as APIMessage,
		);
		const calls = mockApis(trigger, 1000);

		await handleRespondJob(respondJob(trigger), testEnv);

		const { summaries, answers } = anthropicRequests(calls);
		expect(summaries).toEqual([]);
		const answer = answers[0];
		expect(answer && texts(answer)).toEqual([
			"user: (これより前の会話の要約です)\n前の要約",
			`user: ${at("Alice: 発言4")}`,
			"assistant: 返答5",
			`user: ${at("Alice: 発言6")}`,
			"assistant: 返答7",
			`user: ${at("Alice: 発言8")}`,
			"assistant: 返答9",
			`user: ${at("Alice: 続きは?")}`,
		]);
	});

	it("8割を超えていなければ要約せず、返答のときの入力のトークン数を記録する", async () => {
		const user = await anthropicUser("152");
		const stored = conversation(user, 7200, 25);
		await saveMessages(
			env.DB,
			stored.map((message) => fromDiscord(message, GUILD_ID)),
		);
		await recordReplyUsage(env.DB, ["7223"], 700);
		const trigger = discordReply(
			"7225",
			user,
			"続きは?",
			stored.at(-1) as APIMessage,
		);
		const calls = mockApis(trigger, 1000);

		await handleRespondJob(respondJob(trigger), testEnv);

		const { summaries, answers } = anthropicRequests(calls);
		expect(summaries).toEqual([]);
		expect(answers[0]?.messages).toHaveLength(26);
		// 投稿した返答(9900)に、答えを頼んだときの入力のトークン数を記録する
		const usage = await env.DB.prepare(
			"SELECT input_tokens FROM reply_usage WHERE message_id = ?",
		)
			.bind("9900")
			.first<number>("input_tokens");
		expect(usage).toBe(10);
	});
});

describe("会話の量", () => {
	it("会話の中で、いちばん新しいBobertの返答のときに記録した、入力のトークン数", async () => {
		const chain = conversation(ALICE, 7300, 6).map((message) =>
			fromDiscord(message, GUILD_ID),
		);
		await recordReplyUsage(env.DB, ["7301"], 100);
		await recordReplyUsage(env.DB, ["7303"], 300);

		expect(await conversationSize(env.DB, chain, BOT.id)).toBe(300);
		expect(await conversationSize(env.DB, chain.slice(0, 2), BOT.id)).toBe(100);
		expect(
			await conversationSize(env.DB, chain.slice(0, 1), BOT.id),
		).toBeNull();
	});
});

describe("モデルの入力の上限", () => {
	const credential = { apiKey: "sk-ant-test", workspaceId: null };
	const haiku: ResolvedModel = {
		provider: "anthropic",
		modelId: "claude-haiku-5-5",
		label: "Claude Haiku 5.5",
		supportsImages: true,
	};

	it("候補は、OpenRouterのモデル一覧から取る", async () => {
		mockFetch(() =>
			Response.json({
				data: [{ id: "anthropic/claude-haiku-5.5", context_length: 1_000_000 }],
			}),
		);

		expect(await inputLimit(DEFAULT_USER_SETTINGS, haiku, credential)).toBe(
			1_000_000,
		);
	});

	it("「その他」で入力したClaudeは、Anthropicのモデル情報から取る", async () => {
		mockFetch(() =>
			Response.json({
				id: "claude-sonnet-4-6",
				type: "model",
				display_name: "Claude Sonnet 4.6",
				created_at: "2026-01-01T00:00:00Z",
				capabilities: null,
				max_input_tokens: 200_000,
				max_tokens: 64_000,
			}),
		);

		expect(
			await inputLimit(
				{ ...DEFAULT_USER_SETTINGS, modelKey: "custom" },
				{ ...haiku, modelId: "claude-sonnet-4-6", label: "claude-sonnet-4-6" },
				credential,
			),
		).toBe(200_000);
	});

	it("モデル情報を取得できなければ、決めておいた値を使う", async () => {
		mockFetch(() => new Response(null, { status: 503 }));

		expect(await inputLimit(DEFAULT_USER_SETTINGS, haiku, credential)).toBe(
			FALLBACK_INPUT_LIMIT,
		);
	});
});
