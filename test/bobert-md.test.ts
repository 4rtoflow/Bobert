import { env } from "cloudflare:workers";
import type { APIMessage, APIUser } from "discord-api-types/v10";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ComponentType,
	InteractionResponseType,
	InteractionType,
	MessageFlags,
	TextInputStyle,
} from "../src/discord/constants";
import { COMMANDS } from "../src/interactions/commands";
import { helpText } from "../src/interactions/help";
import { clearModelInfoCache } from "../src/llm/model-info";
import type { RespondJob } from "../src/queue/messages";
import { handleRespondJob } from "../src/respond/handler";
import {
	BOBERT_MD_INTRO,
	bobertMdBlock,
	COMMON_SYSTEM_PROMPT,
	SKILL_LIST_INTRO,
} from "../src/respond/prompt";
import { getBobertMd, saveBobertMd } from "../src/store/bobert-md";
import { addSkill } from "../src/store/skills";
import { saveCredential, updateUserSettings } from "../src/store/users";
import { ALICE, BOB, BOT, CHANNEL_ID, discordMessage } from "./fixtures";
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

const SAVED =
	"Bobert.mdを保存しました。次の返答から、このサーバーの全員への返答で使います。";
const CLEARED = "Bobert.mdを消しました。次の返答から使いません。";
const CONFLICT =
	"編集の画面を開いている間に、ほかの人がBobert.mdを変更したため、保存しませんでした。送った内容を添付します。`/bobertmd` から開き直して、もう一度試してください。";
const SAVE_FAILED =
	"Bobert.mdを保存できませんでした。少し待ってから、もう一度試してください。";

const SERVER_INFO =
	"## このサーバーについて\n- 大学のゲームサークルのサーバー\n- 活動は毎週水曜";

const BOB_EDITOR = { id: BOB.id, name: "bob" };

/** テストごとに、ほかのテストと重ならないサーバーを使う(Bobert.mdはサーバーごとなので) */
let nextGuildId = 8700;
function newGuild(): string {
	return String(nextGuildId++);
}

/** guildIdのサーバーで、userが起こしたInteraction */
function inGuild(
	guildId: string,
	type: number,
	data: unknown,
	user: APIUser = ALICE,
) {
	return { ...guildInteraction(type, data, user), guild_id: guildId };
}

function bobertmdCommand(guildId: string) {
	return inGuild(guildId, InteractionType.ApplicationCommand, {
		id: "1",
		name: "bobertmd",
		type: 1,
	});
}

/** 入力画面に、valueを書いて送る。上の小さな文字(Text Display)も、送った画面の部品として届く */
function submit(guildId: string, customId: string, value: string) {
	return inGuild(guildId, InteractionType.ModalSubmit, {
		custom_id: customId,
		components: [
			{ type: ComponentType.TextDisplay, id: 1 },
			{
				type: ComponentType.Label,
				id: 2,
				component: {
					type: ComponentType.TextInput,
					id: 3,
					custom_id: "content",
					value,
				},
			},
		],
	});
}

/** 保留にした応答の書き換え(本人にだけ見える結果) */
function edits(calls: FetchCall[]) {
	return calls
		.filter(
			(call) =>
				call.method === "PATCH" &&
				call.url.pathname ===
					`/api/v10/webhooks/${env.DISCORD_APPLICATION_ID}/interaction-token/messages/@original`,
		)
		.map((call) => call.body);
}

/** bobがBobert.mdを書いたことにする。書いた日時(更新日時)を返す */
async function seed(
	guildId: string,
	content = SERVER_INFO,
	now = Date.now() - 60_000,
): Promise<number> {
	await saveBobertMd(env.DB, guildId, 0, content, BOB_EDITOR, now);
	const saved = await getBobertMd(env.DB, guildId);
	if (saved === null) {
		throw new Error("seed failed");
	}
	return saved.updatedAt;
}

describe("/bobertmd のコマンド", () => {
	it("サーバーの誰でも使えるコマンドとして登録し、/help に使い方を書く(スキルの行の次)", () => {
		const command = COMMANDS.find((item) => item.name === "bobertmd");
		expect(command).toEqual({
			type: 1,
			contexts: [0],
			integration_types: [0],
			name: "bobertmd",
			description:
				"Bobert.md(このサーバーの全員への返答で、AIが毎回読む情報や指示)の確認と編集",
		});
		const lines = helpText().split("\n");
		const skillLine = lines.findIndex((line) =>
			line.startsWith("- `/regskills` で登録したスキル"),
		);
		expect(lines[skillLine + 1]).toBe(
			"- `/bobertmd` で、このサーバーの情報やAIへの指示を、Bobert.mdに書いておけます。AIは、このサーバーの全員への返答で毎回読みます。誰でも編集できます。",
		);
		expect(lines).toContain(
			"- `/bobertmd`: Bobert.md(このサーバーの全員への返答で、AIが毎回読む情報や指示)の確認と編集",
		);
	});
});

describe("/bobertmd の入力画面", () => {
	it("まだ誰も編集していなければ、空の入力画面を開く。複数行で、4000文字まで書ける", async () => {
		const response = await sendInteraction(bobertmdCommand(newGuild()));

		expect(response).toEqual({
			type: InteractionResponseType.Modal,
			data: {
				custom_id: "bobertmd:edit:0",
				title: "Bobert.mdを編集する",
				components: [
					{
						type: ComponentType.Label,
						label: "Bobert.md",
						description:
							"このサーバーの全員への返答で、AIが毎回読む情報や指示。4000文字まで。空にすると消える",
						component: {
							type: ComponentType.TextInput,
							custom_id: "content",
							style: TextInputStyle.Paragraph,
							placeholder:
								"例: 大学のゲームサークルのサーバー。活動は毎週水曜。サークル内の用語には短い説明を付けて",
							required: false,
							max_length: 4000,
						},
					},
				],
			},
		});
	});

	it("今の内容を入れて開き、最後に編集した人と日付(日本時間)を上に書く", async () => {
		const guildId = newGuild();
		// 日本時間では、2026-11-04 01:00
		const updatedAt = await seed(
			guildId,
			SERVER_INFO,
			Date.parse("2026-11-03T16:00:00Z"),
		);

		const response = await sendInteraction(bobertmdCommand(guildId));

		expect(response.data.custom_id).toBe(`bobertmd:edit:${updatedAt}`);
		expect(response.data.components[0]).toEqual({
			type: ComponentType.TextDisplay,
			content: "-# 最後の編集: bob(2026-11-04)",
		});
		expect(response.data.components[1].component.value).toBe(SERVER_INFO);
	});

	it("空にされていたら、入力欄は空のまま開き、消した人を上に書く", async () => {
		const guildId = newGuild();
		const updatedAt = await seed(guildId);
		await saveBobertMd(env.DB, guildId, updatedAt, "", {
			id: ALICE.id,
			name: "alice",
		});

		const response = await sendInteraction(bobertmdCommand(guildId));

		expect(response.data.components[0].content).toMatch(
			/^-# 最後の編集: alice\(\d{4}-\d{2}-\d{2}\)$/,
		);
		expect(response.data.components[1].component.value).toBeUndefined();
	});
});

describe("Bobert.mdの保存", () => {
	it("送った内容を保存し、結果を本人にだけ見せる。前後の空白は除き、編集した人を残す", async () => {
		const guildId = newGuild();
		const calls = mockFetch(() => Response.json({}));
		const modal = await sendInteraction(bobertmdCommand(guildId));

		const response = await sendInteraction(
			submit(guildId, modal.data.custom_id, `  ${SERVER_INFO}\n\n `),
		);

		expect(response).toEqual({
			type: InteractionResponseType.DeferredChannelMessageWithSource,
			data: { flags: MessageFlags.Ephemeral },
		});
		expect(edits(calls)).toEqual([{ content: SAVED }]);
		expect(await getBobertMd(env.DB, guildId)).toMatchObject({
			content: SERVER_INFO,
			editedByName: "Alice",
		});
	});

	it("書き換えたら、次の画面には新しい内容が入る", async () => {
		const guildId = newGuild();
		await seed(guildId);
		mockFetch(() => Response.json({}));
		const modal = await sendInteraction(bobertmdCommand(guildId));

		await sendInteraction(submit(guildId, modal.data.custom_id, "丁寧語で"));
		const next = await sendInteraction(bobertmdCommand(guildId));

		expect(next.data.components[1].component.value).toBe("丁寧語で");
		expect(next.data.custom_id).not.toBe(modal.data.custom_id);
	});

	it("空にして送ったら消す。誰が消したかは残す", async () => {
		const guildId = newGuild();
		await seed(guildId);
		const calls = mockFetch(() => Response.json({}));
		const modal = await sendInteraction(bobertmdCommand(guildId));

		await sendInteraction(submit(guildId, modal.data.custom_id, "  \n "));

		expect(edits(calls)).toEqual([{ content: CLEARED }]);
		expect(await getBobertMd(env.DB, guildId)).toMatchObject({
			content: "",
			editedByName: "Alice",
		});
	});

	it("何も変えずに送ったら、保存し直さない(最後に編集した人は変えない)", async () => {
		const guildId = newGuild();
		const updatedAt = await seed(guildId);
		const calls = mockFetch(() => Response.json({}));
		const modal = await sendInteraction(bobertmdCommand(guildId));

		await sendInteraction(submit(guildId, modal.data.custom_id, SERVER_INFO));

		expect(edits(calls)).toEqual([{ content: SAVED }]);
		expect(await getBobertMd(env.DB, guildId)).toEqual({
			content: SERVER_INFO,
			editedByName: "bob",
			updatedAt,
		});
	});

	it("編集の画面を開いている間に、ほかの人が変えていたら、保存せずに、送った内容を添付して知らせる", async () => {
		const guildId = newGuild();
		const updatedAt = await seed(guildId);
		const modal = await sendInteraction(bobertmdCommand(guildId));
		await saveBobertMd(
			env.DB,
			guildId,
			updatedAt,
			"ほかの人の内容",
			BOB_EDITOR,
		);
		const calls = mockFetch(() => Response.json({}));

		await sendInteraction(
			submit(guildId, modal.data.custom_id, "わたしの内容"),
		);

		expect(edits(calls)).toEqual([
			{
				content: CONFLICT,
				attachments: [{ id: 0, filename: "Bobert.md" }],
				files: [{ name: "Bobert.md", content: "わたしの内容" }],
			},
		]);
		expect((await getBobertMd(env.DB, guildId))?.content).toBe(
			"ほかの人の内容",
		);
	});

	it("まだ誰も編集していないときに開いた画面でも、ほかの人が先に書いていたら、上書きしない", async () => {
		const guildId = newGuild();
		const modal = await sendInteraction(bobertmdCommand(guildId));
		await seed(guildId, "ほかの人の内容");
		const calls = mockFetch(() => Response.json({}));

		await sendInteraction(
			submit(guildId, modal.data.custom_id, "わたしの内容"),
		);

		expect(edits(calls)).toEqual([
			expect.objectContaining({ content: CONFLICT }),
		]);
		expect((await getBobertMd(env.DB, guildId))?.content).toBe(
			"ほかの人の内容",
		);
	});

	it("空にしようとして重なったときは、添付するものがないので、添付の文を書かない", async () => {
		const guildId = newGuild();
		const updatedAt = await seed(guildId);
		const modal = await sendInteraction(bobertmdCommand(guildId));
		await saveBobertMd(
			env.DB,
			guildId,
			updatedAt,
			"ほかの人の内容",
			BOB_EDITOR,
		);
		const calls = mockFetch(() => Response.json({}));

		await sendInteraction(submit(guildId, modal.data.custom_id, ""));

		expect(edits(calls)).toEqual([
			{
				content:
					"編集の画面を開いている間に、ほかの人がBobert.mdを変更したため、保存しませんでした。`/bobertmd` から開き直して、もう一度試してください。",
			},
		]);
		expect((await getBobertMd(env.DB, guildId))?.content).toBe(
			"ほかの人の内容",
		);
	});

	it("4000文字を超えた分は、絵文字を半分に割らずに切り詰める(次に入力画面を開けるように)", async () => {
		const guildId = newGuild();
		mockFetch(() => Response.json({}));

		// 絵文字(UTF-16で2つ分)が、4000の境目をまたぐ
		await sendInteraction(
			submit(guildId, "bobertmd:edit:0", `${"あ".repeat(3999)}😀`),
		);

		expect((await getBobertMd(env.DB, guildId))?.content).toBe(
			"あ".repeat(3999),
		);
	});

	it("保存に失敗したら、少し待ってから試すよう伝える", async () => {
		const calls = mockFetch(() => Response.json({}));
		const brokenDb = {
			prepare: () => {
				throw new Error("D1 is down");
			},
		} as unknown as D1Database;

		await sendInteraction(submit(newGuild(), "bobertmd:edit:0", "内容"), {
			...env,
			DB: brokenDb,
		});

		expect(edits(calls)).toEqual([{ content: SAVE_FAILED }]);
	});
});

describe("返答でBobert.mdを使う", () => {
	const testEnv: Env = {
		...env,
		INGEST_QUEUE: {
			send: async () => {},
			sendBatch: async () => {},
		} as unknown as Queue,
	};

	let nextMessageId = 87500;
	function newMessageId(): string {
		return String(nextMessageId++);
	}

	async function userWith(provider: "anthropic" | "openrouter") {
		const user = { ...ALICE, id: newMessageId() };
		await saveCredential(env, user.id, provider, {
			apiKey: `key-${provider}`,
			workspaceId: null,
		});
		return user;
	}

	function mention(user: typeof ALICE, text: string): APIMessage {
		return discordMessage(newMessageId(), user, `<@${BOT.id}> ${text}`, {
			mentions: [BOT],
		});
	}

	function respondJob(message: APIMessage, guildId: string): RespondJob {
		return {
			kind: "respond",
			messageId: message.id,
			channelId: CHANNEL_ID,
			guildId,
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

	/** AIへのリクエスト(OpenRouter)の、指示 */
	function systemSent(calls: FetchCall[]): unknown {
		const request = calls.find(
			(call) => call.url.pathname === "/api/v1/chat/completions",
		)?.body as { messages: { role: string; content: unknown }[] } | undefined;
		return request?.messages[0];
	}

	function openRouterChat(text: string): Response {
		return Response.json({
			choices: [{ message: { content: text }, finish_reason: "stop" }],
			usage: { prompt_tokens: 10, completion_tokens: 5 },
		});
	}

	it("Bobert.mdの扱いを書いた前置きに続けて、中身をタグで囲んで渡す", () => {
		expect(bobertMdBlock("丁寧語で")).toBe(
			`${BOBERT_MD_INTRO}\n\n<bobert_md>\n丁寧語で\n</bobert_md>`,
		);
		expect(BOBERT_MD_INTRO).toContain(
			"このユーザー(返答を頼んだ人)の指示や頼みと食い違うときは、そちらを優先してください。",
		);
	});

	it("共通の指示の次に入れる(スキルの一覧と、本人の指示より前)", async () => {
		const guildId = newGuild();
		await seed(guildId);
		await addSkill(
			env.DB,
			guildId,
			{
				name: "meeting-notes",
				description: "議事録を書く手順",
				body: "決まったことを書く",
			},
			BOB_EDITOR,
		);
		const user = await userWith("openrouter");
		await updateUserSettings(env.DB, user.id, { customPrompt: "敬語で答えて" });
		const trigger = mention(user, "こんにちは");
		const calls = mockApis(trigger, () => openRouterChat("こんにちは!"));

		await handleRespondJob(respondJob(trigger, guildId), testEnv);

		expect(systemSent(calls)).toEqual({
			role: "system",
			content: [
				COMMON_SYSTEM_PROMPT,
				bobertMdBlock(SERVER_INFO),
				`${SKILL_LIST_INTRO}\n\n- meeting-notes: 議事録を書く手順`,
				"このユーザーからの指示:\n敬語で答えて",
			].join("\n\n"),
		});
	});

	it("Anthropicで呼ぶときも、共通の指示の次のブロックにする", async () => {
		const guildId = newGuild();
		await seed(guildId);
		const user = await userWith("anthropic");
		const trigger = mention(user, "こんにちは");
		const calls = mockApis(trigger, () =>
			anthropicStreamOf([{ type: "text", text: "こんにちは!" }]),
		);

		await handleRespondJob(respondJob(trigger, guildId), testEnv);

		const request = calls.find(
			(call) => call.url.hostname === "api.anthropic.com",
		)?.body as { system: { text: string }[] };
		expect(request.system.map((block) => block.text)).toEqual([
			COMMON_SYSTEM_PROMPT,
			bobertMdBlock(SERVER_INFO),
		]);
	});

	it("道具を使えないモデルにも渡す", async () => {
		const guildId = newGuild();
		await seed(guildId);
		const user = await userWith("openrouter");
		await updateUserSettings(env.DB, user.id, {
			modelKey: "custom",
			customModelId: "x-ai/old-model",
		});
		const trigger = mention(user, "こんにちは");
		const calls = mockApis(trigger, (call) =>
			call.url.pathname === "/api/v1/models"
				? Response.json({
						data: [
							{ id: "x-ai/old-model", supported_parameters: ["max_tokens"] },
						],
					})
				: openRouterChat("こんにちは!"),
		);

		await handleRespondJob(respondJob(trigger, guildId), testEnv);

		expect(systemSent(calls)).toEqual({
			role: "system",
			content: [COMMON_SYSTEM_PROMPT, bobertMdBlock(SERVER_INFO)].join("\n\n"),
		});
	});

	it("空にされたBobert.mdと、ほかのサーバーのBobert.mdは入れない", async () => {
		const cleared = newGuild();
		const updatedAt = await seed(cleared);
		await saveBobertMd(env.DB, cleared, updatedAt, "", BOB_EDITOR);
		await seed(newGuild());

		for (const guildId of [cleared, newGuild()]) {
			const user = await userWith("openrouter");
			const trigger = mention(user, "こんにちは");
			const calls = mockApis(trigger, () => openRouterChat("こんにちは!"));

			await handleRespondJob(respondJob(trigger, guildId), testEnv);

			expect(systemSent(calls)).toEqual({
				role: "system",
				content: COMMON_SYSTEM_PROMPT,
			});
			vi.restoreAllMocks();
		}
	});
});
