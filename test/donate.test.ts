import { env } from "cloudflare:workers";
import type { APIMessage, APIUser } from "discord-api-types/v10";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ComponentType,
	InteractionResponseType,
	InteractionType,
	MessageFlags,
} from "../src/discord/constants";
import { COMMANDS } from "../src/interactions/commands";
import { parseDonationAmount } from "../src/interactions/donate";
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
import {
	addDonation,
	chargeDonation,
	endDonation,
	pauseDonation,
} from "../src/store/donations";
import { saveMessages } from "../src/store/messages";
import { saveCredential, updateUserSettings } from "../src/store/users";
import {
	ALICE,
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

/** 寄付の画面の、寄付する人への説明 */
const EXPLANATION = [
	"寄付すると、指定した額を使い切るまで、このサーバーのほかの人への返答に、あなたのキーを使います。キーを登録している人の返答にも、先に寄付を使います。",
	"-# 費用は概算です。使い切る直前の返答の分だけ、少し超えることがあります。",
	"-# 寄付で答えた会話は、あなたのアカウント(AnthropicかOpenRouter)に送られます。その利用には、あなたのアカウントの規約が適用されます。",
];

/** キーのない人への案内 */
const SETUP_GUIDANCE =
	"Bobertと話すには、AIのキーの登録が必要です。`/setup` から、AnthropicのAPIキーを登録するか、OpenRouterと連携してください。費用は、登録した本人のアカウントに請求されます。";

/** テストごとに、ほかのテストと重ならないIDを使う(寄付はサーバーごとなので、サーバーのIDも) */
let nextId = 4300;
function newId(): string {
	return String(nextId++);
}

/** Anthropicのキーを登録した人。キーにIDを入れて、どの人のキーで呼んだか分かるようにする */
async function withAnthropicKey(name: string): Promise<APIUser> {
	const user = { ...ALICE, id: newId(), username: name, global_name: null };
	await saveCredential(env, user.id, "anthropic", {
		apiKey: anthropicKey(user),
		workspaceId: null,
	});
	return user;
}

/** キーを登録していない人 */
function withoutKey(name: string): APIUser {
	return { ...BOB, id: newId(), username: name, global_name: null };
}

function anthropicKey(user: APIUser): string {
	return `sk-ant-${user.id}`;
}

/** serverIdのサーバーに、donorがusdドル寄付する */
async function donate(
	guildId: string,
	donor: APIUser,
	usd: number,
	now = Date.now(),
): Promise<void> {
	await addDonation(
		env.DB,
		{
			guildId,
			donorId: donor.id,
			donorName: donor.username,
			amountMicros: Math.round(usd * 1_000_000),
		},
		now,
	);
}

/** 保存した寄付の行 */
function donationRow(guildId: string, donorId: string) {
	return env.DB.prepare(
		"SELECT remaining_micros, donated_at, ended_at, paused_until FROM donations WHERE guild_id = ? AND donor_id = ?",
	)
		.bind(guildId, donorId)
		.first<{
			remaining_micros: number;
			donated_at: number;
			ended_at: number | null;
			paused_until: number | null;
		}>();
}

/** 保存用と応答用のQueueの偽物 */
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

/**
 * DiscordとAIのAPIの偽物。Discordにはmessagesがあることにする。
 * leftの人は、サーバーにいない。invalidKeysのキーでAnthropicを呼ぶと、無効なキーのエラーになる。
 * OpenRouterのモデル一覧は取得できない(Claudeの費用は、候補の一覧の単価で見積もる)
 */
function mockApis(
	messages: APIMessage[],
	options: {
		left?: string[];
		invalidKeys?: string[];
		anthropic?: (call: FetchCall) => Response;
	} = {},
): FetchCall[] {
	const stored = new Map(messages.map((message) => [message.id, message]));
	let postedId = 9980;
	return mockFetch((call) => {
		if (call.url.hostname === "api.anthropic.com") {
			if (options.invalidKeys?.includes(apiKeyOf(call) ?? "")) {
				return Response.json(
					{
						type: "error",
						error: { type: "authentication_error", message: "invalid" },
					},
					{ status: 401 },
				);
			}
			return (
				options.anthropic?.(call) ??
				anthropicStreamOf([{ type: "text", text: "答えです" }], {
					inputTokens: 50_000,
				})
			);
		}
		if (call.url.pathname === "/api/v1/chat/completions") {
			return Response.json({
				choices: [{ message: { content: "答えです" }, finish_reason: "stop" }],
				usage: { prompt_tokens: 10, completion_tokens: 5 },
			});
		}
		if (call.url.hostname !== "discord.com") {
			return new Response(null, { status: 500 });
		}
		const path = call.url.pathname.replace("/api/v10", "");
		const member = path.match(/^\/guilds\/\d+\/members\/(\d+)$/);
		if (call.method === "GET" && member) {
			return options.left?.includes(member[1] ?? "")
				? Response.json({ code: 10007 }, { status: 404 })
				: Response.json({ user: { id: member[1] }, roles: [] });
		}
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
			return Response.json({ id: String(postedId++), channel_id: CHANNEL_ID });
		}
		if (call.method === "PATCH") {
			return Response.json({ id: "9999", channel_id: CHANNEL_ID });
		}
		return new Response(null, { status: 500 });
	});
}

/** Anthropicに答えを頼んだときの、キー(呼んだ順) */
function anthropicKeys(calls: FetchCall[]): (string | null)[] {
	return calls
		.filter((call) => call.url.pathname === "/v1/messages")
		.map(apiKeyOf);
}

/** AnthropicのAPIを呼んだキー。SDKは、キーをAuthorizationヘッダーで送る */
function apiKeyOf(call: FetchCall): string | null {
	return call.headers.get("authorization")?.replace(/^Bearer /, "") ?? null;
}

/** 投稿した返答の本文 */
function posted(calls: FetchCall[]): string[] {
	return calls
		.filter(
			(call) =>
				call.method === "POST" &&
				call.url.pathname === `/api/v10/channels/${CHANNEL_ID}/messages`,
		)
		.map((call) => (call.body as { content: string }).content);
}

/** サーバーのguildIdで、userがBobertにメンションして話しかける */
function mention(guildId: string, user: APIUser) {
	const trigger = discordMessage(newId(), user, `<@${BOT.id}> こんにちは`, {
		mentions: [BOT],
	});
	const job: RespondJob = {
		kind: "respond",
		messageId: trigger.id,
		channelId: CHANNEL_ID,
		guildId,
		authorId: user.id,
	};
	return { trigger, job };
}

/** サーバーのguildIdで、userが起こしたInteraction */
function interactionIn(
	guildId: string,
	type: number,
	data: unknown,
	user: APIUser,
) {
	return { ...guildInteraction(type, data, user), guild_id: guildId };
}

describe("/donate", () => {
	it("サーバーの全員が使えるクレジットの寄付として、/donate を登録する", () => {
		expect(COMMANDS).toContainEqual(
			expect.objectContaining({
				name: "donate",
				description: "サーバーの全員が使えるクレジットの寄付と、残りの確認",
			}),
		);
	});

	it("寄付がなければ「なし」と、寄付のボタンを、本人にだけ見せる", async () => {
		const guildId = newId();
		const body = await sendInteraction(
			interactionIn(
				guildId,
				InteractionType.ApplicationCommand,
				{ id: "20", name: "donate", type: 1 },
				withoutKey("carol"),
			),
		);

		expect(body.type).toBe(InteractionResponseType.ChannelMessageWithSource);
		expect(body.data.flags).toBe(MessageFlags.Ephemeral);
		expect(body.data.content).toBe(
			["**このサーバーに寄付されたクレジット**: なし", "", ...EXPLANATION].join(
				"\n",
			),
		);
		expect(body.data.components).toEqual([
			{
				type: ComponentType.ActionRow,
				components: [
					{
						type: ComponentType.Button,
						style: 1,
						custom_id: "donate:give",
						label: "寄付する",
					},
				],
			},
		]);
	});

	it("寄付を使う順に並べ、残りの合計と、自分の寄付と、止まっている寄付を書く。寄付している人には、やめるボタンも見せる", async () => {
		const guildId = newId();
		const alice = await withAnthropicKey("alice");
		const bob = await withAnthropicKey("bob");
		await donate(guildId, bob, 8, 2000);
		await donate(guildId, alice, 4.34, 1000);
		await pauseDonation(env.DB, guildId, bob.id, Date.now() + 3600_000);

		const body = await sendInteraction(
			interactionIn(
				guildId,
				InteractionType.ApplicationCommand,
				{ id: "20", name: "donate", type: 1 },
				bob,
			),
		);

		expect(body.data.content).toBe(
			[
				"**このサーバーに寄付されたクレジット**: 残り 約$12.34",
				"- alice: 約$4.34",
				"- bob(あなた): 約$8.00(キーが無効か残高が足りないため、いまは使えません)",
				"",
				...EXPLANATION,
			].join("\n"),
		);
		expect(
			body.data.components[0].components.map(
				(button: { label: string }) => button.label,
			),
		).toEqual(["寄付する", "寄付をやめる"]);
	});

	it("「寄付する」で、金額を入力するモーダルを開く。キーがなければ、登録方法を見せる", async () => {
		const guildId = newId();
		const press = (user: APIUser) =>
			sendInteraction(
				interactionIn(
					guildId,
					InteractionType.MessageComponent,
					{ custom_id: "donate:give", component_type: ComponentType.Button },
					user,
				),
			);

		const modal = await press(await withAnthropicKey("alice"));
		expect(modal).toEqual({
			type: InteractionResponseType.Modal,
			data: {
				custom_id: "donate:amount",
				title: "クレジットを寄付する",
				components: [
					{
						type: ComponentType.Label,
						label: "金額(ドル)",
						component: {
							type: ComponentType.TextInput,
							custom_id: "amount",
							style: 1,
							placeholder: "1〜100。例: 5",
							required: true,
							max_length: 10,
						},
					},
				],
			},
		});

		const noKey = await press(withoutKey("carol"));
		expect(noKey).toEqual({
			type: InteractionResponseType.ChannelMessageWithSource,
			data: {
				flags: MessageFlags.Ephemeral,
				content:
					"寄付するには、AIのキーの登録が必要です。`/setup` から登録してください。",
			},
		});
	});

	describe("金額の入力", () => {
		const submit = (guildId: string, user: APIUser, amount: string) =>
			sendInteraction(
				interactionIn(
					guildId,
					InteractionType.ModalSubmit,
					{
						custom_id: "donate:amount",
						components: [
							{
								type: ComponentType.Label,
								component: {
									type: ComponentType.TextInput,
									custom_id: "amount",
									value: amount,
								},
							},
						],
					},
					user,
				),
			);

		it("寄付を足して、画面を結果に書き換える。何度でも足せる", async () => {
			const guildId = newId();
			const alice = await withAnthropicKey("alice");

			const first = await submit(guildId, alice, "5");
			expect(first).toEqual({
				type: InteractionResponseType.UpdateMessage,
				data: {
					content: "$5を寄付しました。このサーバーの残りは、約$5.00です。",
					components: [],
				},
			});
			// 全角の数字も受け付ける
			const second = await submit(guildId, alice, "２.５");
			expect(second.data.content).toBe(
				"$2.50を寄付しました。このサーバーの残りは、約$7.50です。",
			);
			expect((await donationRow(guildId, alice.id))?.remaining_micros).toBe(
				7_500_000,
			);
		});

		it("金額が正しくなければ、画面はそのままにして、理由を本人にだけ見せる", async () => {
			const guildId = newId();
			const alice = await withAnthropicKey("alice");

			for (const amount of ["0.5", "101", "1.234", "abc", "-5"]) {
				const body = await submit(guildId, alice, amount);
				expect(body).toEqual({
					type: InteractionResponseType.ChannelMessageWithSource,
					data: {
						flags: MessageFlags.Ephemeral,
						content:
							"金額は、1から100までの数で入力してください(小数点以下2桁まで)。",
					},
				});
			}
			expect(await donationRow(guildId, alice.id)).toBeNull();
		});
	});

	it("「寄付をやめる」で、寄付をやめ、画面を結果に書き換える。もうやめていれば、今の状態を見せ直す", async () => {
		const guildId = newId();
		const alice = await withAnthropicKey("alice");
		await donate(guildId, alice, 8);
		const press = () =>
			sendInteraction(
				interactionIn(
					guildId,
					InteractionType.MessageComponent,
					{ custom_id: "donate:stop", component_type: ComponentType.Button },
					alice,
				),
			);

		expect(await press()).toEqual({
			type: InteractionResponseType.UpdateMessage,
			data: {
				content: "寄付をやめました。残りの約$8.00は使われません。",
				components: [],
			},
		});
		expect((await donationRow(guildId, alice.id))?.ended_at).not.toBeNull();

		const again = await press();
		expect(again.type).toBe(InteractionResponseType.UpdateMessage);
		expect(again.data.content).toMatch(
			/^\*\*このサーバーに寄付されたクレジット\*\*: なし/,
		);
	});

	it("金額は、1〜100ドルで、小数点以下2桁までの数だけを受け付ける", () => {
		expect(parseDonationAmount("5")).toBe(5_000_000);
		expect(parseDonationAmount("$2.5")).toBe(2_500_000);
		expect(parseDonationAmount("１００")).toBe(100_000_000);
		expect(parseDonationAmount("1.01")).toBe(1_010_000);
		expect(parseDonationAmount("0.99")).toBeNull();
		expect(parseDonationAmount("100.01")).toBeNull();
		expect(parseDonationAmount("1e2")).toBeNull();
		expect(parseDonationAmount("")).toBeNull();
	});
});

describe("寄付の残り", () => {
	it("寄付していれば足し、やめた後に寄付し直したら、その額から数え直す。止まっていた寄付は再開する", async () => {
		const guildId = newId();
		const alice = await withAnthropicKey("alice");
		await donate(guildId, alice, 1, 1000);
		// 使い切る直前の返答で、少し超えた
		await chargeDonation(env.DB, guildId, alice.id, 1_000_100);
		await pauseDonation(env.DB, guildId, alice.id, Date.now() + 3600_000);

		// 超えた分は、足す額から引かない
		await donate(guildId, alice, 2, 2000);
		expect(await donationRow(guildId, alice.id)).toEqual({
			remaining_micros: 2_000_000,
			donated_at: 1000,
			ended_at: null,
			paused_until: null,
		});

		await endDonation(env.DB, guildId, alice.id);
		await donate(guildId, alice, 3, 3000);
		expect(await donationRow(guildId, alice.id)).toEqual({
			remaining_micros: 3_000_000,
			donated_at: 3000,
			ended_at: null,
			paused_until: null,
		});
	});
});

describe("寄付で答える", () => {
	it("キーのない人にも、寄付した人のキーで答え、費用を寄付から差し引いて、返答の末尾に書く", async () => {
		const guildId = newId();
		const donor = await withAnthropicKey("donor");
		await donate(guildId, donor, 5);
		const carol = withoutKey("carol");
		await updateUserSettings(env.DB, carol.id, { featUsageDisplay: true });
		const { trigger, job } = mention(guildId, carol);
		const calls = mockApis([trigger]);

		await handleRespondJob(job, fakeQueues().environment);

		expect(anthropicKeys(calls)).toEqual([anthropicKey(donor)]);
		// 寄付した人が、サーバーにいるか確かめた
		expect(
			calls.some(
				(call) =>
					call.url.pathname ===
					`/api/v10/guilds/${guildId}/members/${donor.id}`,
			),
		).toBe(true);
		// 費用は、Claude Haiku 5.5の単価(100万トークンあたり入力$0.10、出力$0.50)で、入力5万・出力5トークン
		expect((await donationRow(guildId, donor.id))?.remaining_micros).toBe(
			5_000_000 - 5_003,
		);
		expect(posted(calls)).toEqual([
			[
				"答えです",
				"-# 入力 50,000トークン・出力 5トークン",
				"-# 寄付されたクレジットで答えました(残り 約$4.99)",
			].join("\n"),
		]);
	});

	it("キーを登録している人にも、寄付を先に使う", async () => {
		const guildId = newId();
		const donor = await withAnthropicKey("donor");
		await donate(guildId, donor, 5);
		const alice = await withAnthropicKey("alice");
		const { trigger, job } = mention(guildId, alice);
		const calls = mockApis([trigger]);

		await handleRespondJob(job, fakeQueues().environment);

		expect(anthropicKeys(calls)).toEqual([anthropicKey(donor)]);
		expect(posted(calls)).toEqual([
			"答えです\n-# 寄付されたクレジットで答えました(残り 約$4.99)",
		]);
	});

	it("寄付が複数あれば、古い順に使う。寄付した本人の返答には、本人の寄付を使わない", async () => {
		const guildId = newId();
		const first = await withAnthropicKey("first");
		const second = await withAnthropicKey("second");
		await donate(guildId, first, 5, 1000);
		await donate(guildId, second, 5, 2000);

		const { trigger, job } = mention(guildId, first);
		const calls = mockApis([trigger]);
		await handleRespondJob(job, fakeQueues().environment);

		expect(anthropicKeys(calls)).toEqual([anthropicKey(second)]);
		expect((await donationRow(guildId, first.id))?.remaining_micros).toBe(
			5_000_000,
		);
	});

	it("寄付した人のキーで呼べないモデルなら、本人のキーで答える", async () => {
		const guildId = newId();
		const donor = await withAnthropicKey("donor");
		await donate(guildId, donor, 5);
		const dave = withoutKey("dave");
		await saveCredential(env, dave.id, "openrouter", {
			apiKey: "or-dave",
			workspaceId: null,
		});
		await updateUserSettings(env.DB, dave.id, { modelKey: "gpt-6-luna" });
		const { trigger, job } = mention(guildId, dave);
		const calls = mockApis([trigger]);

		await handleRespondJob(job, fakeQueues().environment);

		const chat = calls.find(
			(call) => call.url.pathname === "/api/v1/chat/completions",
		);
		expect(chat?.headers.get("authorization")).toBe("Bearer or-dave");
		expect(anthropicKeys(calls)).toEqual([]);
		expect(posted(calls)).toEqual(["答えです"]);
		expect((await donationRow(guildId, donor.id))?.remaining_micros).toBe(
			5_000_000,
		);
	});

	it("「その他」で入力したモデルには、寄付を使わない", async () => {
		const guildId = newId();
		const donor = await withAnthropicKey("donor");
		await donate(guildId, donor, 5);
		const alice = await withAnthropicKey("alice");
		await updateUserSettings(env.DB, alice.id, {
			modelKey: "custom",
			customModelId: "claude-custom-1",
		});
		const { trigger, job } = mention(guildId, alice);
		const calls = mockApis([trigger]);

		await handleRespondJob(job, fakeQueues().environment);

		expect(anthropicKeys(calls)).toEqual([anthropicKey(alice)]);
		expect(posted(calls)).toEqual(["答えです"]);
	});

	it("寄付した人がサーバーを抜けていたら、その寄付を終えて、本人のキーで答える", async () => {
		const guildId = newId();
		const donor = await withAnthropicKey("donor");
		await donate(guildId, donor, 5);
		const alice = await withAnthropicKey("alice");
		const { trigger, job } = mention(guildId, alice);
		const calls = mockApis([trigger], { left: [donor.id] });

		await handleRespondJob(job, fakeQueues().environment);

		expect(anthropicKeys(calls)).toEqual([anthropicKey(alice)]);
		expect(posted(calls)).toEqual(["答えです"]);
		expect((await donationRow(guildId, donor.id))?.ended_at).not.toBeNull();
	});

	it("寄付した人のキーが無効なら、その寄付を止めて、次の寄付で答え直す", async () => {
		const guildId = newId();
		const broken = await withAnthropicKey("broken");
		const donor = await withAnthropicKey("donor");
		await donate(guildId, broken, 5, 1000);
		await donate(guildId, donor, 5, 2000);
		const carol = withoutKey("carol");
		const { trigger, job } = mention(guildId, carol);
		const calls = mockApis([trigger], { invalidKeys: [anthropicKey(broken)] });

		await handleRespondJob(job, fakeQueues().environment);

		expect(anthropicKeys(calls)).toEqual([
			anthropicKey(broken),
			anthropicKey(donor),
		]);
		// 残りには、止まっている寄付も数える
		expect(posted(calls)).toEqual([
			"答えです\n-# 寄付されたクレジットで答えました(残り 約$9.99)",
		]);
		expect(
			(await donationRow(guildId, broken.id))?.paused_until,
		).toBeGreaterThan(Date.now());
		expect((await donationRow(guildId, broken.id))?.remaining_micros).toBe(
			5_000_000,
		);
	});

	it("キーがなく、使える寄付もなければ、寄付されたことがあるサーバーでは、そのことを案内の先頭に書く", async () => {
		const guildId = newId();
		const donor = await withAnthropicKey("donor");
		await donate(guildId, donor, 1);
		// 使い切った
		await chargeDonation(env.DB, guildId, donor.id, 1_000_000);
		const carol = withoutKey("carol");
		const { trigger, job } = mention(guildId, carol);
		const calls = mockApis([trigger]);

		await handleRespondJob(job, fakeQueues().environment);

		expect(anthropicKeys(calls)).toEqual([]);
		expect(posted(calls)).toEqual([
			`このサーバーに寄付されたクレジットは、いまは使えません。${SETUP_GUIDANCE}`,
		]);
	});

	it("寄付されたことがないサーバーでは、今までどおりの案内を返す", async () => {
		const { trigger, job } = mention(newId(), withoutKey("carol"));
		const calls = mockApis([trigger]);

		await handleRespondJob(job, fakeQueues().environment);

		expect(posted(calls)).toEqual([SETUP_GUIDANCE]);
	});

	it("「Bobertに聞く」は、キーがなくても、寄付があれば受け付ける", async () => {
		const guildId = newId();
		const donor = await withAnthropicKey("donor");
		await donate(guildId, donor, 5);
		const { environment, sent } = fakeQueues();
		const target = discordMessage(newId(), ALICE, "おはよう");

		const body = await sendInteraction(
			interactionIn(
				guildId,
				InteractionType.ApplicationCommand,
				{
					id: "18",
					name: "Bobertに聞く",
					type: 3,
					target_id: target.id,
					resolved: { messages: { [target.id]: target } },
				},
				withoutKey("carol"),
			),
			environment,
		);

		expect(body).toEqual({ type: 5 });
		expect(sent).toEqual([expect.objectContaining({ kind: "explain" })]);
	});

	it("今すぐ要約も、寄付で要約したら、結果の末尾に書く", async () => {
		const guildId = newId();
		const donor = await withAnthropicKey("donor");
		await donate(guildId, donor, 5);
		const carol = withoutKey("carol");
		// 人とBobertが交互に返信し合う、25件の会話
		const messages: APIMessage[] = [];
		for (let i = 0; i < 25; i++) {
			const parent = messages.at(-1);
			const author = i % 2 === 0 ? carol : BOT;
			messages.push(
				parent
					? discordReply(newId(), author, `発言${i}`, parent)
					: discordMessage(newId(), author, `発言${i}`),
			);
		}
		await saveMessages(
			env.DB,
			messages.map((message) => fromDiscord(message, guildId)),
		);
		const calls = mockApis([], {
			anthropic: (call) =>
				(call.body as { system?: { text: string }[] }).system?.[0]?.text ===
				SUMMARY_SYSTEM_PROMPT
					? anthropicStreamOf([{ type: "text", text: "要約です" }])
					: new Response(null, { status: 500 }),
		});
		const job: CompactJob = {
			kind: "compact",
			interactionToken: "interaction-token",
			userId: carol.id,
			channelId: CHANNEL_ID,
			guildId,
			start: fromDiscord(messages.at(-1) as APIMessage, guildId),
			buttonMessageId: null,
		};

		await handleCompactJob(job, env);

		expect(anthropicKeys(calls)).toEqual([anthropicKey(donor)]);
		const edit = calls.find((call) => call.method === "PATCH");
		expect(edit?.body).toEqual({
			content: [
				"要約しました。次の返答から、要約と新しい20件の発言をAIに渡します。",
				"-# 寄付されたクレジットで答えました(残り 約$5.00)",
			].join("\n"),
		});
		// 入力10・出力5トークンの分を差し引いた
		expect((await donationRow(guildId, donor.id))?.remaining_micros).toBe(
			5_000_000 - 4,
		);
	});
});

describe("/delete と寄付", () => {
	const deleteCommand = (user: APIUser) =>
		sendInteraction(
			guildInteraction(
				InteractionType.ApplicationCommand,
				{ id: "17", name: "delete", type: 1 },
				user,
			),
		);

	it("寄付している人には、寄付も使われなくなることを書き、削除したら寄付も消す", async () => {
		const guildId = newId();
		const alice = await withAnthropicKey("alice");
		await donate(guildId, alice, 5);

		const body = await deleteCommand(alice);
		expect(body.data.content).toBe(
			"登録したAPIキー(AnthropicとOpenRouter)と設定を、すべて削除します。寄付したクレジットも、使われなくなります。よろしいですか?",
		);

		await sendInteraction(
			guildInteraction(
				InteractionType.MessageComponent,
				{ custom_id: "delete:confirm", component_type: ComponentType.Button },
				alice,
			),
		);
		expect(await donationRow(guildId, alice.id)).toBeNull();
	});

	it("寄付していない人には、今までどおりに確かめる", async () => {
		const body = await deleteCommand(await withAnthropicKey("bob"));
		expect(body.data.content).toBe(
			"登録したAPIキー(AnthropicとOpenRouter)と設定を、すべて削除します。よろしいですか?",
		);
	});
});
