import { env } from "cloudflare:workers";
import type { APIMessage } from "discord-api-types/v10";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ComponentType,
	InteractionResponseType,
	InteractionType,
	MessageFlags,
} from "../src/discord/constants";
import { COMMANDS } from "../src/interactions/commands";
import { helpText } from "../src/interactions/help";
import { JEV_SYSTEM_PROMPT } from "../src/jev/prompt";
import {
	JEV_ERROR,
	JEV_NO_QUESTION,
	TYPESAFE_KEY_INVALID,
	TYPESAFE_KEY_REQUIRED,
} from "../src/jev/texts";
import { parseAsk } from "../src/jev/tool";
import { clearModelInfoCache } from "../src/llm/model-info";
import type { JevJob, QueueMessage } from "../src/queue/messages";
import { fromDiscord } from "../src/respond/history";
import { handleJevJob } from "../src/respond/jev";
import { RATE_LIMITED_TEXT } from "../src/respond/replies";
import {
	hasTypeSafeKey,
	loadTypeSafeKey,
	saveTypeSafeKey,
} from "../src/store/typesafe";
import {
	deleteUserData,
	type Provider,
	saveCredential,
} from "../src/store/users";
import {
	ALICE,
	at,
	BOB,
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
/** 頼まれた時刻(日本時間で2026-10-28(水) 10:00) */
const REQUESTED_AT = Date.parse("2026-10-28T01:00:00.000Z");
const TYPESAFE_KEY = "ts-test-key-123";

/** 応答用のQueueの偽物。入れた仕事を記録する */
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

/** キーを登録した人(このファイルのユーザーIDは65000番台) */
async function registered(
	id: string,
	providers: Provider[],
	typeSafe: boolean,
) {
	for (const provider of providers) {
		await saveCredential(env, id, provider, {
			apiKey: `key-${provider}`,
			workspaceId: null,
		});
	}
	if (typeSafe) {
		await saveTypeSafeKey(env, id, TYPESAFE_KEY);
	}
	return { ...BOB, id };
}

/**
 * Discord、AI、TypeSafeのAPIの偽物。Discordにはmessagesがあることにする。
 * 保留にした応答を書き換えたら、9960のメッセージになる。新しく投稿したメッセージには、9961から続くIDを付ける
 */
function mockApis(
	messages: APIMessage[],
	apis: {
		ai: (call: FetchCall) => Response;
		jev?: (call: FetchCall) => Response;
	},
): FetchCall[] {
	const stored = new Map(messages.map((message) => [message.id, message]));
	let nextId = 9961;
	return mockFetch((call) => {
		if (call.url.hostname === "api.typesafe.ai") {
			return apis.jev?.(call) ?? new Response(null, { status: 500 });
		}
		if (call.url.hostname !== "discord.com") {
			return apis.ai(call);
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
		if (call.method === "POST" && path === `/channels/${CHANNEL_ID}/messages`) {
			return Response.json({ id: String(nextId++), channel_id: CHANNEL_ID });
		}
		return new Response(null, { status: 500 });
	});
}

interface AnthropicRequest {
	system: { text: string }[];
	messages: {
		role: string;
		content: {
			type: string;
			text?: string;
			content?: string;
			tool_use_id?: string;
		}[];
	}[];
	tools?: { name: string }[];
}

/** Anthropicに送ったリクエスト */
function anthropicRequests(calls: FetchCall[]): AnthropicRequest[] {
	return calls
		.filter((call) => call.url.hostname === "api.anthropic.com")
		.map((call) => call.body as AnthropicRequest);
}

/** TypeSafe(Jev)に送ったリクエスト */
function jevCalls(calls: FetchCall[]): FetchCall[] {
	return calls.filter((call) => call.url.hostname === "api.typesafe.ai");
}

/** 投稿した結果(保留にした応答の書き換え) */
function postedResult(calls: FetchCall[]) {
	return calls.find((call) => call.method === "PATCH")?.body as
		| { content: string; allowed_mentions: unknown }
		| undefined;
}

/** AIが「Jevに聞く」の道具を呼んだ応答(Anthropic) */
function askJev(input: unknown, id = "toolu_jev") {
	return anthropicStreamOf(
		[
			{ type: "text", text: "調べてから聞きます" },
			{ type: "tool_use", id, name: "ask_jev", input },
		],
		{ stopReason: "tool_use" },
	);
}

/** Jevの成功の応答 */
function jevAnswered(answers: Record<string, unknown>): Response {
	return Response.json({
		model: "jev-1.14.0",
		answers,
		usage: { input_tokens: 300, output_tokens: 20 },
	});
}

/** はい/いいえの質問1つの入力 */
const NOUL_INPUT = {
	meaning: "Alice asks whether Osaka is the capital of Japan.",
	context: "",
	questions: [
		{
			type: "noul",
			question: "Is Osaka the capital of Japan?",
			display_question: "日本の首都は大阪である",
			yes: "Osaka is the capital of Japan.",
			no: "Osaka is not the capital of Japan.",
		},
	],
};

function jevJob(
	user: { id: string },
	target: APIMessage,
	interactionId: string,
): JevJob {
	return {
		kind: "jev",
		interactionId,
		interactionToken: "interaction-token",
		userId: user.id,
		userName: "ぼぶ",
		channelId: CHANNEL_ID,
		guildId: GUILD_ID,
		target: fromDiscord(target, GUILD_ID),
		requestedAt: REQUESTED_AT,
	};
}

/** 右クリックメニューで「Jevに聞く」を選んだInteraction */
function menuInteraction(user: { id: string }, target: APIMessage) {
	return guildInteraction(
		InteractionType.ApplicationCommand,
		{
			id: "19",
			name: "Jevに聞く",
			type: 3,
			target_id: target.id,
			resolved: { messages: { [target.id]: target } },
		},
		{ ...BOB, id: user.id },
	);
}

describe("右クリックメニューの「Jevに聞く」", () => {
	it("右クリックメニューに「Jevに聞く」を登録し、/helpにも書く", () => {
		expect(COMMANDS).toContainEqual(
			expect.objectContaining({ type: 3, name: "Jevに聞く" }),
		);
		expect(helpText()).toContain(
			"- メッセージの右クリックメニュー(アプリ)の「Jevに聞く」: AIがメッセージと前後の会話を読んで質問を作り、Jevが確率で答えます。TypeSafeのAPIキーの登録が必要です",
		);
	});

	it("AIのキーとTypeSafeのキーがあれば、チャンネルに見える保留の応答を返し、仕事を入れる", async () => {
		const { environment, sent } = fakeQueues();
		const user = await registered("65001", ["anthropic"], true);
		const target = discordMessage("65100", ALICE, "日本の首都は大阪だよね?");

		const body = await sendInteraction(
			menuInteraction(user, target),
			environment,
		);

		// 保留の応答は、本人だけでなくチャンネルに見える(flagsを付けない)
		expect(body).toEqual({ type: 5 });
		expect(sent).toEqual([
			{
				kind: "jev",
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

	it("TypeSafeのキーを登録していなければ、登録方法を本人にだけ見せ、仕事は入れない", async () => {
		const { environment, sent } = fakeQueues();
		const user = await registered("65002", ["anthropic"], false);
		const target = discordMessage("65101", ALICE, "おはよう");

		const body = await sendInteraction(
			menuInteraction(user, target),
			environment,
		);

		expect(body).toEqual({
			type: 4,
			data: { content: TYPESAFE_KEY_REQUIRED, flags: 64 },
		});
		expect(sent).toEqual([]);
	});

	it("AIのキーを登録していなければ、AIのキーの登録方法を本人にだけ見せる", async () => {
		const { environment, sent } = fakeQueues();
		const user = await registered("65003", [], true);
		const target = discordMessage("65102", ALICE, "おはよう");

		const body = await sendInteraction(
			menuInteraction(user, target),
			environment,
		);

		expect(body.type).toBe(4);
		expect(body.data.flags).toBe(64);
		expect(body.data.content).toContain("AIのキーの登録が必要です");
		expect(sent).toEqual([]);
	});
});

describe("「Jevに聞く」の仕事", () => {
	it("AIが作った質問でJevに聞き、AIには結果を返さずに、Jevの回答を投稿する", async () => {
		const { environment } = fakeQueues();
		const user = await registered("65010", ["anthropic"], true);
		const target = discordMessage("65110", ALICE, "日本の首都は大阪だよね?");
		const calls = mockApis([], {
			ai: () => askJev(NOUL_INPUT),
			jev: () => jevAnswered({ q1: { type: "noul", noul: 0.03 } }),
		});

		await handleJevJob(jevJob(user, target, "65111"), environment);

		// Jevが答えたら、AIとのやり取りを終える(結果をAIに返して、続きを頼まない)
		const requests = anthropicRequests(calls);
		expect(requests).toHaveLength(1);
		const [request] = requests;
		expect(request?.system.map((block) => block.text)).toEqual([
			JEV_SYSTEM_PROMPT,
		]);
		expect(request?.messages).toEqual([
			{
				role: "user",
				content: [
					expect.objectContaining({
						text: at("Alice: 日本の首都は大阪だよね?"),
					}),
				],
			},
			{
				role: "user",
				content: [
					expect.objectContaining({
						text: "[2026-10-28(水) 10:00] ぼぶ: 上のメッセージについて、Jevに聞いて",
					}),
				],
			},
		]);
		// 文脈を調べる道具と、Jevに聞く道具を渡す(メンバーを探す道具は渡さない)
		expect(request?.tools?.map((tool) => tool.name)).toEqual([
			"read_channel_history",
			"search_channel_messages",
			"list_channels",
			"read_pinned_messages",
			"read_file",
			"ask_jev",
		]);

		const [jev] = jevCalls(calls);
		expect(jev?.method).toBe("POST");
		expect(jev?.url.href).toBe("https://api.typesafe.ai/v1/systemone");
		expect(jev?.headers.get("Authorization")).toBe(`Bearer ${TYPESAFE_KEY}`);
		expect(jev?.body).toEqual({
			model: "jev-latest",
			state: {
				message: { author: "Alice", text: "日本の首都は大阪だよね?" },
				meaning: "Alice asks whether Osaka is the capital of Japan.",
			},
			questions: {
				q1: {
					type: "noul",
					instructions: "Is Osaka the capital of Japan?",
					criteria: {
						true: "Osaka is the capital of Japan.",
						false: "Osaka is not the capital of Japan.",
					},
				},
			},
		});

		expect(postedResult(calls)).toEqual({
			content: "**Jevの回答**: 日本の首都は大阪である\nはい 3%・**いいえ 97%**",
			allowed_mentions: { parse: [] },
		});
		// 結果に返信して会話を続けられるよう、結果と対象のメッセージの対応を保存する
		const saved = await env.DB.prepare(
			"SELECT target_message_id FROM explain_targets WHERE response_message_id = ?",
		)
			.bind("9960")
			.first<string>("target_message_id");
		expect(saved).toBe("65110");
	});

	it("選択肢は確率の高い順に、段階は低い順に並べ、いちばん高いものを太字にする", async () => {
		const { environment } = fakeQueues();
		const user = await registered("65011", ["anthropic"], true);
		const target = discordMessage(
			"65120",
			ALICE,
			"週末どこに集まる?あと、この計画いけそう?",
		);
		const calls = mockApis([], {
			ai: () =>
				askJev({
					meaning: "Alice asks where to meet and whether the plan is feasible.",
					context: "They plan a meetup this Saturday. Rain is forecast.",
					questions: [
						{
							type: "choice",
							question: "Which place suits the weekend meetup best?",
							display_question: "週末の集まりに合う場所はどれか",
							options: [
								{ label: "公園", description: "The park" },
								{
									label: "駅前のカフェ",
									description: "The cafe by the station",
								},
								{ label: "誰かの家", description: "Someone's home" },
							],
						},
						{
							type: "score",
							question: "How feasible is the plan?",
							display_question: "この計画の実現しやすさ",
							levels: [
								{ label: "とても難しい", description: "Very hard" },
								{ label: "難しい", description: "Hard" },
								{ label: "ふつう", description: "Moderate" },
								{ label: "やりやすい", description: "Easy" },
								{ label: "すぐできる", description: "Trivial" },
							],
						},
					],
				}),
			jev: () =>
				jevAnswered({
					q1: {
						type: "choice",
						choice: "B",
						confidence: 0.52,
						probabilities: { A: 0.28, B: 0.64, C: 0.08 },
					},
					q2: {
						type: "score",
						score: 2.63,
						confidence: 0.6,
						probabilities: { 0: 0.01, 1: 0.09, 2: 0.3, 3: 0.5, 4: 0.1 },
						legend: {
							0: "Very hard",
							1: "Hard",
							2: "Moderate",
							3: "Easy",
							4: "Trivial",
						},
					},
				}),
		});

		await handleJevJob(jevJob(user, target, "65121"), environment);

		// 選択肢の名前はA、B、…にして、説明で判断してもらう。文脈があれば、stateに入れる
		expect(jevCalls(calls)[0]?.body).toMatchObject({
			state: {
				context: "They plan a meetup this Saturday. Rain is forecast.",
			},
			questions: {
				q1: {
					type: "choice",
					instructions: "Which place suits the weekend meetup best?",
					criteria: {
						A: "The park",
						B: "The cafe by the station",
						C: "Someone's home",
					},
				},
				q2: {
					type: "score",
					instructions: "How feasible is the plan?",
					criteria: ["Very hard", "Hard", "Moderate", "Easy", "Trivial"],
				},
			},
		});
		expect(postedResult(calls)?.content).toBe(
			[
				"**Jevの回答**: 週末の集まりに合う場所はどれか",
				"- **駅前のカフェ 64%**",
				"- 公園 28%",
				"- 誰かの家 8%",
				"",
				"**Jevの回答**: この計画の実現しやすさ",
				"スコア 2.6(0〜4)",
				"- 0 とても難しい 1%",
				"- 1 難しい 9%",
				"- 2 ふつう 30%",
				"- **3 やりやすい 50%**",
				"- 4 すぐできる 10%",
			].join("\n"),
		);
	});

	it("対象のメッセージが返信なら、返信先を読む道具も渡す", async () => {
		const { environment } = fakeQueues();
		const user = await registered("65012", ["anthropic"], true);
		const parent = discordMessage("65130", BOB, "明日の集まり、来る?");
		const target = discordReply("65131", ALICE, "たぶん", parent);
		const calls = mockApis([parent], {
			ai: () => askJev(NOUL_INPUT),
			jev: () => jevAnswered({ q1: { type: "noul", noul: 0.5 } }),
		});

		await handleJevJob(jevJob(user, target, "65132"), environment);

		expect(
			anthropicRequests(calls)[0]?.tools?.map((tool) => tool.name),
		).toEqual([
			"read_channel_history",
			"search_channel_messages",
			"list_channels",
			"read_pinned_messages",
			"read_file",
			"read_reply_chain",
			"ask_jev",
		]);
		// 確率が同じなら、どちらも太字にしない
		expect(postedResult(calls)?.content).toBe(
			"**Jevの回答**: 日本の首都は大阪である\nはい 50%・いいえ 50%",
		);
	});

	it("入力が正しくなければ、Jevを呼ばずに理由をAIに返し、直した入力で聞く", async () => {
		const { environment } = fakeQueues();
		const user = await registered("65013", ["anthropic"], true);
		const target = discordMessage("65140", ALICE, "どれがいい?");
		let round = 0;
		const calls = mockApis([], {
			ai: () => {
				round++;
				return round === 1
					? askJev(
							{
								meaning: "Alice asks which is best.",
								context: "",
								questions: [
									{
										type: "choice",
										question: "Which is best?",
										display_question: "どれがいいか",
									},
								],
							},
							"toolu_1",
						)
					: askJev(NOUL_INPUT, "toolu_2");
			},
			jev: () => jevAnswered({ q1: { type: "noul", noul: 0.9 } }),
		});

		await handleJevJob(jevJob(user, target, "65141"), environment);

		const requests = anthropicRequests(calls);
		expect(requests).toHaveLength(2);
		const toolResult = requests[1]?.messages.at(-1)?.content[0];
		expect(toolResult).toMatchObject({
			type: "tool_result",
			tool_use_id: "toolu_1",
			content:
				"入力が正しくありません。直して、もう一度呼んでください。\n- questions[0].optionsには、2〜10個書いてください。",
		});
		expect(jevCalls(calls)).toHaveLength(1);
		expect(postedResult(calls)?.content).toBe(
			"**Jevの回答**: 日本の首都は大阪である\n**はい 90%**・いいえ 10%",
		);
	});

	it("Jevがリクエストを受け付けなければ、理由をAIに返して直してもらう", async () => {
		const { environment } = fakeQueues();
		const user = await registered("65014", ["anthropic"], true);
		const target = discordMessage("65150", ALICE, "本当?");
		let round = 0;
		const calls = mockApis([], {
			ai: () => {
				round++;
				return askJev(NOUL_INPUT, `toolu_${round}`);
			},
			jev: () =>
				jevCalls(calls).length === 1
					? Response.json(
							{
								detail: [
									{
										loc: ["body", "questions", "q1", "instructions"],
										msg: "String should have at most 500 characters",
										type: "string_too_long",
									},
								],
							},
							{ status: 422 },
						)
					: jevAnswered({ q1: { type: "noul", noul: 0.2 } }),
		});

		await handleJevJob(jevJob(user, target, "65151"), environment);

		const requests = anthropicRequests(calls);
		expect(requests).toHaveLength(2);
		expect(requests[1]?.messages.at(-1)?.content[0]).toMatchObject({
			type: "tool_result",
			tool_use_id: "toolu_1",
			content:
				"Jevがリクエストを受け付けませんでした(ステータス 422)。直して、もう一度呼んでください。\nbody.questions.q1.instructions: String should have at most 500 characters",
		});
		expect(jevCalls(calls)).toHaveLength(2);
		expect(postedResult(calls)?.content).toBe(
			"**Jevの回答**: 日本の首都は大阪である\nはい 20%・**いいえ 80%**",
		);
	});

	it.each([
		{ status: 401, text: TYPESAFE_KEY_INVALID, userId: "65021" },
		{ status: 429, text: RATE_LIMITED_TEXT, userId: "65022" },
		{ status: 529, text: JEV_ERROR, userId: "65023" },
	])(
		"Jevの呼び出しが$statusで失敗したら、AIに続きを頼まずに理由を投稿する",
		async ({ status, text, userId }) => {
			const { environment } = fakeQueues();
			const user = await registered(userId, ["anthropic"], true);
			const target = discordMessage("65160", ALICE, "本当?");
			const calls = mockApis([], {
				ai: () => askJev(NOUL_INPUT),
				jev: () => Response.json({ detail: "error" }, { status }),
			});

			await handleJevJob(jevJob(user, target, `6516${status}`), environment);

			expect(anthropicRequests(calls)).toHaveLength(1);
			expect(postedResult(calls)?.content).toBe(text);
		},
	);

	it("同じ回に2回呼ばれても、直せない失敗の後は、もうJevを呼ばない", async () => {
		const { environment } = fakeQueues();
		const user = await registered("65024", ["anthropic"], true);
		const target = discordMessage("65165", ALICE, "本当?");
		const calls = mockApis([], {
			ai: () =>
				anthropicStreamOf(
					[
						{
							type: "tool_use",
							id: "toolu_a",
							name: "ask_jev",
							input: NOUL_INPUT,
						},
						{
							type: "tool_use",
							id: "toolu_b",
							name: "ask_jev",
							input: NOUL_INPUT,
						},
					],
					{ stopReason: "tool_use" },
				),
			jev: () => Response.json({ detail: "invalid key" }, { status: 401 }),
		});

		await handleJevJob(jevJob(user, target, "65166"), environment);

		expect(jevCalls(calls)).toHaveLength(1);
		expect(anthropicRequests(calls)).toHaveLength(1);
		expect(postedResult(calls)?.content).toBe(TYPESAFE_KEY_INVALID);
	});

	it("AIがJevに聞かずに終えたら、質問を作れなかったと投稿する", async () => {
		const { environment } = fakeQueues();
		const user = await registered("65030", ["anthropic"], true);
		const target = discordMessage("65170", ALICE, "おはよう");
		const calls = mockApis([], {
			ai: () => anthropicStreamOf([{ type: "text", text: "挨拶だね" }]),
		});

		await handleJevJob(jevJob(user, target, "65171"), environment);

		expect(jevCalls(calls)).toHaveLength(0);
		expect(postedResult(calls)?.content).toBe(JEV_NO_QUESTION);
	});

	it("選んだ後にTypeSafeのキーが消されていたら、AIを呼ばずに登録方法を投稿する", async () => {
		const { environment } = fakeQueues();
		const user = await registered("65031", ["anthropic"], false);
		const target = discordMessage("65180", ALICE, "本当?");
		const calls = mockApis([], {
			ai: () => askJev(NOUL_INPUT),
		});

		await handleJevJob(jevJob(user, target, "65181"), environment);

		expect(anthropicRequests(calls)).toHaveLength(0);
		expect(postedResult(calls)?.content).toBe(TYPESAFE_KEY_REQUIRED);
	});

	it("同じ仕事は2回投稿しない", async () => {
		const { environment } = fakeQueues();
		const user = await registered("65032", ["anthropic"], true);
		const target = discordMessage("65190", ALICE, "本当?");
		const job = jevJob(user, target, "65191");
		const calls = mockApis([], {
			ai: () => askJev(NOUL_INPUT),
			jev: () => jevAnswered({ q1: { type: "noul", noul: 0.7 } }),
		});

		await handleJevJob(job, environment);
		await handleJevJob(job, environment);

		expect(jevCalls(calls)).toHaveLength(1);
		expect(calls.filter((call) => call.method === "PATCH")).toHaveLength(1);
	});

	it("OpenRouterのモデルでも、Jevが答えたらAIとのやり取りを終える", async () => {
		const { environment } = fakeQueues();
		const user = await registered("65033", ["openrouter"], true);
		const target = discordMessage("65200", ALICE, "本当?");
		const calls = mockApis([], {
			ai: () =>
				Response.json({
					choices: [
						{
							message: {
								content: null,
								tool_calls: [
									{
										id: "call_1",
										type: "function",
										function: {
											name: "ask_jev",
											arguments: JSON.stringify(NOUL_INPUT),
										},
									},
								],
							},
							finish_reason: "tool_calls",
						},
					],
					usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.0001 },
				}),
			jev: () => jevAnswered({ q1: { type: "noul", noul: 0.6 } }),
		});

		await handleJevJob(jevJob(user, target, "65201"), environment);

		expect(
			calls.filter((call) => call.url.hostname === "openrouter.ai"),
		).toHaveLength(1);
		expect(postedResult(calls)?.content).toBe(
			"**Jevの回答**: 日本の首都は大阪である\n**はい 60%**・いいえ 40%",
		);
	});
});

describe("「Jevに聞く」の道具の入力", () => {
	it("表示する文の改行は空白にし、Markdownの記号はそのまま表示する", async () => {
		const { environment } = fakeQueues();
		const user = await registered("65040", ["anthropic"], true);
		const target = discordMessage("65210", ALICE, "本当?");
		const calls = mockApis([], {
			ai: () =>
				askJev({
					...NOUL_INPUT,
					questions: [
						{
							...NOUL_INPUT.questions[0],
							display_question: "**太字**の\n質問",
						},
					],
				}),
			jev: () => jevAnswered({ q1: { type: "noul", noul: 0.7 } }),
		});

		await handleJevJob(jevJob(user, target, "65211"), environment);

		expect(postedResult(calls)?.content).toBe(
			"**Jevの回答**: \\*\\*太字\\*\\*の 質問\n**はい 70%**・いいえ 30%",
		);
	});

	it("質問の数、型、選択肢の名前の重なりを確かめる", () => {
		const result = parseAsk({
			meaning: "m",
			context: "",
			questions: [
				{ type: "noul", question: "q", display_question: "d", yes: "y" },
				{
					type: "choice",
					question: "q",
					display_question: "d",
					options: [
						{ label: "同じ", description: "a" },
						{ label: "同じ", description: "b" },
					],
				},
				{ type: "box", question: "q", display_question: "d" },
			],
		});

		expect(result).toEqual({
			ok: false,
			problems: [
				"questions[0].noを、文で書いてください。",
				"questions[1].optionsのlabelは、それぞれ違う名前にしてください。",
				"questions[2].typeは、noul、choice、scoreのどれかにしてください。",
			],
		});
		expect(
			parseAsk({ meaning: "m", context: "", questions: [] }),
		).toMatchObject({
			ok: false,
			problems: ["questionsには、質問を1〜3個書いてください。"],
		});
	});
});

describe("/setup のTypeSafeのキー", () => {
	/** TypeSafeのキーの登録のモーダルの送信 */
	function typeSafeModalSubmit(apiKey: string, userId: string) {
		return guildInteraction(
			InteractionType.ModalSubmit,
			{
				custom_id: "setup:typesafe",
				components: [
					{
						type: ComponentType.Label,
						id: 1,
						component: {
							type: ComponentType.TextInput,
							id: 2,
							custom_id: "api_key",
							value: apiKey,
						},
					},
				],
			},
			{ ...ALICE, id: userId },
		);
	}

	it("/setupに、TypeSafeの登録の状態と、登録のボタンを出す", async () => {
		mockFetch(() => Response.json({}));
		const body = await sendInteraction(
			guildInteraction(
				InteractionType.ApplicationCommand,
				{ id: "10", name: "setup", type: 1 },
				{ ...ALICE, id: "65050" },
			),
		);

		expect(body.data.content).toBe(
			[
				"Bobertで使うプロバイダを登録します。",
				"",
				"- Anthropic: 未登録",
				"- OpenRouter: 未連携",
				"- TypeSafe: 未登録",
				"",
				"-# OpenRouterとの連携のリンクは10分間有効です。",
				"-# TypeSafeのキーは、右クリックメニューの「Jevに聞く」で使います。",
			].join("\n"),
		);
		expect(body.data.components[0].components[2]).toMatchObject({
			custom_id: "setup:typesafe",
			label: "TypeSafeのキーを登録",
		});
	});

	it("ボタンを押すと、キーを入力するモーダルを開く", async () => {
		const body = await sendInteraction(
			guildInteraction(InteractionType.MessageComponent, {
				custom_id: "setup:typesafe",
				component_type: ComponentType.Button,
			}),
		);

		expect(body.type).toBe(InteractionResponseType.Modal);
		expect(body.data.title).toBe("TypeSafeのAPIキーの登録");
		expect(body.data.components[0]).toMatchObject({
			label: "APIキー",
			description: "TypeSafeのコンソール(console.typesafe.ai)で発行したキー",
			component: { custom_id: "api_key", required: true },
		});
	});

	it("入力されたキーが有効なら、暗号化して保存し、結果を知らせる", async () => {
		const calls = mockFetch(({ url }) =>
			url.hostname === "api.typesafe.ai"
				? Response.json({ models: [] })
				: Response.json({}),
		);

		const body = await sendInteraction(
			typeSafeModalSubmit(" ts-valid-key ", "65051"),
		);

		expect(body).toEqual({
			type: InteractionResponseType.DeferredChannelMessageWithSource,
			data: { flags: MessageFlags.Ephemeral },
		});
		// 料金のかからない、モデルの一覧のAPIで確かめる。入力の前後の空白は取り除く
		const check = calls.find((call) => call.url.hostname === "api.typesafe.ai");
		expect(check?.url.href).toBe("https://api.typesafe.ai/v1/models");
		expect(check?.headers.get("Authorization")).toBe("Bearer ts-valid-key");
		expect(await loadTypeSafeKey(env, "65051")).toBe("ts-valid-key");
		// 暗号化して保存する
		const row = await env.DB.prepare(
			"SELECT ciphertext FROM typesafe_credentials WHERE user_id = ?",
		)
			.bind("65051")
			.first<string>("ciphertext");
		expect(row).not.toContain("ts-valid-key");
		const edit = calls.find((call) => call.url.hostname === "discord.com");
		expect(edit?.body).toEqual({
			content:
				"TypeSafeのAPIキーを登録しました。メッセージの右クリックメニュー(アプリ)の「Jevに聞く」で使えます。",
		});
	});

	it("キーが使えなければ、保存せずに知らせる", async () => {
		const calls = mockFetch(({ url }) =>
			url.hostname === "api.typesafe.ai"
				? Response.json({ detail: "invalid" }, { status: 401 })
				: Response.json({}),
		);

		await sendInteraction(typeSafeModalSubmit("ts-invalid-key", "65052"));

		expect(await hasTypeSafeKey(env.DB, "65052")).toBe(false);
		const edit = calls.find((call) => call.url.hostname === "discord.com");
		expect(edit?.body).toEqual({
			content:
				"このAPIキーは使えませんでした。キーを確かめて、もう一度登録してください。",
		});
	});

	it("/deleteで、TypeSafeのキーも消す", async () => {
		await saveTypeSafeKey(env, "65053", TYPESAFE_KEY);

		await deleteUserData(env.DB, "65053");

		expect(await hasTypeSafeKey(env.DB, "65053")).toBe(false);
	});
});
