import { env } from "cloudflare:workers";
import type { APIMessage } from "discord-api-types/v10";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	formatSkillFile,
	parseSkillFile,
} from "../src/interactions/skill-file";
import { clearModelInfoCache } from "../src/llm/model-info";
import { chatWithOpenRouter } from "../src/llm/openrouter";
import { TOOL_LIMIT_REACHED } from "../src/llm/tools";
import type { ChatRequest, ChatTool } from "../src/llm/types";
import type { RespondJob } from "../src/queue/messages";
import { handleRespondJob } from "../src/respond/handler";
import { COMMON_SYSTEM_PROMPT, SKILL_LIST_INTRO } from "../src/respond/prompt";
import { readSkillTool, type SkillReads } from "../src/respond/tools";
import {
	addSkill,
	countSkills,
	deletePendingSkill,
	deleteSkill,
	findSkillByName,
	getPendingSkill,
	getSkill,
	listSkills,
	MAX_SKILLS,
	overwriteSkill,
	type SkillContent,
	savePendingSkill,
	updateSkill,
} from "../src/store/skills";
import { saveCredential, updateUserSettings } from "../src/store/users";
import { ALICE, BOT, CHANNEL_ID, discordMessage } from "./fixtures";
import { anthropicStreamOf, type FetchCall, mockFetch } from "./helpers";

afterEach(() => {
	vi.restoreAllMocks();
	clearModelInfoCache();
});

const BACKSLASH = String.fromCharCode(92);
const BOM = String.fromCharCode(0xfeff);

const MEETING_NOTES: SkillContent = {
	name: "meeting-notes",
	description: "会議の議事録を書く手順。議事録やまとめを頼まれたときに使う",
	body: "決まったこと、宿題、次回の予定の3つに分けて書く",
};

const TRPG_RULES: SkillContent = {
	name: "trpg-rules",
	description: "このサーバーのTRPGのハウスルール。\nセッションの前に読む",
	body: "判定は2D6で行う",
};

const BOB = { id: "200", name: "bob" };

/** テストごとに、ほかのテストと重ならないサーバーを使う(スキルはサーバーごとなので) */
let nextGuildId = 9100;
function newGuild(): string {
	return String(nextGuildId++);
}

describe("SKILL.mdを読む", () => {
	it("冒頭のnameとdescriptionを読み、ほかの項目は使わない。本文の前の空行と後ろの空白は外す", () => {
		const file = [
			"---",
			"name: meeting-notes",
			"description: 会議の議事録を書く手順。議事録やまとめを頼まれたときに使う",
			"license: MIT",
			"allowed-tools:",
			"- Read",
			"metadata:",
			"  author: alice",
			"---",
			"",
			"# 議事録",
			"",
			"  1. 決まったこと",
			"",
			"",
		].join("\n");

		expect(parseSkillFile(file)).toEqual({
			name: "meeting-notes",
			description: "会議の議事録を書く手順。議事録やまとめを頼まれたときに使う",
			body: "# 議事録\n\n  1. 決まったこと",
		});
	});

	it("引用符で囲んだ値を読む。ダブルクォートのエスケープと、シングルクォートの「''」も戻す", () => {
		const double = [
			"---",
			'name: "pdf-tools"',
			`description: "表を${BACKSLASH}"そのまま${BACKSLASH}"読む: ${BACKSLASH}u3042${BACKSLASH}t${BACKSLASH}${BACKSLASH}" # コメント`,
			"---",
			"本文",
		].join("\n");
		const single = [
			"---",
			"name: 'notes'",
			"description: 'It''s a note:",
			"  続きの行'",
			"---",
		].join("\n");

		expect(parseSkillFile(double)).toEqual({
			name: "pdf-tools",
			description: `表を"そのまま"読む: あ\t${BACKSLASH}`,
			body: "本文",
		});
		expect(parseSkillFile(single)).toEqual({
			name: "notes",
			description: "It's a note: 続きの行",
			body: "",
		});
	});

	it("「>」は行を空白でつなぎ(空行は改行にする)、「|」は改行を残す。字下げした続きの行も、同じ値として読む", () => {
		const description = (lines: string[]) =>
			parseSkillFile(["---", "name: notes", ...lines, "---", "本文"].join("\n"))
				?.description;

		expect(
			description([
				"description: >-",
				"  長い説明の",
				"  続き",
				"",
				"  次の段落",
			]),
		).toBe("長い説明の 続き\n次の段落");
		expect(description(["description: |", "  1行目", "  2行目"])).toBe(
			"1行目\n2行目",
		);
		expect(
			description(["description: Extract text", "  and tables. # comment"]),
		).toBe("Extract text and tables.");
		expect(description(["description:", "  次の行から始まる説明"])).toBe(
			"次の行から始まる説明",
		);
	});

	it("先頭のBOMと、CRLFの改行も読める", () => {
		expect(
			parseSkillFile(
				`${BOM}---\r\nname: notes\r\ndescription: 説明\r\n---\r\n本文\r\n`,
			),
		).toEqual({ name: "notes", description: "説明", body: "本文" });
	});

	it("フロントマターがないか、閉じていないか、nameかdescriptionが文字でなければ、読めない", () => {
		expect(parseSkillFile("# 見出し\n本文")).toBe(null);
		expect(parseSkillFile("---\nname: notes\ndescription: 説明\n")).toBe(null);
		expect(parseSkillFile("---\nname: notes\n---\n本文")).toBe(null);
		expect(
			parseSkillFile("---\nname: notes\ndescription:\n  author: alice\n---\n"),
		).toBe(null);
	});
});

describe("SKILL.mdを書く", () => {
	it("そのまま書ける説明は、引用符で囲まない", () => {
		expect(formatSkillFile(MEETING_NOTES)).toBe(
			[
				"---",
				"name: meeting-notes",
				"description: 会議の議事録を書く手順。議事録やまとめを頼まれたときに使う",
				"---",
				"",
				"決まったこと、宿題、次回の予定の3つに分けて書く",
				"",
			].join("\n"),
		);
	});

	it("YAMLで別の意味になる説明は、引用符で囲む。書いたものを読むと、元に戻る", () => {
		for (const description of [
			"PDF: 表を読む",
			"- 箇条書き",
			"# 見出し",
			"123",
			"true",
			"改行\nを含む",
			`"引用"と${BACKSLASH}`,
		]) {
			const skill = { name: "notes", description, body: "本文" };
			const text = formatSkillFile(skill);

			expect(text).toContain(`description: ${JSON.stringify(description)}\n`);
			expect(parseSkillFile(text)).toEqual(skill);
		}
	});
});

describe("スキルの保存(D1)", () => {
	it("名前の順に並べる。同じ名前は足さず、20個を超えても足さない", async () => {
		const guildId = newGuild();

		expect(await addSkill(env.DB, guildId, TRPG_RULES, BOB, 1000)).toBe(
			"added",
		);
		expect(await addSkill(env.DB, guildId, MEETING_NOTES, BOB, 2000)).toBe(
			"added",
		);
		expect(await addSkill(env.DB, guildId, MEETING_NOTES, BOB)).toBe(
			"duplicate",
		);
		// ほかのサーバーなら、同じ名前でも足せる
		expect(await addSkill(env.DB, newGuild(), MEETING_NOTES, BOB)).toBe(
			"added",
		);
		expect(await listSkills(env.DB, guildId)).toEqual([
			{
				id: expect.any(Number),
				name: "meeting-notes",
				description: MEETING_NOTES.description,
				createdByName: "bob",
				createdAt: 2000,
				editedByName: null,
				updatedAt: 2000,
			},
			expect.objectContaining({ name: "trpg-rules", createdAt: 1000 }),
		]);

		for (let index = 2; index < MAX_SKILLS; index++) {
			await addSkill(
				env.DB,
				guildId,
				{ ...MEETING_NOTES, name: `s-${index}` },
				BOB,
			);
		}
		expect(
			await addSkill(
				env.DB,
				guildId,
				{ ...MEETING_NOTES, name: "one-more" },
				BOB,
			),
		).toBe("limit");
		expect(await countSkills(env.DB, guildId)).toBe(MAX_SKILLS);
	});

	it("編集の画面を開いたときの更新日時から変わっていたら、書き換えない。同じ時刻に書き換えても、更新日時は進める", async () => {
		const guildId = newGuild();
		await addSkill(env.DB, guildId, MEETING_NOTES, BOB, 1000);
		const added = await findSkillByName(env.DB, guildId, "meeting-notes");
		const id = added?.id ?? 0;
		const alice = { id: ALICE.id, name: "alice" };

		expect(
			await updateSkill(
				env.DB,
				guildId,
				{ id, expectedUpdatedAt: 1000 },
				{ ...MEETING_NOTES, body: "1回目" },
				alice,
				1000,
			),
		).toBe("saved");
		// 1回目で更新日時が進んでいるので、開いたときの更新日時(1000)のままでは書き換えない
		expect(
			await updateSkill(
				env.DB,
				guildId,
				{ id, expectedUpdatedAt: 1000 },
				{ ...MEETING_NOTES, body: "2回目" },
				alice,
				1000,
			),
		).toBe("conflict");
		expect(await getSkill(env.DB, guildId, id)).toMatchObject({
			body: "1回目",
			createdByName: "bob",
			editedByName: "alice",
			createdAt: 1000,
			updatedAt: 1001,
		});
	});

	it("新しい名前のスキルがほかにあれば、書き換えない", async () => {
		const guildId = newGuild();
		await addSkill(env.DB, guildId, MEETING_NOTES, BOB, 1000);
		await addSkill(env.DB, guildId, TRPG_RULES, BOB, 1000);
		const trpg = await findSkillByName(env.DB, guildId, "trpg-rules");

		expect(
			await updateSkill(
				env.DB,
				guildId,
				{ id: trpg?.id ?? 0, expectedUpdatedAt: 1000 },
				{ ...TRPG_RULES, name: "meeting-notes" },
				BOB,
			),
		).toBe("duplicate");
	});

	it("消すと名前を返す。ほかのサーバーのスキルや、壊れたIDは、読めず、消せない", async () => {
		const guildId = newGuild();
		await addSkill(env.DB, guildId, MEETING_NOTES, BOB);
		const id = (await findSkillByName(env.DB, guildId, "meeting-notes"))?.id;

		expect(await getSkill(env.DB, newGuild(), id ?? 0)).toBe(null);
		expect(await deleteSkill(env.DB, newGuild(), id ?? 0)).toBe(null);
		expect(await getSkill(env.DB, guildId, Number.NaN)).toBe(null);
		expect(await deleteSkill(env.DB, guildId, id ?? 0)).toBe("meeting-notes");
		expect(await deleteSkill(env.DB, guildId, id ?? 0)).toBe(null);
		expect(
			await updateSkill(
				env.DB,
				guildId,
				{ id: id ?? 0, expectedUpdatedAt: 0 },
				MEETING_NOTES,
				BOB,
			),
		).toBe("conflict");
	});

	it("名前で置き換える。消されていたら、新しく足す(数の上限は確かめる)", async () => {
		const guildId = newGuild();
		await addSkill(env.DB, guildId, MEETING_NOTES, BOB, 1000);
		const alice = { id: ALICE.id, name: "alice" };
		const replaced = { ...MEETING_NOTES, body: "新しい本文" };

		expect(await overwriteSkill(env.DB, guildId, replaced, alice, 1000)).toBe(
			"saved",
		);
		expect(
			await findSkillByName(env.DB, guildId, "meeting-notes"),
		).toMatchObject({
			body: "新しい本文",
			editedByName: "alice",
			updatedAt: 1001,
		});
		expect(await overwriteSkill(env.DB, guildId, TRPG_RULES, alice)).toBe(
			"added",
		);

		const full = newGuild();
		for (let index = 0; index < MAX_SKILLS; index++) {
			await addSkill(
				env.DB,
				full,
				{ ...MEETING_NOTES, name: `s-${index}` },
				BOB,
			);
		}
		expect(await overwriteSkill(env.DB, full, MEETING_NOTES, alice)).toBe(
			"limit",
		);
	});

	it("置き換えるかを確かめている間の内容は、人ごと・サーバーごとに1つだけ残し、その人しか読めない", async () => {
		const guildId = newGuild();

		const first = await savePendingSkill(
			env.DB,
			guildId,
			ALICE.id,
			MEETING_NOTES,
		);
		const second = await savePendingSkill(
			env.DB,
			guildId,
			ALICE.id,
			TRPG_RULES,
		);
		const other = await savePendingSkill(
			env.DB,
			newGuild(),
			ALICE.id,
			MEETING_NOTES,
		);

		// 同じ人が同じサーバーで確かめ直すと、前の内容は消える。ほかのサーバーの分は残る
		expect(await getPendingSkill(env.DB, guildId, ALICE.id, first)).toBe(null);
		expect(await getPendingSkill(env.DB, guildId, ALICE.id, second)).toEqual(
			TRPG_RULES,
		);
		expect(await getPendingSkill(env.DB, guildId, BOB.id, second)).toBe(null);
		expect(await getPendingSkill(env.DB, guildId, ALICE.id, other)).toBe(null);
		await deletePendingSkill(env.DB, second);
		expect(await getPendingSkill(env.DB, guildId, ALICE.id, second)).toBe(null);
	});
});

describe("スキルを読む道具", () => {
	it("名前を選んで本文を読む。読んだスキルを記録し、1回の返答で読めるのは3つまで", async () => {
		const guildId = newGuild();
		await addSkill(env.DB, guildId, MEETING_NOTES, BOB);
		await addSkill(env.DB, guildId, TRPG_RULES, BOB);
		const reads: SkillReads = { calls: 0, names: [] };
		const tool = readSkillTool(
			env.DB,
			guildId,
			await listSkills(env.DB, guildId),
			reads,
		);

		expect(tool.countsTowardLimit).toBe(false);
		expect(tool.inputSchema).toEqual({
			type: "object",
			properties: {
				name: {
					type: "string",
					enum: ["meeting-notes", "trpg-rules"],
					description: "読むスキルの名前です",
				},
			},
			required: ["name"],
		});
		expect(await tool.run({ name: "meeting-notes" })).toBe(
			`スキル「meeting-notes」の本文です。この手順に従って答えてください。\n\n${MEETING_NOTES.body}`,
		);
		expect(await tool.run({ name: "missing" })).toBe(
			"「missing」というスキルはありません。一覧にある名前で指定してください。",
		);
		await tool.run({ name: "meeting-notes" });
		expect(await tool.run({ name: "trpg-rules" })).toBe(
			"1回の返答で読めるスキルは3つまでです。読んだスキルだけで答えてください。",
		);
		expect(reads).toEqual({ calls: 3, names: ["meeting-notes"] });
	});
});

describe("道具の呼び出しの上限", () => {
	/** 呼ばれた回数を数える、偽物の道具 */
	function fakeTool(name: string, countsTowardLimit?: false) {
		const tool: ChatTool & { calls: number } = {
			name,
			description: name,
			inputSchema: { type: "object", properties: {} },
			calls: 0,
			...(countsTowardLimit === false ? { countsTowardLimit } : {}),
			run: async () => {
				tool.calls++;
				return "結果";
			},
		};
		return tool;
	}

	it("スキルを読む道具は、上限(1回の返答で合計5回)に数えない", async () => {
		const history = fakeTool("read_channel_history");
		const skill = fakeTool("read_skill", false);
		const request: ChatRequest = {
			model: "openai/gpt-6.1-sol",
			system: ["共通の指示"],
			messages: [
				{ role: "user", parts: [{ type: "text", text: "こんにちは" }] },
			],
			effort: null,
			webSearch: false,
			tools: [history, skill],
			maxTokens: 1000,
		};
		let round = 0;
		const calls = mockFetch(() => {
			round++;
			if (round === 1) {
				return openRouterToolCalls([
					["s1", "read_skill"],
					...[1, 2, 3, 4, 5].map((index): [string, string] => [
						`h${index}`,
						"read_channel_history",
					]),
				]);
			}
			// 上限に達した後に呼ばれた道具は、実行しない。スキルを読む道具は、実行する
			return round === 2
				? openRouterToolCalls([
						["h6", "read_channel_history"],
						["s2", "read_skill"],
					])
				: openRouterChat("答え");
		});

		const result = await chatWithOpenRouter("sk-or-test", request);

		const bodies = calls.map(
			(call) =>
				call.body as { tool_choice?: string; messages: { content: string }[] },
		);
		expect(history.calls).toBe(5);
		expect(skill.calls).toBe(2);
		// 上限を超えて呼ばれた分も数える。スキルを読む道具の分は数えない
		expect(result.toolCalls).toBe(6);
		expect(bodies[1]?.tool_choice).toBe("none");
		expect(bodies[2]?.messages.slice(-2)).toEqual([
			{ role: "tool", tool_call_id: "h6", content: TOOL_LIMIT_REACHED.content },
			{ role: "tool", tool_call_id: "s2", content: "結果" },
		]);
		expect(result.text).toBe("答え");
	});
});

describe("返答でスキルを使う", () => {
	const testEnv: Env = {
		...env,
		INGEST_QUEUE: {
			send: async () => {},
			sendBatch: async () => {},
		} as unknown as Queue,
	};

	let nextMessageId = 9500;
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

	/** 投稿した返信の本文 */
	function posted(calls: FetchCall[]): string[] {
		return calls
			.filter(
				(call) =>
					call.method === "POST" &&
					call.url.pathname === `/api/v10/channels/${CHANNEL_ID}/messages`,
			)
			.map((call) => (call.body as { content: string }).content);
	}

	/** AIへのリクエスト(OpenRouter) */
	function chatRequests(calls: FetchCall[]) {
		return calls
			.filter((call) => call.url.pathname === "/api/v1/chat/completions")
			.map(
				(call) =>
					call.body as {
						messages: { role: string; content: unknown }[];
						tools?: { function: { name: string } }[];
					},
			);
	}

	const SKILL_LIST = [
		SKILL_LIST_INTRO,
		"",
		`- meeting-notes: ${MEETING_NOTES.description}`,
		// 説明の改行は空白にする
		"- trpg-rules: このサーバーのTRPGのハウスルール。 セッションの前に読む",
	].join("\n");

	it("一覧を、共通の指示の次(本人の指示の前)に入れ、スキルを読む道具を渡す。読んだら本文を返し、返答の末尾に使ったスキルを書く", async () => {
		const guildId = newGuild();
		await addSkill(env.DB, guildId, MEETING_NOTES, BOB);
		await addSkill(env.DB, guildId, TRPG_RULES, BOB);
		const user = await userWith("openrouter");
		await updateUserSettings(env.DB, user.id, { customPrompt: "敬語で答えて" });
		const trigger = mention(user, "議事録にまとめて");
		let round = 0;
		const calls = mockApis(trigger, () =>
			round++ === 0
				? openRouterToolCalls([
						["call_1", "read_skill", { name: "meeting-notes" }],
					])
				: openRouterChat("まとめました。"),
		);

		await handleRespondJob(respondJob(trigger, guildId), testEnv);

		const [first, second] = chatRequests(calls);
		expect(first?.messages[0]).toEqual({
			role: "system",
			content: [
				COMMON_SYSTEM_PROMPT,
				SKILL_LIST,
				"このユーザーからの指示:\n敬語で答えて",
			].join("\n\n"),
		});
		expect(first?.tools?.map((tool) => tool.function.name)).toEqual([
			"read_channel_history",
			"search_channel_messages",
			"list_channels",
			"find_members",
			"read_file",
			"read_skill",
		]);
		expect(second?.messages.at(-1)).toEqual({
			role: "tool",
			tool_call_id: "call_1",
			content: `スキル「meeting-notes」の本文です。この手順に従って答えてください。\n\n${MEETING_NOTES.body}`,
		});
		expect(posted(calls)).toEqual([
			"まとめました。\n-# スキル「meeting-notes」を使いました",
		]);
	});

	it("Anthropicで呼ぶときも同じ。2つ読んだら、両方の名前を書く", async () => {
		const guildId = newGuild();
		await addSkill(env.DB, guildId, MEETING_NOTES, BOB);
		await addSkill(env.DB, guildId, TRPG_RULES, BOB);
		const user = await userWith("anthropic");
		const trigger = mention(user, "TRPGの議事録を書いて");
		let round = 0;
		const calls = mockApis(trigger, () =>
			round++ === 0
				? anthropicStreamOf(
						[
							{
								type: "tool_use",
								id: "toolu_1",
								name: "read_skill",
								input: { name: "trpg-rules" },
							},
							{
								type: "tool_use",
								id: "toolu_2",
								name: "read_skill",
								input: { name: "meeting-notes" },
							},
						],
						{ stopReason: "tool_use" },
					)
				: anthropicStreamOf([{ type: "text", text: "書きました。" }]),
		);

		await handleRespondJob(respondJob(trigger, guildId), testEnv);

		const request = calls.find(
			(call) => call.url.hostname === "api.anthropic.com",
		)?.body as {
			system: { text: string }[];
			tools: { name: string; input_schema: unknown }[];
		};
		expect(request.system.map((block) => block.text)).toEqual([
			COMMON_SYSTEM_PROMPT,
			SKILL_LIST,
		]);
		expect(request.tools.map((tool) => tool.name)).toEqual([
			"read_channel_history",
			"search_channel_messages",
			"list_channels",
			"find_members",
			"read_file",
			"read_skill",
		]);
		expect(posted(calls)).toEqual([
			"書きました。\n-# スキル「trpg-rules」「meeting-notes」を使いました",
		]);
	});

	it("スキルがないサーバーでは、一覧も道具も渡さない", async () => {
		const user = await userWith("openrouter");
		const trigger = mention(user, "こんにちは");
		const calls = mockApis(trigger, () => openRouterChat("こんにちは!"));

		await handleRespondJob(respondJob(trigger, newGuild()), testEnv);

		const [request] = chatRequests(calls);
		expect(request?.messages[0]).toEqual({
			role: "system",
			content: COMMON_SYSTEM_PROMPT,
		});
		expect(request?.tools?.map((tool) => tool.function.name)).toEqual([
			"read_channel_history",
			"search_channel_messages",
			"list_channels",
			"find_members",
			"read_file",
		]);
		expect(posted(calls)).toEqual(["こんにちは!"]);
	});

	it("道具を使えないモデルには、スキルの一覧も道具も渡さず、注記もしない", async () => {
		const guildId = newGuild();
		await addSkill(env.DB, guildId, MEETING_NOTES, BOB);
		const user = await userWith("openrouter");
		await updateUserSettings(env.DB, user.id, {
			modelKey: "custom",
			customModelId: "x-ai/old-model",
		});
		const trigger = mention(user, "議事録にまとめて");
		const calls = mockApis(trigger, (call) =>
			call.url.pathname === "/api/v1/models"
				? Response.json({
						data: [
							{ id: "x-ai/old-model", supported_parameters: ["max_tokens"] },
						],
					})
				: openRouterChat("まとめました。"),
		);

		await handleRespondJob(respondJob(trigger, guildId), testEnv);

		const [request] = chatRequests(calls);
		expect(request?.messages[0]?.content).toBe(COMMON_SYSTEM_PROMPT);
		expect(request).not.toHaveProperty("tools");
		expect(posted(calls)).toEqual(["まとめました。"]);
	});
});

/** OpenRouterの、道具を呼ぶ応答 */
function openRouterToolCalls(
	calls: [id: string, name: string, input?: unknown][],
): Response {
	return Response.json({
		choices: [
			{
				message: {
					content: null,
					tool_calls: calls.map(([id, name, input]) => ({
						id,
						type: "function",
						function: { name, arguments: JSON.stringify(input ?? {}) },
					})),
				},
				finish_reason: "tool_calls",
			},
		],
		usage: { prompt_tokens: 100, completion_tokens: 10 },
	});
}

/** OpenRouterの、ふつうの答え */
function openRouterChat(text: string): Response {
	return Response.json({
		choices: [{ message: { content: text }, finish_reason: "stop" }],
		usage: { prompt_tokens: 10, completion_tokens: 5 },
	});
}
