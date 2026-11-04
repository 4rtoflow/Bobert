import { env } from "cloudflare:workers";
import type { APIMessage, APIUser } from "discord-api-types/v10";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ComponentType,
	InteractionResponseType,
	InteractionType,
	MessageFlags,
} from "../src/discord/constants";
import { clearModelInfoCache } from "../src/llm/model-info";
import {
	applyOperations,
	memoryPromptBlock,
	parseOperations,
	synthesisPrompt,
} from "../src/memory/prompts";
import { memoryScreen } from "../src/memory/screen";
import {
	DELETE_MEMORY_NOTE,
	MEMORY_BUILDING,
	MEMORY_CLEAR_CONFIRM,
	MEMORY_CLEARED,
	MEMORY_COST_NOTE,
	MEMORY_DONATION_NOTE,
	MEMORY_EMPTY,
	MEMORY_KEPT_NOTE,
	MEMORY_KEY_REQUIRED,
	MEMORY_OFF_EXPLANATION,
	MEMORY_UPDATED_NOTE,
} from "../src/memory/texts";
import { handleMemoryJob, scheduleMemoryUpdate } from "../src/memory/update";
import { deleteMessages } from "../src/queue/ingest";
import type {
	MemoryJob,
	QueueMessage,
	RespondJob,
	StoredMessageInput,
} from "../src/queue/messages";
import { handleRespondJob } from "../src/respond/handler";
import { COMMON_SYSTEM_PROMPT } from "../src/respond/prompt";
import { formatJst } from "../src/respond/time";
import {
	claimMemoryUpdate,
	hasAnyMemory,
	loadMemory,
	loadMemoryItems,
	MEMORY_RETRY_INTERVAL_MS,
	MEMORY_UPDATE_INTERVAL_MS,
	type MemoryItem,
	recordMemoryFailure,
	recordMemoryUpdated,
	saveMemoryItems,
	setMemoryEnabled,
} from "../src/store/memory";
import { saveMessages } from "../src/store/messages";
import { BOT, CHANNEL_ID, discordMessage } from "./fixtures";
import {
	anthropicStreamOf,
	type FetchCall,
	fakeIngestDeps,
	guildInteraction,
	mockFetch,
	recordChannels,
	sendInteraction,
	userFactory,
} from "./helpers";

afterEach(() => {
	vi.restoreAllMocks();
	clearModelInfoCache();
});

/** guildInteractionのサーバー */
const GUILD_ID = "900";

/** 資格情報を登録した、新しいユーザー(テストごとに別の人にする) */
const userWith = userFactory(64000);

/** 応答用と保存用のQueueの偽物。入れた仕事を記録する */
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

function memoryCommand(user: APIUser) {
	return guildInteraction(
		InteractionType.ApplicationCommand,
		{ id: "30", name: "memory", type: 1 },
		user,
	);
}

function pressButton(user: APIUser, customId: string) {
	return guildInteraction(
		InteractionType.MessageComponent,
		{ custom_id: customId, component_type: ComponentType.Button },
		user,
	);
}

function submitEdit(user: APIUser, value: string) {
	return guildInteraction(
		InteractionType.ModalSubmit,
		{
			custom_id: "memory:edit_modal",
			components: [
				{
					type: ComponentType.Label,
					id: 1,
					component: {
						type: ComponentType.TextInput,
						id: 2,
						custom_id: "items",
						value,
					},
				},
			],
		},
		user,
	);
}

/** ボタンの行(styleとlabelとcustom_id) */
function buttons(...entries: [style: number, label: string, id: string][]) {
	return [
		{
			type: ComponentType.ActionRow,
			components: entries.map(([style, label, custom_id]) => ({
				type: ComponentType.Button,
				style,
				label,
				custom_id,
			})),
		},
	];
}

const OFF_SCREEN = [
	"**記憶**: OFF",
	MEMORY_OFF_EXPLANATION,
	MEMORY_COST_NOTE,
	MEMORY_DONATION_NOTE,
];
const ON_BUTTONS = buttons(
	[1, "直す", "memory:edit"],
	[2, "全部消す", "memory:clear"],
	[2, "OFFにする", "memory:off"],
);

function item(
	text: string,
	sources: string[] = [],
	userWritten = false,
): MemoryItem {
	return { text, userWritten, sources };
}

/** 一覧を作り終えた、記憶を使っている人 */
async function enabledUser(items: MemoryItem[] = [], readUntil = 1) {
	const user = await userWith("anthropic");
	await setMemoryEnabled(env.DB, user.id, GUILD_ID, true);
	await saveMemoryItems(env.DB, user.id, GUILD_ID, items);
	await recordMemoryUpdated(env.DB, user.id, GUILD_ID, readUntil, 1);
	return user;
}

describe("/memory の画面", () => {
	it("OFFのときは、何をする機能かと費用を、本人にだけ見せ、「ONにする」ボタンを付ける", async () => {
		const user = await userWith("anthropic");

		const body = await sendInteraction(memoryCommand(user));

		expect(body).toEqual({
			type: InteractionResponseType.ChannelMessageWithSource,
			data: {
				flags: MessageFlags.Ephemeral,
				content: OFF_SCREEN.join("\n"),
				components: buttons([3, "ONにする", "memory:on"]),
			},
		});
		expect(MEMORY_OFF_EXPLANATION).toBe(
			"ONにすると、このサーバーでのあなたの発言から、AIが「あなたについて覚えておくこと」をまとめて、あなたへの返答に使います。会話で「覚えて」「忘れて」と頼むこともできます。",
		);
	});

	it("ONのときは、覚えていることの一覧と、最後の更新を書く", async () => {
		const user = await enabledUser([
			item("Rustでゲームを作っている"),
			item("返答は短いほうが好き", [], true),
		]);

		const body = await sendInteraction(memoryCommand(user));

		expect(body.data.content).toBe(
			[
				"**記憶**: ON",
				"1. Rustでゲームを作っている",
				"2. 返答は短いほうが好き",
				`-# 最後の更新: ${formatJst(1)}`,
			].join("\n"),
		);
		expect(body.data.allowed_mentions).toEqual({ parse: [] });
		expect(body.data.components).toEqual(ON_BUTTONS);
	});

	it("一覧が空なら、まだないと書く。前回の更新に失敗していれば、その理由も書く", async () => {
		const user = await enabledUser();
		await recordMemoryFailure(env.DB, user.id, GUILD_ID, "理由です。");

		const body = await sendInteraction(memoryCommand(user));

		expect(body.data.content).toBe(
			[
				"**記憶**: ON",
				MEMORY_EMPTY,
				`-# 最後の更新: ${formatJst(1)}`,
				"-# 前回の更新に失敗しました。理由です。",
			].join("\n"),
		);
	});

	it("短い項目がとても多くても、1通(2000文字)に収める", () => {
		const screen = memoryScreen({
			enabled: true,
			readUntil: 1,
			updatedAt: 1,
			failure: null,
			items: Array.from({ length: 700 }, () => item("あ")),
		});

		expect(screen.content.length).toBeLessThanOrEqual(2000);
		const lines = screen.content.split("\n");
		expect(lines.slice(-2)).toEqual(["…", `-# 最後の更新: ${formatJst(1)}`]);
	});

	it("キーがない人が「ONにする」を押したら、登録を案内し、ONにしない", async () => {
		const user = await userWith();

		const body = await sendInteraction(pressButton(user, "memory:on"));

		expect(body).toEqual({
			type: InteractionResponseType.ChannelMessageWithSource,
			data: { flags: MessageFlags.Ephemeral, content: MEMORY_KEY_REQUIRED },
		});
		expect(await loadMemory(env.DB, user.id, GUILD_ID)).toBeNull();
	});

	it("「ONにする」を初めて押したら、最初の一覧を作る仕事を入れ、画面を「まとめています」にする", async () => {
		const { environment, sent } = fakeQueues();
		const user = await userWith("openrouter");

		const body = await sendInteraction(
			pressButton(user, "memory:on"),
			environment,
		);

		expect(body).toEqual({
			type: InteractionResponseType.UpdateMessage,
			data: { content: MEMORY_BUILDING, components: [] },
		});
		expect(sent).toEqual([
			{
				kind: "memory",
				userId: user.id,
				guildId: GUILD_ID,
				interactionToken: "interaction-token",
			} satisfies MemoryJob,
		]);
		expect(await loadMemory(env.DB, user.id, GUILD_ID)).toMatchObject({
			enabled: true,
			readUntil: null,
		});
	});

	it("「OFFにする」で使わなくする。一覧は残し、ONに戻すと、まとめ直さずにすぐ見せる", async () => {
		const { environment, sent } = fakeQueues();
		const user = await enabledUser([item("Rustでゲームを作っている")]);

		const off = await sendInteraction(
			pressButton(user, "memory:off"),
			environment,
		);

		expect(off).toEqual({
			type: InteractionResponseType.UpdateMessage,
			data: {
				content: [...OFF_SCREEN, MEMORY_KEPT_NOTE].join("\n"),
				components: buttons([3, "ONにする", "memory:on"]),
			},
		});
		expect(await loadMemoryItems(env.DB, user.id, GUILD_ID)).toHaveLength(1);

		const on = await sendInteraction(
			pressButton(user, "memory:on"),
			environment,
		);

		expect(on.type).toBe(InteractionResponseType.UpdateMessage);
		expect(on.data.content.split("\n").slice(0, 2)).toEqual([
			"**記憶**: ON",
			"1. Rustでゲームを作っている",
		]);
		expect(sent).toEqual([]);
	});

	it("「直す」で、今の一覧を1行に1つ入れた入力画面を開く", async () => {
		const user = await enabledUser([
			item("Rustでゲームを作っている"),
			item("返答は短いほうが好き"),
		]);

		const body = await sendInteraction(pressButton(user, "memory:edit"));

		expect(body).toEqual({
			type: InteractionResponseType.Modal,
			data: {
				custom_id: "memory:edit_modal",
				title: "記憶を直す",
				components: [
					{
						type: ComponentType.Label,
						label: "覚えておくこと",
						description: "1行に1つ。1つ100文字まで、全体で1500文字まで",
						component: {
							type: ComponentType.TextInput,
							custom_id: "items",
							style: 2,
							required: false,
							max_length: 4000,
							value: "Rustでゲームを作っている\n返答は短いほうが好き",
						},
					},
				],
			},
		});
	});

	it("入力画面を送ると、1行を1つの項目にして保存する。変えなかった行は、もとの発言の記録を残し、変えた行と足した行は、本人が書いた項目にする", async () => {
		const user = await enabledUser([
			item("Rustでゲームを作っている", ["5001"]),
			item("返答は短いほうが好き", ["5002"]),
		]);

		const body = await sendInteraction(
			submitEdit(
				user,
				"Rustでゲームを作っている\n\n  返答は長くてもよい  \n猫を2匹飼っている\n猫を2匹飼っている",
			),
		);

		expect(await loadMemoryItems(env.DB, user.id, GUILD_ID)).toEqual([
			item("Rustでゲームを作っている", ["5001"]),
			item("返答は長くてもよい", [], true),
			item("猫を2匹飼っている", [], true),
		]);
		expect(body.type).toBe(InteractionResponseType.UpdateMessage);
		expect(body.data.content.split("\n").slice(0, 4)).toEqual([
			"**記憶**: ON",
			"1. Rustでゲームを作っている",
			"2. 返答は長くてもよい",
			"3. 猫を2匹飼っている",
		]);
	});

	it("長すぎる項目があれば、保存せず、書いた内容を付けて知らせる", async () => {
		const user = await enabledUser([item("Rustでゲームを作っている")]);
		const text = `短い項目\n${"あ".repeat(101)}`;

		const body = await sendInteraction(submitEdit(user, text));

		expect(body).toEqual({
			type: InteractionResponseType.ChannelMessageWithSource,
			data: {
				flags: MessageFlags.Ephemeral,
				content: `1つの項目は100文字までにしてください(2行目が101文字です)。書いた内容を下に付けます。\n\`\`\`\n${text}\n\`\`\``,
			},
		});
		expect(await loadMemoryItems(env.DB, user.id, GUILD_ID)).toEqual([
			item("Rustでゲームを作っている"),
		]);
	});

	it("全体が長すぎれば、保存せず、書いた内容を付けて知らせる", async () => {
		const user = await enabledUser();
		const text = Array.from({ length: 16 }, () => "い".repeat(100)).join("\n");

		const body = await sendInteraction(submitEdit(user, text));

		expect(body.data.content).toMatch(
			/^全体で1500文字までにしてください\(いまは1,600文字です\)。書いた内容を下に付けます。\n```\n/,
		);
		expect(await loadMemoryItems(env.DB, user.id, GUILD_ID)).toEqual([]);
	});

	it("「全部消す」で確かめ、「消す」で一覧を消す。ONのままにする", async () => {
		const user = await enabledUser([item("Rustでゲームを作っている")]);

		const confirm = await sendInteraction(pressButton(user, "memory:clear"));

		expect(confirm).toEqual({
			type: InteractionResponseType.ChannelMessageWithSource,
			data: {
				flags: MessageFlags.Ephemeral,
				content: MEMORY_CLEAR_CONFIRM,
				components: buttons([4, "消す", "memory:clear_confirm"]),
			},
		});

		const cleared = await sendInteraction(
			pressButton(user, "memory:clear_confirm"),
		);

		expect(cleared).toEqual({
			type: InteractionResponseType.UpdateMessage,
			data: { content: MEMORY_CLEARED, components: [] },
		});
		expect(await loadMemory(env.DB, user.id, GUILD_ID)).toMatchObject({
			enabled: true,
			items: [],
		});
	});
});

describe("記憶をまとめる仕事", () => {
	let nextMessageId = 64500;

	/** 保存した発言。時刻はcreatedAt(ミリ秒) */
	function stored(
		authorId: string,
		content: string,
		createdAt: number,
		replyToId: string | null = null,
	): StoredMessageInput {
		return {
			messageId: String(nextMessageId++),
			guildId: GUILD_ID,
			channelId: CHANNEL_ID,
			authorId,
			authorName: authorId === BOT.id ? "Bobert" : "Alice",
			authorIsBot: authorId === BOT.id,
			content,
			replyToId,
			mentions: [],
			attachments: [],
			embeds: [],
			command: null,
			members: [],
			createdAt,
			editedAt: null,
		};
	}

	/** AIの答え(一覧の変更) */
	function answerWith(operations: unknown) {
		return anthropicStreamOf([
			{ type: "text", text: `変更です。\n${JSON.stringify(operations)}` },
		]);
	}

	/** AIへのリクエスト(Anthropic)の、指示と依頼の本文 */
	function synthesisRequests(calls: FetchCall[]) {
		return calls
			.filter((call) => call.url.hostname === "api.anthropic.com")
			.map((call) => {
				const body = call.body as {
					model: string;
					system: { text: string }[];
					messages: { content: { text: string }[] }[];
				};
				return {
					model: body.model,
					system: body.system.map((block) => block.text),
					input: body.messages[0]?.content[0]?.text,
				};
			});
	}

	function job(userId: string, interactionToken: string | null = null) {
		return {
			kind: "memory",
			userId,
			guildId: GUILD_ID,
			interactionToken,
		} satisfies MemoryJob;
	}

	it("最初は、新しい方から本人の発言とBobertの答えを読み、AIの変更を当てて保存する。ONにした画面を、一覧に書き換える", async () => {
		const user = await userWith("anthropic");
		await setMemoryEnabled(env.DB, user.id, GUILD_ID, true);
		const first = stored(user.id, "Rustでゲームを作ってる", 1_000);
		const answer = stored(BOT.id, "いいね!", 1_500, first.messageId);
		const second = stored(user.id, "返答は\n短くして", 2_000);
		const other = stored("99999", "ほかの人の発言", 2_500);
		const empty = stored(user.id, "", 2_600);
		await saveMessages(env.DB, [first, answer, second, other, empty]);
		const calls = mockFetch((call) =>
			call.url.hostname === "api.anthropic.com"
				? answerWith({
						add: [
							{ text: "Rustでゲームを作っている", sources: [1] },
							{ text: "返答は短いほうが好き", sources: [2, 9] },
						],
						update: [],
						delete: [],
					})
				: Response.json({}),
		);

		await handleMemoryJob(job(user.id, "interaction-token"), env);

		expect(synthesisRequests(calls)).toEqual([
			{
				model: "claude-haiku-5-5",
				system: [synthesisPrompt("Alice")],
				input: [
					"今の一覧:",
					"(まだありません)",
					"",
					"Aliceの新しい発言:",
					`(m1) [${formatJst(1_000)}] Rustでゲームを作ってる`,
					"(Bobertの答え) いいね!",
					`(m2) [${formatJst(2_000)}] 返答は 短くして`,
				].join("\n"),
			},
		]);
		expect(await loadMemoryItems(env.DB, user.id, GUILD_ID)).toEqual([
			item("Rustでゲームを作っている", [first.messageId]),
			// 番号の分からない発言(9)は、もとの発言にしない
			item("返答は短いほうが好き", [second.messageId]),
		]);
		const state = await loadMemory(env.DB, user.id, GUILD_ID);
		// 本文のない発言も、読んだことにする
		expect(state).toMatchObject({ readUntil: 2_600, failure: null });
		const edit = calls.find((call) => call.method === "PATCH");
		expect(edit?.url.pathname).toBe(
			`/api/v10/webhooks/${env.DISCORD_APPLICATION_ID}/interaction-token/messages/@original`,
		);
		expect(edit?.body).toEqual(memoryScreen(state));
	});

	it("更新では、前回より後の発言だけを読む。本人が書いた項目は、AIが変えようとしても変えない", async () => {
		const user = await enabledUser(
			[item("自分で書いた", [], true), item("古い項目", ["64400"])],
			5_000,
		);
		const old = stored(user.id, "前に読んだ発言", 4_000);
		const fresh = stored(user.id, "新しい発言", 6_000);
		await saveMessages(env.DB, [old, fresh]);
		const calls = mockFetch(() =>
			answerWith({
				add: [{ text: "新しい項目", sources: [1] }],
				update: [{ item: 1, text: "書き換え", sources: [1] }],
				delete: [1, 2],
			}),
		);

		await handleMemoryJob(job(user.id), env);

		const [request] = synthesisRequests(calls);
		expect(request?.input).toBe(
			[
				"今の一覧:",
				"[1](あなたが書いた) 自分で書いた",
				"[2] 古い項目",
				"",
				"Aliceの新しい発言:",
				`(m1) [${formatJst(6_000)}] 新しい発言`,
			].join("\n"),
		);
		expect(await loadMemoryItems(env.DB, user.id, GUILD_ID)).toEqual([
			item("自分で書いた", [], true),
			item("新しい項目", [fresh.messageId]),
		]);
		expect(await loadMemory(env.DB, user.id, GUILD_ID)).toMatchObject({
			readUntil: 6_000,
		});
		// ONにした画面からの仕事でなければ、画面は書き換えない
		expect(calls.some((call) => call.method === "PATCH")).toBe(false);
	});

	it("新しい発言がなければ、AIを呼ばずに、更新したことにする", async () => {
		const user = await enabledUser([item("古い項目")], 5_000);
		const calls = mockFetch(() => new Response(null, { status: 500 }));

		await handleMemoryJob(job(user.id), env);

		expect(calls).toEqual([]);
		const state = await loadMemory(env.DB, user.id, GUILD_ID);
		expect(state?.readUntil).toBe(5_000);
		expect(state?.updatedAt).toBeGreaterThan(1);
	});

	it("AIの呼び出しに失敗したら、理由を記録し、読み込んだ時刻は進めない", async () => {
		const user = await userWith("anthropic");
		await setMemoryEnabled(env.DB, user.id, GUILD_ID, true);
		await saveMessages(env.DB, [stored(user.id, "発言", 1_000)]);
		const calls = mockFetch((call) =>
			call.url.hostname === "api.anthropic.com"
				? Response.json(
						{
							type: "error",
							error: { type: "authentication_error", message: "invalid" },
						},
						{ status: 401 },
					)
				: Response.json({}),
		);

		await handleMemoryJob(job(user.id, "interaction-token"), env);

		const state = await loadMemory(env.DB, user.id, GUILD_ID);
		expect(state).toMatchObject({
			readUntil: null,
			updatedAt: null,
			failure:
				"AnthropicのAPIキーが無効です。`/setup` から登録し直してください。",
			items: [],
		});
		// ONにした画面は、失敗の理由を書いた画面に書き換える
		const edit = calls.find((call) => call.method === "PATCH");
		expect(edit?.body).toEqual(memoryScreen(state));
	});

	it("キーがなくなっていたら、登録が必要なことを記録する", async () => {
		const user = await userWith();
		await setMemoryEnabled(env.DB, user.id, GUILD_ID, true);
		mockFetch(() => new Response(null, { status: 500 }));

		await handleMemoryJob(job(user.id), env);

		expect(await loadMemory(env.DB, user.id, GUILD_ID)).toMatchObject({
			failure: MEMORY_KEY_REQUIRED,
		});
	});

	it("OFFにしていたら、何もしない", async () => {
		const user = await enabledUser([], 5_000);
		await setMemoryEnabled(env.DB, user.id, GUILD_ID, false);
		await saveMessages(env.DB, [stored(user.id, "発言", 6_000)]);
		const calls = mockFetch(() => new Response(null, { status: 500 }));

		await handleMemoryJob(job(user.id), env);

		expect(calls).toEqual([]);
		expect(await loadMemory(env.DB, user.id, GUILD_ID)).toMatchObject({
			readUntil: 5_000,
		});
	});

	it("まとめている間に、本人が一覧を直したら、まとめた結果を捨て、読み込んだ時刻も進めない", async () => {
		const user = await enabledUser([item("古い項目")], 5_000);
		await saveMessages(env.DB, [stored(user.id, "新しい発言", 6_000)]);
		mockFetch(async () => {
			await saveMemoryItems(env.DB, user.id, GUILD_ID, [
				item("本人が直した", [], true),
			]);
			return answerWith({
				add: [{ text: "AIが足した", sources: [1] }],
				update: [],
				delete: [],
			});
		});

		await handleMemoryJob(job(user.id), env);

		expect(await loadMemory(env.DB, user.id, GUILD_ID)).toMatchObject({
			readUntil: 5_000,
			items: [item("本人が直した", [], true)],
		});
	});

	it("まとめている間に消された発言から覚えた項目は、消す", async () => {
		const user = await enabledUser([], 5_000);
		const kept = stored(user.id, "残る発言", 6_000);
		const removed = stored(user.id, "消される発言", 7_000);
		await saveMessages(env.DB, [kept, removed]);
		const { deps } = fakeIngestDeps(BOT.id);
		mockFetch(async () => {
			await deleteMessages([removed.messageId], deps);
			return answerWith({
				add: [
					{ text: "残る項目", sources: [1] },
					{ text: "消える項目", sources: [2] },
				],
				update: [],
				delete: [],
			});
		});

		await handleMemoryJob(job(user.id), env);

		expect(await loadMemoryItems(env.DB, user.id, GUILD_ID)).toEqual([
			item("残る項目", [kept.messageId]),
		]);
	});
});

describe("記憶の更新の予約", () => {
	it("使っていれば、前回の更新から1日たつまでに1回だけ始める。失敗した後は、1時間たてば試し直す", async () => {
		const user = await userWith("anthropic");
		const now = 10 * MEMORY_UPDATE_INTERVAL_MS;
		const claim = (at: number) =>
			claimMemoryUpdate(env.DB, user.id, GUILD_ID, { now: at });

		// 使っていなければ始めない
		expect(await claim(now)).toBe(false);
		await setMemoryEnabled(env.DB, user.id, GUILD_ID, true);
		expect(await claim(now)).toBe(true);
		// 始めてから1時間は、重ねて始めない
		expect(await claim(now + MEMORY_RETRY_INTERVAL_MS - 1)).toBe(false);
		// 失敗して終わらなければ、1時間たった後に試し直す
		expect(await claim(now + MEMORY_RETRY_INTERVAL_MS)).toBe(true);
		await recordMemoryUpdated(
			env.DB,
			user.id,
			GUILD_ID,
			now,
			now + MEMORY_RETRY_INTERVAL_MS,
		);
		// 更新し終えたら、1日たつまで始めない
		const updatedAt = now + MEMORY_RETRY_INTERVAL_MS;
		expect(await claim(updatedAt + MEMORY_UPDATE_INTERVAL_MS - 1)).toBe(false);
		expect(await claim(updatedAt + MEMORY_UPDATE_INTERVAL_MS)).toBe(true);
		// ONにしたとき(force)は、いつでも始める
		expect(
			await claimMemoryUpdate(env.DB, user.id, GUILD_ID, {
				force: true,
				now: updatedAt + MEMORY_UPDATE_INTERVAL_MS + 1,
			}),
		).toBe(true);
	});

	it("返答の後に予約する。始められたときだけ、仕事を入れる。DMでは入れない", async () => {
		const { environment, sent } = fakeQueues();
		const user = await userWith("anthropic");
		await setMemoryEnabled(env.DB, user.id, GUILD_ID, true);

		await scheduleMemoryUpdate(environment, user.id, GUILD_ID);
		await scheduleMemoryUpdate(environment, user.id, GUILD_ID);
		await scheduleMemoryUpdate(environment, user.id, null);

		expect(sent).toEqual([
			{
				kind: "memory",
				userId: user.id,
				guildId: GUILD_ID,
				interactionToken: null,
			},
		]);
	});
});

describe("AIの答えを当てる", () => {
	it("答えの中のJSONを読む。形の違う項目は読まない。JSONがなければnull", () => {
		expect(
			parseOperations(
				'はい。{"add":[{"text":"足す","sources":[1,"x"]},{"sources":[2]}],"update":[{"item":2,"text":"直す"},{"text":"番号なし"}],"delete":[3,"4"]}',
			),
		).toEqual({
			add: [{ text: "足す", sources: [1] }],
			update: [{ item: 2, text: "直す", sources: [] }],
			delete: [3],
		});
		expect(parseOperations("変えることはありません")).toBeNull();
		expect(parseOperations("{壊れた}")).toBeNull();
	});

	it("空の項目、長すぎる項目、同じ文の項目は足さない。改行は空白にする", () => {
		const refs = new Map([[1, "m1"]]);

		expect(
			applyOperations(
				[item("ある項目")],
				{
					add: [
						{ text: "", sources: [1] },
						{ text: "あ".repeat(101), sources: [1] },
						{ text: "ある項目", sources: [1] },
						{ text: "2行\nの項目", sources: [1] },
					],
					update: [{ item: 1, text: "い".repeat(101), sources: [1] }],
					delete: [],
				},
				refs,
			),
		).toEqual([item("ある項目"), item("2行 の項目", ["m1"])]);
	});

	it("全体が1500文字を超えたら、本人が書いていない項目を後ろから外す", () => {
		const long = (char: string) => char.repeat(100);
		const items = [
			item(long("あ"), [], true),
			...Array.from({ length: 13 }, (_, index) =>
				item(long(String.fromCharCode(0x3044 + index))),
			),
		];

		const result = applyOperations(
			items,
			{
				add: [
					{ text: long("ア"), sources: [] },
					{ text: long("イ"), sources: [] },
				],
				update: [],
				delete: [],
			},
			new Map(),
		);

		expect(result).toHaveLength(15);
		expect(result[0]).toEqual(items[0]);
		expect(result.at(-1)?.text).toBe(long("ア"));
	});
});

describe("返答で記憶を使う", () => {
	let nextMessageId = 64800;
	function newMessageId(): string {
		return String(nextMessageId++);
	}

	function mention(user: APIUser, text: string): APIMessage {
		return discordMessage(newMessageId(), user, `<@${BOT.id}> ${text}`, {
			mentions: [BOT],
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

	/** DiscordとAIのAPIの偽物。Discordには、話しかけたメッセージがあることにする */
	function mockApis(
		trigger: APIMessage,
		ai: (call: FetchCall) => Response,
	): FetchCall[] {
		return mockFetch((call) => {
			if (call.url.hostname !== "discord.com") {
				return ai(call);
			}
			const path = call.url.pathname.replace("/api/v10", "");
			if (
				call.method === "GET" &&
				path === `/channels/${CHANNEL_ID}/messages/${trigger.id}`
			) {
				return Response.json(trigger);
			}
			if (call.method === "POST" && path.endsWith("/typing")) {
				return new Response(null, { status: 204 });
			}
			if (
				call.method === "POST" &&
				path === `/channels/${CHANNEL_ID}/messages`
			) {
				return Response.json({ id: newMessageId(), channel_id: CHANNEL_ID });
			}
			return new Response(null, { status: 500 });
		});
	}

	function posted(calls: FetchCall[]): string[] {
		return calls
			.filter(
				(call) =>
					call.method === "POST" &&
					call.url.pathname === `/api/v10/channels/${CHANNEL_ID}/messages`,
			)
			.map((call) => (call.body as { content: string }).content);
	}

	function anthropicRequests(calls: FetchCall[]) {
		return calls
			.filter((call) => call.url.hostname === "api.anthropic.com")
			.map(
				(call) =>
					call.body as {
						system: { text: string }[];
						tools: { name: string }[];
					},
			);
	}

	it("記憶を使っている人には、本人の指示の後ろに一覧を入れ、共有チャンネルでは記憶を直す道具を渡す。道具で直したら、返答の末尾に書く", async () => {
		await recordChannels(GUILD_ID, [{ channelId: CHANNEL_ID }]);
		const { environment, sent } = fakeQueues();
		const user = await enabledUser([item("Rustでゲームを作っている")]);
		const trigger = mention(user, "猫を2匹飼ってるって覚えておいて");
		let round = 0;
		const calls = mockApis(trigger, () =>
			round++ === 0
				? anthropicStreamOf(
						[
							{
								type: "tool_use",
								id: "toolu_1",
								name: "update_memory",
								input: { add: ["猫を2匹飼っている"] },
							},
						],
						{ stopReason: "tool_use" },
					)
				: anthropicStreamOf([{ type: "text", text: "覚えました!" }]),
		);

		await handleRespondJob(respondJob(trigger), environment);

		const [request] = anthropicRequests(calls);
		expect(request?.system.map((block) => block.text)).toEqual([
			COMMON_SYSTEM_PROMPT,
			memoryPromptBlock("Alice", [item("Rustでゲームを作っている")], true),
		]);
		expect(request?.tools.map((tool) => tool.name)).toContain("update_memory");
		expect(posted(calls)).toEqual([`覚えました!\n${MEMORY_UPDATED_NOTE}`]);
		expect(await loadMemoryItems(env.DB, user.id, GUILD_ID)).toEqual([
			item("Rustでゲームを作っている"),
			item("猫を2匹飼っている", [], true),
		]);
		// 返答の後に、記憶の更新を予約する(前回の更新から1日たっているので、仕事を入れる)
		expect(sent).toContainEqual({
			kind: "memory",
			userId: user.id,
			guildId: GUILD_ID,
			interactionToken: null,
		});
	});

	it("共有でないチャンネルでは、一覧だけを入れ、道具は渡さない", async () => {
		const { environment } = fakeQueues();
		await recordChannels(GUILD_ID, [{ channelId: CHANNEL_ID, nsfw: true }]);
		const user = await enabledUser([item("Rustでゲームを作っている")]);
		const trigger = mention(user, "こんにちは");
		const calls = mockApis(trigger, () =>
			anthropicStreamOf([{ type: "text", text: "こんにちは!" }]),
		);

		await handleRespondJob(respondJob(trigger), environment);

		const [request] = anthropicRequests(calls);
		expect(request?.system.map((block) => block.text)).toEqual([
			COMMON_SYSTEM_PROMPT,
			memoryPromptBlock("Alice", [item("Rustでゲームを作っている")], false),
		]);
		expect(request?.tools.map((tool) => tool.name)).not.toContain(
			"update_memory",
		);
		await recordChannels(GUILD_ID, [{ channelId: CHANNEL_ID }]);
	});

	it("OFFにしている人には、一覧を残していても入れない", async () => {
		const { environment, sent } = fakeQueues();
		const user = await enabledUser([item("Rustでゲームを作っている")]);
		await setMemoryEnabled(env.DB, user.id, GUILD_ID, false);
		const trigger = mention(user, "こんにちは");
		const calls = mockApis(trigger, () =>
			anthropicStreamOf([{ type: "text", text: "こんにちは!" }]),
		);

		await handleRespondJob(respondJob(trigger), environment);

		const [request] = anthropicRequests(calls);
		expect(request?.system.map((block) => block.text)).toEqual([
			COMMON_SYSTEM_PROMPT,
		]);
		expect(sent.filter((job) => job.kind === "memory")).toEqual([]);
	});
});

describe("発言が消されたとき", () => {
	it("消された発言だけから覚えた項目は消す。ほかの発言からも覚えた項目と、本人が書いた項目は残す", async () => {
		const user = await enabledUser([
			item("消える項目", ["64901"]),
			item("残る項目", ["64901", "64902"]),
			item("本人が書いた", [], true),
		]);
		const { deps } = fakeIngestDeps(BOT.id);

		await deleteMessages(["64901"], deps);

		expect(await loadMemoryItems(env.DB, user.id, GUILD_ID)).toEqual([
			item("残る項目", ["64902"]),
			item("本人が書いた", [], true),
		]);
	});
});

describe("/delete", () => {
	it("記憶を使ったことがある人には、記憶も消すと書き、すべてのサーバーの分を消す", async () => {
		const user = await enabledUser([item("Rustでゲームを作っている")]);
		await setMemoryEnabled(env.DB, user.id, "901", false);

		const confirm = await sendInteraction(
			guildInteraction(
				InteractionType.ApplicationCommand,
				{ id: "12", name: "delete", type: 1 },
				user,
			),
		);

		expect(confirm.data.content).toBe(
			`登録したAPIキー(AnthropicとOpenRouter)と設定を、すべて削除します。${DELETE_MEMORY_NOTE}よろしいですか?`,
		);

		await sendInteraction(pressButton(user, "delete:confirm"));

		expect(await hasAnyMemory(env.DB, user.id)).toBe(false);
		expect(await loadMemory(env.DB, user.id, "901")).toBeNull();
	});
});
