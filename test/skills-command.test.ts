import { env } from "cloudflare:workers";
import type { APIUser } from "discord-api-types/v10";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ButtonStyle,
	ComponentType,
	InteractionResponseType,
	InteractionType,
	MessageFlags,
} from "../src/discord/constants";
import { COMMANDS } from "../src/interactions/commands";
import { helpText } from "../src/interactions/help";
import { formatSkillFile } from "../src/interactions/skill-file";
import {
	addSkill,
	deleteSkill,
	findSkillByName,
	getSkill,
	installSkills,
	listSkillFiles,
	MAX_SKILLS,
	type SkillContent,
	updateSkill,
} from "../src/store/skills";
import {
	COMMIT,
	marketplaceJson,
	NAKAMABA_SKILL,
	nakamabaFiles,
	tarGz,
} from "./archive-fixtures";
import { ALICE, BOB } from "./fixtures";
import {
	type FetchCall,
	guildInteraction,
	mockFetch,
	sendInteraction,
} from "./helpers";

afterEach(() => {
	vi.restoreAllMocks();
});

const INVALID_NAME =
	"名前は、英小文字、数字、ハイフンだけで、64文字までにしてください。例: `meeting-notes`";
const LIMIT_REACHED =
	"スキルは20個までです。使っていないスキルを削除してから追加してください。";
const UNREADABLE_FILE = [
	"SKILL.mdを読めませんでした。冒頭に、次の形で名前と説明を書いたテキストのファイルを添付してください。",
	"```",
	"---",
	"name: meeting-notes",
	"description: 会議の議事録を書く手順。議事録を頼まれたときに使う",
	"---",
	"```",
].join("\n");
const CONFLICT =
	"編集の画面を開いている間に、ほかの人がこのスキルを変更したか削除したため、保存しませんでした。送った内容を添付します。`/skills` から開き直して、もう一度試してください。";
const NOT_FOUND =
	"このスキルは見つかりません。ほかの人が削除したか、名前を変えた可能性があります。`/skills` から開き直してください。";
const SAVE_FAILED =
	"スキルを保存できませんでした。少し待ってから、もう一度試してください。";
const DRAFT_ATTACHED =
	"書いた内容を添付します。直してから `/regskills` に添付すると、登録できます。";
const PENDING_GONE =
	"この置き換えは、もう使えません。もう一度 `/regskills` から登録してください。";
const ADDED = "スキル「meeting-notes」を追加しました。次の返答から使います。";
const SAVED = "スキル「meeting-notes」を保存しました。次の返答から使います。";

const MEETING_NOTES: SkillContent = {
	name: "meeting-notes",
	description: "会議の議事録を書く手順。議事録やまとめを頼まれたときに使う",
	body: "決まったこと、宿題、次回の予定の3つに分けて書く",
};

/** MEETING_NOTESを書いたSKILL.md(使わない項目も入れておく) */
const FILE = [
	"---",
	"name: meeting-notes",
	"description: 会議の議事録を書く手順。議事録やまとめを頼まれたときに使う",
	"license: MIT",
	"---",
	"",
	"決まったこと、宿題、次回の予定の3つに分けて書く",
	"",
].join("\n");

/** 添付したファイル(SKILL.md)。中身は、CDN_URLから読む(mockDiscordで返す) */
const CDN_URL =
	"https://cdn.discordapp.com/ephemeral-attachments/1/700/SKILL.md";

/** テストごとに、ほかのテストと重ならないサーバーを使う(スキルはサーバーごとなので) */
let nextGuildId = 7100;
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

function attachment(size: number) {
	return {
		id: "700",
		filename: "SKILL.md",
		size,
		url: CDN_URL,
		proxy_url: CDN_URL,
	};
}

function skillsCommand(guildId: string) {
	return inGuild(guildId, InteractionType.ApplicationCommand, {
		id: "1",
		name: "skills",
		type: 1,
	});
}

/** /regskills。fileSizeを渡すと、その大きさのSKILL.mdを添付する */
function regskills(guildId: string, fileSize?: number) {
	return inGuild(guildId, InteractionType.ApplicationCommand, {
		id: "2",
		name: "regskills",
		type: 1,
		...(fileSize === undefined
			? {}
			: {
					options: [{ name: "file", type: 11, value: "700" }],
					resolved: { attachments: { "700": attachment(fileSize) } },
				}),
	});
}

function pressButton(guildId: string, customId: string, user?: APIUser) {
	return inGuild(
		guildId,
		InteractionType.MessageComponent,
		{ custom_id: customId, component_type: ComponentType.Button },
		user,
	);
}

function selectSkill(guildId: string, value: string) {
	return inGuild(guildId, InteractionType.MessageComponent, {
		custom_id: "skills:select",
		component_type: ComponentType.StringSelect,
		values: [value],
	});
}

/** 名前・説明・本文を書く入力画面の送信 */
function submitWritten(
	guildId: string,
	customId: string,
	content: SkillContent,
	user?: APIUser,
) {
	const field = (id: string, value: string) => ({
		type: ComponentType.Label,
		component: { type: ComponentType.TextInput, custom_id: id, value },
	});
	return inGuild(
		guildId,
		InteractionType.ModalSubmit,
		{
			custom_id: customId,
			components: [
				field("name", content.name),
				field("description", content.description),
				field("body", content.body),
			],
		},
		user,
	);
}

/** ファイルを添付する入力画面の送信 */
function submitFile(guildId: string, customId: string, size = 100) {
	return inGuild(guildId, InteractionType.ModalSubmit, {
		custom_id: customId,
		components: [
			{
				type: ComponentType.Label,
				component: {
					type: ComponentType.FileUpload,
					custom_id: "file",
					values: ["700"],
				},
			},
		],
		resolved: { attachments: { "700": attachment(size) } },
	});
}

/** DiscordのAPIとCDNの偽物。CDNは、添付されたファイルとしてfileを返す */
function mockDiscord(file = ""): FetchCall[] {
	return mockFetch((call) =>
		call.url.hostname === "cdn.discordapp.com"
			? new Response(file)
			: Response.json({}),
	);
}

/** 保留にした応答の書き換え(元のメッセージの、新しい中身) */
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

/** 本人にだけ見える、新しいメッセージ */
function followups(calls: FetchCall[]) {
	return calls
		.filter(
			(call) =>
				call.method === "POST" &&
				call.url.pathname ===
					`/api/v10/webhooks/${env.DISCORD_APPLICATION_ID}/interaction-token`,
		)
		.map((call) => call.body);
}

/** 置き換えるかを確かめるメッセージの、「置き換える」ボタンのID */
function overwriteButtonId(message: unknown): string {
	const rows = (
		message as { components?: { components: { custom_id: string }[] }[] }
	).components;
	return rows?.[0]?.components[0]?.custom_id ?? "";
}

/** 置き換えるかを確かめるメッセージの、「置き換える」ボタンの並び */
function overwriteRow(customId: string) {
	return {
		type: ComponentType.ActionRow,
		components: [
			{
				type: ComponentType.Button,
				style: ButtonStyle.Danger,
				custom_id: customId,
				label: "置き換える",
			},
		],
	};
}

/** 書いた内容を添付したことを書き添えた、本人にだけ見えるメッセージ */
function withDraft(message: string, content: SkillContent) {
	return {
		content: `${message}\n${DRAFT_ATTACHED}`,
		attachments: [{ id: 0, filename: "SKILL.md" }],
		files: [{ name: "SKILL.md", content: formatSkillFile(content) }],
	};
}

async function seed(
	guildId: string,
	content: SkillContent = MEETING_NOTES,
	now = Date.now(),
) {
	await addSkill(env.DB, guildId, content, { id: BOB.id, name: "bob" }, now);
	const skill = await findSkillByName(env.DB, guildId, content.name);
	if (skill === null) {
		throw new Error("seed failed");
	}
	return skill;
}

async function seedFull(guildId: string) {
	for (let index = 0; index < MAX_SKILLS; index++) {
		await seed(guildId, { ...MEETING_NOTES, name: `skill-${index}` });
	}
}

describe("/skills と /regskills のコマンド", () => {
	it("コマンドの一覧と/helpに出る", () => {
		expect(COMMANDS).toContainEqual(
			expect.objectContaining({
				name: "skills",
				description: "このサーバーでAIが使うスキル(手順や知識)の一覧と編集",
			}),
		);
		expect(COMMANDS).toContainEqual(
			expect.objectContaining({
				name: "regskills",
				description:
					"スキル(手順や知識)の登録。SKILL.mdを添付するか、入力画面で書くか、プラグインから入れる",
				options: [
					{
						type: 11,
						name: "file",
						description:
							"登録するSKILL.md。添付しなければ、入力画面で名前・説明・本文を書く",
						required: false,
					},
					{
						type: 3,
						name: "plugin",
						description:
							"プラグインから入れるときの、プラグインの名前(例: nakamaba)",
						required: false,
						max_length: 100,
					},
					{
						type: 3,
						name: "marketplace",
						description:
							"プラグインを配っているGitHubのリポジトリ(例: 4rtoflow/Nakamaba)",
						required: false,
						max_length: 200,
					},
				],
			}),
		);
		expect(helpText()).toContain(
			"- `/regskills` で登録したスキル(手順や知識)を、AIが必要に応じて読んで使います。一覧と編集は `/skills` で行います。",
		);
	});
});

describe("/skills", () => {
	it("スキルがなければ「登録されたスキル: なし」とだけ、本人にだけ見せる(ボタンもメニューもない)", async () => {
		const response = await sendInteraction(skillsCommand(newGuild()));

		expect(response).toEqual({
			type: InteractionResponseType.ChannelMessageWithSource,
			data: {
				flags: MessageFlags.Ephemeral,
				content: "**登録されたスキル**: なし",
				components: [],
			},
		});
	});

	it("見出しの次の行から、スキルの名前と説明の全文を、名前の順に箇条書きにする。選ぶメニューも付ける", async () => {
		const guildId = newGuild();
		const trpg = await seed(guildId, {
			name: "trpg-rules",
			description:
				"このサーバーのTRPGのハウスルール。セッションの進め方と、判定の決まりをまとめたもの",
			body: "本文",
		});
		const notes = await seed(guildId);
		await updateSkill(
			env.DB,
			guildId,
			{ id: notes.id, expectedUpdatedAt: notes.updatedAt },
			MEETING_NOTES,
			{ id: ALICE.id, name: "alice" },
		);

		const response = await sendInteraction(skillsCommand(guildId));

		// 誰が登録・編集したかは、一覧には書かない(スキルの画面に書く)
		expect(response.data.content).toBe(
			[
				"**登録されたスキル**",
				"- `meeting-notes`: 会議の議事録を書く手順。議事録やまとめを頼まれたときに使う",
				"- `trpg-rules`: このサーバーのTRPGのハウスルール。セッションの進め方と、判定の決まりをまとめたもの",
			].join("\n"),
		);
		expect(response.data.components).toEqual([
			{
				type: ComponentType.ActionRow,
				components: [
					{
						type: ComponentType.StringSelect,
						custom_id: "skills:select",
						placeholder: "スキルを選んで、中身を見る・編集する",
						options: [
							{
								label: "meeting-notes",
								value: String(notes.id),
								description: MEETING_NOTES.description,
							},
							{
								label: "trpg-rules",
								value: String(trpg.id),
								description:
									"このサーバーのTRPGのハウスルール。セッションの進め方と、判定の決まりをまとめたもの",
							},
						],
					},
				],
			},
		]);
	});

	it("説明の改行は空白にする。1通(2000文字)に収まらなければ、説明を短くする", async () => {
		const guildId = newGuild();
		await seed(guildId, {
			...MEETING_NOTES,
			name: "a-multiline",
			description: "1行目\n2行目",
		});
		for (let index = 1; index < MAX_SKILLS; index++) {
			await seed(guildId, {
				...MEETING_NOTES,
				name: `skill-${String(index).padStart(2, "0")}`,
				description: "あ".repeat(1024),
			});
		}

		const response = await sendInteraction(skillsCommand(guildId));

		const lines: string[] = response.data.content.split("\n");
		expect(response.data.content.length).toBeLessThanOrEqual(2000);
		expect(lines[0]).toBe("**登録されたスキル**");
		expect(lines[1]).toBe("- `a-multiline`: 1行目 2行目");
		// 全文(1024文字)でも100文字でも収まらないので、40文字まで(続きは「…」)に短くする
		expect(lines[2]).toBe(`- \`skill-01\`: ${"あ".repeat(40)}…`);
		expect(lines).toHaveLength(MAX_SKILLS + 1);
	});
});

describe("/regskills(添付なし)", () => {
	it("入力画面を開く。送ると登録し、本人にだけ見えるメッセージに結果を書く", async () => {
		const guildId = newGuild();
		const calls = mockDiscord();

		const modal = await sendInteraction(regskills(guildId));
		const response = await sendInteraction(
			submitWritten(guildId, "skills:register-modal", MEETING_NOTES),
		);

		expect(modal).toEqual({
			type: InteractionResponseType.Modal,
			data: {
				custom_id: "skills:register-modal",
				title: "スキルを追加する",
				components: [
					{
						type: ComponentType.Label,
						label: "名前",
						description: "英小文字、数字、ハイフンで64文字まで",
						component: expect.objectContaining({
							type: ComponentType.TextInput,
							custom_id: "name",
							placeholder: "例: meeting-notes",
							max_length: 64,
						}),
					},
					{
						type: ComponentType.Label,
						label: "説明",
						description:
							"何をするスキルで、いつ使うか。AIはこれを見て、使うかどうかを決める",
						component: expect.objectContaining({
							custom_id: "description",
							placeholder:
								"例: 会議の議事録を書く手順。議事録やまとめを頼まれたときに使う",
							max_length: 1024,
						}),
					},
					{
						type: ComponentType.Label,
						label: "本文",
						description:
							"AIに従ってほしい手順や知識。4000文字まで。長いときはファイルを使う",
						component: expect.objectContaining({
							custom_id: "body",
							placeholder:
								"例: 決まったこと、宿題、次回の予定の3つに分けて書く",
							max_length: 4000,
						}),
					},
				],
			},
		});
		expect(response).toEqual({
			type: InteractionResponseType.DeferredChannelMessageWithSource,
			data: { flags: MessageFlags.Ephemeral },
		});
		expect(edits(calls)).toEqual([{ content: ADDED }]);
		expect(
			await findSkillByName(env.DB, guildId, "meeting-notes"),
		).toMatchObject({
			...MEETING_NOTES,
			createdByName: "Alice",
			editedByName: null,
		});
	});

	it("名前は、全角の英数字を半角に、大文字を小文字に直してから確かめる", async () => {
		const guildId = newGuild();
		mockDiscord();

		await sendInteraction(
			submitWritten(guildId, "skills:register-modal", {
				...MEETING_NOTES,
				name: " Ｍｅｅｔｉｎｇ－Notes ",
			}),
		);

		expect(await findSkillByName(env.DB, guildId, "meeting-notes")).not.toBe(
			null,
		);
	});

	it("名前が規則に合わないときは、登録せずに、書いた内容をSKILL.mdにして添付する", async () => {
		const guildId = newGuild();
		const calls = mockDiscord();
		const written = { ...MEETING_NOTES, name: "議事録" };

		await sendInteraction(
			submitWritten(guildId, "skills:register-modal", written),
		);

		expect(edits(calls)).toEqual([withDraft(INVALID_NAME, written)]);
		expect(await findSkillByName(env.DB, guildId, "議事録")).toBe(null);
	});

	it("20個あれば、入力画面を開かずに上限を伝える。送ったときに上限なら、書いた内容を添付する", async () => {
		const guildId = newGuild();
		await seedFull(guildId);
		const calls = mockDiscord();

		const command = await sendInteraction(regskills(guildId));
		await sendInteraction(
			submitWritten(guildId, "skills:register-modal", MEETING_NOTES),
		);

		expect(command).toEqual({
			type: InteractionResponseType.ChannelMessageWithSource,
			data: { flags: MessageFlags.Ephemeral, content: LIMIT_REACHED },
		});
		expect(edits(calls)).toEqual([withDraft(LIMIT_REACHED, MEETING_NOTES)]);
	});

	it("同じ名前があれば、書いた内容を添付して、置き換えるかを確かめる。「置き換える」を押すと置き換える", async () => {
		const guildId = newGuild();
		const seeded = await seed(guildId);
		const calls = mockDiscord();
		const written = { ...MEETING_NOTES, body: "新しい本文" };

		await sendInteraction(
			submitWritten(guildId, "skills:register-modal", written),
		);
		const [question] = edits(calls);
		const replaced = await sendInteraction(
			pressButton(guildId, overwriteButtonId(question)),
		);

		expect(question).toEqual({
			...withDraft(
				"「meeting-notes」という名前のスキルは、すでにあります。書いた内容で置き換えますか?",
				written,
			),
			components: [overwriteRow(overwriteButtonId(question))],
		});
		expect(overwriteButtonId(question)).toMatch(/^skills:overwrite:\d+$/);
		expect(replaced).toEqual({
			type: InteractionResponseType.UpdateMessage,
			data: { content: SAVED, components: [], attachments: [] },
		});
		expect(await getSkill(env.DB, guildId, seeded.id)).toMatchObject({
			body: "新しい本文",
			createdByName: "bob",
			editedByName: "Alice",
		});
	});
});

describe("/regskills(SKILL.mdを添付)", () => {
	it("添付したSKILL.mdを読んで確かめ、登録してから、結果を書く", async () => {
		const guildId = newGuild();
		const calls = mockDiscord(FILE);

		const response = await sendInteraction(regskills(guildId, 100));

		expect(response).toEqual({
			type: InteractionResponseType.DeferredChannelMessageWithSource,
			data: { flags: MessageFlags.Ephemeral },
		});
		expect(calls.some((call) => call.url.href === CDN_URL)).toBe(true);
		expect(edits(calls)).toEqual([{ content: ADDED }]);
		expect(
			await findSkillByName(env.DB, guildId, "meeting-notes"),
		).toMatchObject({ ...MEETING_NOTES, createdByName: "Alice" });
	});

	it("読めないファイルや、本文が長すぎるファイルは、登録せずに理由を書く(添付は付けない)", async () => {
		const guildId = newGuild();
		const unreadable = mockDiscord("# 冒頭に名前と説明がない");
		await sendInteraction(regskills(guildId, 100));
		vi.restoreAllMocks();
		const tooLong = mockDiscord(
			FILE.replace("決まったこと", "あ".repeat(20_001)),
		);
		await sendInteraction(regskills(guildId, 100));

		expect(edits(unreadable)).toEqual([{ content: UNREADABLE_FILE }]);
		expect(edits(tooLong)).toEqual([
			{ content: "本文は2万文字までにしてください(いまは20,019文字)。" },
		]);
		expect(await findSkillByName(env.DB, guildId, "meeting-notes")).toBe(null);
	});

	it("大きすぎるファイルは、読まずに読めないと伝える", async () => {
		const calls = mockDiscord(FILE);

		await sendInteraction(regskills(newGuild(), 2 * 1024 * 1024));

		expect(calls.some((call) => call.url.href === CDN_URL)).toBe(false);
		expect(edits(calls)).toEqual([{ content: UNREADABLE_FILE }]);
	});

	it("20個あれば、上限を伝える", async () => {
		const guildId = newGuild();
		await seedFull(guildId);
		const calls = mockDiscord(FILE);

		await sendInteraction(regskills(guildId, 100));

		expect(edits(calls)).toEqual([{ content: LIMIT_REACHED }]);
	});

	it("同じ名前があれば、置き換えるかを確かめる。「置き換える」を押すと置き換える", async () => {
		const guildId = newGuild();
		const seeded = await seed(guildId, { ...MEETING_NOTES, body: "古い本文" });
		const calls = mockDiscord(FILE);

		await sendInteraction(regskills(guildId, 100));
		const [question] = edits(calls);
		const replaced = await sendInteraction(
			pressButton(guildId, overwriteButtonId(question)),
		);

		expect(question).toEqual({
			content:
				"「meeting-notes」という名前のスキルは、すでにあります。添付したSKILL.mdで置き換えますか?",
			components: [overwriteRow(overwriteButtonId(question))],
		});
		expect(replaced).toEqual({
			type: InteractionResponseType.UpdateMessage,
			data: { content: SAVED, components: [], attachments: [] },
		});
		expect(await getSkill(env.DB, guildId, seeded.id)).toMatchObject({
			...MEETING_NOTES,
			editedByName: "Alice",
		});
	});

	it("古い「置き換える」ボタンや、ほかの人の確かめているボタンは使えない", async () => {
		const guildId = newGuild();
		const seeded = await seed(guildId, { ...MEETING_NOTES, body: "古い本文" });
		const calls = mockDiscord(FILE);

		// 置き換えるかを確かめている間に、同じ人がもう一度登録しようとした
		await sendInteraction(regskills(guildId, 100));
		await sendInteraction(regskills(guildId, 100));
		const [first, second] = edits(calls);
		const stale = await sendInteraction(
			pressButton(guildId, overwriteButtonId(first)),
		);
		const byOther = await sendInteraction(
			pressButton(guildId, overwriteButtonId(second), BOB),
		);

		for (const response of [stale, byOther]) {
			expect(response).toEqual({
				type: InteractionResponseType.ChannelMessageWithSource,
				data: { flags: MessageFlags.Ephemeral, content: PENDING_GONE },
			});
		}
		expect((await getSkill(env.DB, guildId, seeded.id))?.body).toBe("古い本文");
	});

	it("確かめている間に、そのスキルが消されていたら、新しく足す", async () => {
		const guildId = newGuild();
		const seeded = await seed(guildId);
		const calls = mockDiscord(FILE);

		await sendInteraction(regskills(guildId, 100));
		await deleteSkill(env.DB, guildId, seeded.id);
		const [question] = edits(calls);
		const replaced = await sendInteraction(
			pressButton(guildId, overwriteButtonId(question)),
		);

		expect(replaced.data).toEqual({
			content: ADDED,
			components: [],
			attachments: [],
		});
		expect(await findSkillByName(env.DB, guildId, "meeting-notes")).not.toBe(
			null,
		);
	});

	it("保存に失敗したら、保存できなかったと伝える", async () => {
		const calls = mockDiscord(FILE);
		const brokenDb = {
			prepare: () => {
				throw new Error("D1 is down");
			},
		} as unknown as D1Database;

		await sendInteraction(regskills(newGuild(), 100), {
			...env,
			DB: brokenDb,
		});

		expect(edits(calls)).toEqual([{ content: SAVE_FAILED }]);
	});
});

describe("スキルの画面", () => {
	it("選ぶと、説明と、登録した人と最後に編集した人を書き、SKILL.mdを添付して見せる", async () => {
		const guildId = newGuild();
		// 日付は日本時間で書く(UTCの15時は、日本時間の翌日0時)
		const seeded = await seed(
			guildId,
			MEETING_NOTES,
			Date.parse("2026-10-27T15:00:00Z"),
		);
		await updateSkill(
			env.DB,
			guildId,
			{ id: seeded.id, expectedUpdatedAt: seeded.updatedAt },
			MEETING_NOTES,
			{ id: ALICE.id, name: "alice" },
			Date.parse("2026-10-29T03:00:00Z"),
		);
		const calls = mockDiscord();

		const response = await sendInteraction(
			selectSkill(guildId, String(seeded.id)),
		);

		expect(response).toEqual({
			type: InteractionResponseType.DeferredChannelMessageWithSource,
			data: { flags: MessageFlags.Ephemeral },
		});
		expect(edits(calls)).toEqual([
			{
				content: [
					"**meeting-notes**",
					MEETING_NOTES.description,
					"-# 登録: bob(2026-10-28)・最後の編集: alice(2026-10-29)",
				].join("\n"),
				components: [
					{
						type: ComponentType.ActionRow,
						components: [
							{
								type: ComponentType.Button,
								style: ButtonStyle.Primary,
								custom_id: `skills:edit:${seeded.id}`,
								label: "編集",
							},
							{
								type: ComponentType.Button,
								style: ButtonStyle.Secondary,
								custom_id: `skills:replace:${seeded.id}`,
								label: "ファイルで置き換え",
							},
							{
								type: ComponentType.Button,
								style: ButtonStyle.Danger,
								custom_id: `skills:delete:${seeded.id}`,
								label: "削除",
							},
						],
					},
				],
				attachments: [{ id: 0, filename: "SKILL.md" }],
				files: [{ name: "SKILL.md", content: formatSkillFile(MEETING_NOTES) }],
			},
		]);
	});

	it("編集されていなければ、登録した人だけを書く", async () => {
		const guildId = newGuild();
		const seeded = await seed(guildId);
		const calls = mockDiscord();

		await sendInteraction(selectSkill(guildId, String(seeded.id)));

		const [edit] = edits(calls) as { content: string }[];
		expect(edit?.content.split("\n").at(-1)).toMatch(
			/^-# 登録: bob\(\d{4}-\d{2}-\d{2}\)$/,
		);
	});

	it("消されたスキルや、ほかのサーバーのスキルは、見つからないと伝える", async () => {
		const other = await seed(newGuild());
		const calls = mockDiscord();

		await sendInteraction(selectSkill(newGuild(), String(other.id)));

		expect(edits(calls)).toEqual([{ content: NOT_FOUND }]);
	});

	it("読み込みに失敗したら、読み込めなかったと伝える", async () => {
		const calls = mockDiscord();
		const brokenDb = {
			prepare: () => {
				throw new Error("D1 is down");
			},
		} as unknown as D1Database;

		await sendInteraction(selectSkill(newGuild(), "1"), {
			...env,
			DB: brokenDb,
		});

		expect(edits(calls)).toEqual([
			{
				content:
					"スキルを読み込めませんでした。少し待ってから、もう一度試してください。",
			},
		]);
	});
});

describe("編集", () => {
	it("今の内容を入れた入力画面を開き、送ると保存して、スキルの画面を結果に書き換える(添付も外す)", async () => {
		const guildId = newGuild();
		const seeded = await seed(guildId);
		const calls = mockDiscord();

		const modal = await sendInteraction(
			pressButton(guildId, `skills:edit:${seeded.id}`),
		);
		const edited = { ...MEETING_NOTES, name: "minutes", body: "新しい本文" };
		const response = await sendInteraction(
			submitWritten(guildId, modal.data.custom_id, edited),
		);

		expect(modal.data.custom_id).toBe(
			`skills:edit-modal:${seeded.id}:${seeded.updatedAt}`,
		);
		expect(modal.data.title).toBe("スキルを編集する");
		expect(
			modal.data.components.map(
				(label: { component: { value: string } }) => label.component.value,
			),
		).toEqual([
			MEETING_NOTES.name,
			MEETING_NOTES.description,
			MEETING_NOTES.body,
		]);
		expect(response).toEqual({
			type: InteractionResponseType.DeferredMessageUpdate,
		});
		expect(edits(calls)).toEqual([
			{
				content: "スキル「minutes」を保存しました。次の返答から使います。",
				components: [],
				attachments: [],
			},
		]);
		expect(await getSkill(env.DB, guildId, seeded.id)).toMatchObject({
			...edited,
			createdByName: "bob",
			editedByName: "Alice",
		});
	});

	it("本文が4000文字を超えるスキルは、入力画面では編集できないと伝える", async () => {
		const guildId = newGuild();
		const seeded = await seed(guildId, {
			...MEETING_NOTES,
			body: "あ".repeat(4001),
		});

		const response = await sendInteraction(
			pressButton(guildId, `skills:edit:${seeded.id}`),
		);

		expect(response.data).toEqual({
			flags: MessageFlags.Ephemeral,
			content:
				"本文が4000文字を超えているので、入力画面では編集できません。スキルの画面に添付したSKILL.mdを直して、「ファイルで置き換え」から登録してください。",
		});
	});

	it("編集の画面を開いている間に、ほかの人が変えていたら、保存せずに、送った内容を添付して知らせる", async () => {
		const guildId = newGuild();
		const seeded = await seed(guildId);
		const modal = await sendInteraction(
			pressButton(guildId, `skills:edit:${seeded.id}`),
		);
		await updateSkill(
			env.DB,
			guildId,
			{ id: seeded.id, expectedUpdatedAt: seeded.updatedAt },
			{ ...MEETING_NOTES, body: "ほかの人の本文" },
			{ id: BOB.id, name: "bob" },
		);
		const calls = mockDiscord();

		const mine = { ...MEETING_NOTES, body: "わたしの本文" };
		await sendInteraction(submitWritten(guildId, modal.data.custom_id, mine));

		expect(edits(calls)).toEqual([]);
		expect(followups(calls)).toEqual([
			{
				content: CONFLICT,
				flags: MessageFlags.Ephemeral,
				attachments: [{ id: 0, filename: "SKILL.md" }],
				files: [{ name: "SKILL.md", content: formatSkillFile(mine) }],
			},
		]);
		expect((await getSkill(env.DB, guildId, seeded.id))?.body).toBe(
			"ほかの人の本文",
		);
	});

	it("新しい名前のスキルがほかにあれば、保存しない", async () => {
		const guildId = newGuild();
		await seed(guildId, { ...MEETING_NOTES, name: "minutes" });
		const seeded = await seed(guildId);
		const calls = mockDiscord();

		await sendInteraction(
			submitWritten(
				guildId,
				`skills:edit-modal:${seeded.id}:${seeded.updatedAt}`,
				{ ...MEETING_NOTES, name: "minutes" },
			),
		);

		expect(followups(calls)).toEqual([
			{
				content:
					"「minutes」という名前のスキルは、すでにあります。別の名前にするか、一覧から選んで編集してください。",
				flags: MessageFlags.Ephemeral,
			},
		]);
	});
});

describe("ファイルで置き換え", () => {
	it("開いたときの更新日時を付けた入力画面を開き、添付したSKILL.mdで置き換える(名前も変わる)", async () => {
		const guildId = newGuild();
		const seeded = await seed(guildId);
		const file = formatSkillFile({
			name: "minutes",
			description: "議事録: 新しい説明",
			body: "新しい本文",
		});
		const calls = mockDiscord(file);

		const modal = await sendInteraction(
			pressButton(guildId, `skills:replace:${seeded.id}`),
		);
		await sendInteraction(submitFile(guildId, modal.data.custom_id));

		expect(modal.data).toEqual({
			custom_id: `skills:replace-modal:${seeded.id}:${seeded.updatedAt}`,
			title: "スキルをファイルで置き換える",
			components: [
				{
					type: ComponentType.Label,
					label: "SKILL.md",
					description:
						"冒頭に名前(name)と説明(description)を書いたファイル。本文は2万文字まで",
					component: {
						type: ComponentType.FileUpload,
						custom_id: "file",
						min_values: 1,
						max_values: 1,
						required: true,
					},
				},
			],
		});
		expect(edits(calls)).toEqual([
			{
				content: "スキル「minutes」を保存しました。次の返答から使います。",
				components: [],
				attachments: [],
			},
		]);
		expect(await getSkill(env.DB, guildId, seeded.id)).toMatchObject({
			name: "minutes",
			description: "議事録: 新しい説明",
			body: "新しい本文",
		});
	});

	it("読めないファイルは、置き換えずに理由を本人にだけ見せる(画面はそのまま)", async () => {
		const guildId = newGuild();
		const seeded = await seed(guildId);
		const calls = mockDiscord("# 冒頭に名前と説明がない");

		await sendInteraction(
			submitFile(
				guildId,
				`skills:replace-modal:${seeded.id}:${seeded.updatedAt}`,
			),
		);

		expect(edits(calls)).toEqual([]);
		expect(followups(calls)).toEqual([
			{ content: UNREADABLE_FILE, flags: MessageFlags.Ephemeral },
		]);
	});
});

describe("削除", () => {
	it("確かめてから消す。消した後に押しても、見つからないと伝える", async () => {
		const guildId = newGuild();
		const seeded = await seed(guildId);

		const question = await sendInteraction(
			pressButton(guildId, `skills:delete:${seeded.id}`),
		);
		const deleted = await sendInteraction(
			pressButton(guildId, `skills:delete-confirm:${seeded.id}`),
		);
		const again = await sendInteraction(
			pressButton(guildId, `skills:delete-confirm:${seeded.id}`),
		);

		expect(question).toEqual({
			type: InteractionResponseType.ChannelMessageWithSource,
			data: {
				flags: MessageFlags.Ephemeral,
				content:
					"スキル「meeting-notes」を削除します。このサーバーの全員の返答で、使われなくなります。よろしいですか?",
				components: [
					{
						type: ComponentType.ActionRow,
						components: [
							{
								type: ComponentType.Button,
								style: ButtonStyle.Danger,
								custom_id: `skills:delete-confirm:${seeded.id}`,
								label: "削除する",
							},
						],
					},
				],
			},
		});
		expect(deleted).toEqual({
			type: InteractionResponseType.UpdateMessage,
			data: {
				content: "スキル「meeting-notes」を削除しました。",
				components: [],
			},
		});
		expect(await getSkill(env.DB, guildId, seeded.id)).toBe(null);
		expect(again.data.content).toBe(NOT_FOUND);
	});
});

describe("/regskills(プラグインから入れる)", () => {
	const ARCHIVE_URL =
		"https://codeload.github.com/4rtoflow/Nakamaba/tar.gz/HEAD";
	const COMMIT_URL = `https://codeload.github.com/4rtoflow/Nakamaba/tar.gz/${COMMIT}`;
	const INSTALLED_AGENT =
		"プラグイン「nakamaba」から、スキル「nakamaba」を追加しました。ファイルが付いているので、エージェント(`/agent`)だけで使います。";
	const SAVED_AGENT =
		"プラグイン「nakamaba」から、スキル「nakamaba」を保存しました。ファイルが付いているので、エージェント(`/agent`)だけで使います。";
	const GITHUB_FAILED =
		"GitHubとのやり取りでエラーが起きました。少し待ってから、もう一度試してください。";

	/** /regskills の欄(pluginとmarketplace。fileSizeを渡すと、その大きさのSKILL.mdも添付する) */
	function regskillsWith(
		guildId: string,
		fields: { plugin?: string; marketplace?: string; fileSize?: number },
		user?: APIUser,
	) {
		return inGuild(
			guildId,
			InteractionType.ApplicationCommand,
			{
				id: "2",
				name: "regskills",
				type: 1,
				options: [
					...(fields.fileSize === undefined
						? []
						: [{ name: "file", type: 11, value: "700" }]),
					...(fields.plugin === undefined
						? []
						: [{ name: "plugin", type: 3, value: fields.plugin }]),
					...(fields.marketplace === undefined
						? []
						: [{ name: "marketplace", type: 3, value: fields.marketplace }]),
				],
				...(fields.fileSize === undefined
					? {}
					: {
							resolved: { attachments: { "700": attachment(fields.fileSize) } },
						}),
			},
			user,
		);
	}

	function installNakamaba(guildId: string, user?: APIUser) {
		return regskillsWith(
			guildId,
			{ plugin: "nakamaba", marketplace: "4rtoflow/Nakamaba" },
			user,
		);
	}

	/** DiscordのAPIとGitHub(codeload)の偽物。GitHubは、URLごとにtar.gzを返す(なければ404) */
	function mockGitHub(archives: Record<string, Uint8Array | Response>) {
		return mockFetch((call) => {
			if (call.url.hostname !== "codeload.github.com") {
				return Response.json({});
			}
			const archive = archives[call.url.toString()];
			if (archive === undefined) {
				return new Response("Not Found", { status: 404 });
			}
			return archive instanceof Response ? archive : new Response(archive);
		});
	}

	function githubCalls(calls: FetchCall[]): string[] {
		return calls
			.filter((call) => call.url.hostname === "codeload.github.com")
			.map((call) => call.url.toString());
	}

	/** スキルが1つだけの、プラグインの一覧のリポジトリ */
	async function singleSkill(
		skillFile: string,
		extra: Record<string, string | Uint8Array> = {},
	) {
		return tarGz({
			".claude-plugin/marketplace.json": marketplaceJson(),
			"plugins/nakamaba/skills/nakamaba/SKILL.md": skillFile,
			...extra,
		});
	}

	it("GitHubからプラグインのスキルを読み、入手元とファイルと一緒に登録してから、結果を書く", async () => {
		const guildId = newGuild();
		const calls = mockGitHub({ [ARCHIVE_URL]: await tarGz(nakamabaFiles()) });

		const response = await sendInteraction(installNakamaba(guildId));

		expect(response).toEqual({
			type: InteractionResponseType.DeferredChannelMessageWithSource,
			data: { flags: MessageFlags.Ephemeral },
		});
		expect(githubCalls(calls)).toEqual([ARCHIVE_URL]);
		expect(edits(calls)).toEqual([{ content: INSTALLED_AGENT }]);
		const skill = await findSkillByName(env.DB, guildId, "nakamaba");
		expect(skill).toMatchObject({
			name: "nakamaba",
			description: "Nakamabaに載せるページを作り、公開・更新する。",
			createdByName: "Alice",
			fileCount: 1,
			source: {
				repository: "4rtoflow/Nakamaba",
				plugin: "nakamaba",
				commit: COMMIT,
			},
		});
		expect(await listSkillFiles(env.DB, guildId, skill?.id ?? 0)).toEqual([
			{
				path: "scripts/nakamaba.mjs",
				content: new TextEncoder().encode("console.log('nakamaba');\n"),
			},
		]);
	});

	it("リポジトリはURLでも指定できる。ファイルのないスキルは、次の返答から使うと書く", async () => {
		const guildId = newGuild();
		const calls = mockGitHub({
			[ARCHIVE_URL]: await singleSkill(
				["---", "name: nakamaba", "description: 説明", "---", "本文"].join(
					"\n",
				),
			),
		});

		await sendInteraction(
			regskillsWith(guildId, {
				plugin: "nakamaba",
				marketplace: "https://github.com/4rtoflow/Nakamaba",
			}),
		);

		expect(edits(calls)).toEqual([
			{
				content:
					"プラグイン「nakamaba」から、スキル「nakamaba」を追加しました。次の返答から使います。",
			},
		]);
		expect(await findSkillByName(env.DB, guildId, "nakamaba")).toMatchObject({
			fileCount: 0,
			source: { plugin: "nakamaba" },
		});
	});

	it("ファイルが付いたスキルと付いていないスキルがあれば、付いているスキルだけエージェントで使うと書く", async () => {
		const calls = mockGitHub({
			[ARCHIVE_URL]: await tarGz(
				nakamabaFiles({
					"plugins/nakamaba/skills/page-rules/SKILL.md": [
						"---",
						"name: page-rules",
						"description: ページの決まり",
						"---",
						"本文",
					].join("\n"),
				}),
			),
		});

		await sendInteraction(installNakamaba(newGuild()));

		expect(edits(calls)).toEqual([
			{
				content:
					"プラグイン「nakamaba」から、スキル「nakamaba」「page-rules」を追加しました。次の返答から使います。ファイルが付いている「nakamaba」は、エージェント(`/agent`)だけで使います。",
			},
		]);
	});

	it("欄の組み合わせやリポジトリの形が違えば、GitHubを読まずに、本人にだけ理由を見せる", async () => {
		const guildId = newGuild();
		const calls = mockGitHub({});
		const cases: [Parameters<typeof regskillsWith>[1], string][] = [
			[
				{ plugin: "nakamaba" },
				"プラグインから入れるときは、pluginとmarketplaceの両方を指定してください。例: plugin `nakamaba`、marketplace `4rtoflow/Nakamaba`",
			],
			[
				{ marketplace: "4rtoflow/Nakamaba" },
				"プラグインから入れるときは、pluginとmarketplaceの両方を指定してください。例: plugin `nakamaba`、marketplace `4rtoflow/Nakamaba`",
			],
			[
				{ plugin: "nakamaba", marketplace: "4rtoflow/Nakamaba", fileSize: 100 },
				"SKILL.mdの添付と、プラグインからの登録は、別々に行ってください。",
			],
			[
				{ plugin: "nakamaba", marketplace: "Nakamaba" },
				"marketplaceは、GitHubのリポジトリを`持ち主/名前`の形で指定してください。例: `4rtoflow/Nakamaba`",
			],
		];

		for (const [fields, content] of cases) {
			expect(await sendInteraction(regskillsWith(guildId, fields))).toEqual({
				type: InteractionResponseType.ChannelMessageWithSource,
				data: { flags: MessageFlags.Ephemeral, content },
			});
		}
		expect(githubCalls(calls)).toEqual([]);
	});

	it("リポジトリやプラグインに問題があれば、登録せずに理由を書く", async () => {
		const skill = (frontMatter: string[], body = "本文") =>
			["---", ...frontMatter, "---", body].join("\n");
		const cases: [Uint8Array | Response | undefined, string][] = [
			[
				undefined,
				"GitHubのリポジトリ「4rtoflow/Nakamaba」を読めませんでした。公開されているか、名前が合っているかを確かめてください。",
			],
			[
				new Response("x", {
					headers: { "Content-Length": String(31 * 1024 * 1024) },
				}),
				"GitHubのリポジトリ「4rtoflow/Nakamaba」が大きすぎるため、読めませんでした(30MBまで)。",
			],
			[
				await tarGz({ "README.md": "x" }),
				"「4rtoflow/Nakamaba」の、プラグインの一覧(`.claude-plugin/marketplace.json`)がないか、読めませんでした。",
			],
			[
				await tarGz({
					".claude-plugin/marketplace.json": marketplaceJson([
						{ name: "other", source: "./other" },
						{ name: "more", source: "./more" },
					]),
				}),
				"「4rtoflow/Nakamaba」に、「nakamaba」という名前のプラグインはありません。入れられるプラグイン: `other`、`more`",
			],
			[
				await tarGz({
					".claude-plugin/marketplace.json": marketplaceJson([
						{
							name: "nakamaba",
							source: { source: "npm", package: "nakamaba" },
						},
					]),
				}),
				"プラグイン「nakamaba」は、GitHubのリポジトリ以外(npmなど)から配られているため、入れられません。",
			],
			[
				await tarGz({ ".claude-plugin/marketplace.json": marketplaceJson() }),
				"プラグイン「nakamaba」には、スキルがありません。",
			],
			[
				await singleSkill("# 冒頭に名前と説明がない"),
				"プラグインのスキル「nakamaba」を登録できませんでした。\nSKILL.mdを読めませんでした。",
			],
			[
				await singleSkill(skill(["name: Nakamaba_Tool", "description: 説明"])),
				"プラグインのスキル「nakamaba_tool」を登録できませんでした。\n名前は、英小文字、数字、ハイフンだけで、64文字までにしてください。例: `meeting-notes`",
			],
			[
				await singleSkill(
					skill(["name: nakamaba", `description: ${"あ".repeat(1025)}`]),
				),
				"プラグインのスキル「nakamaba」を登録できませんでした。\n説明(description)は1024文字までにしてください。",
			],
			[
				await singleSkill(NAKAMABA_SKILL, {
					"plugins/nakamaba/skills/nakamaba/big.bin": new Uint8Array(
						1024 * 1024 + 1,
					),
				}),
				"スキル「nakamaba」のファイルが多すぎるか、大きすぎます(1つのスキルで50個・合計5MB・1つ1MBまで)。",
			],
			[new Response("error", { status: 503 }), GITHUB_FAILED],
		];

		for (const [archive, content] of cases) {
			vi.restoreAllMocks();
			const guildId = newGuild();
			const calls = mockGitHub(
				archive === undefined ? {} : { [ARCHIVE_URL]: archive },
			);

			await sendInteraction(installNakamaba(guildId));

			expect(edits(calls)).toEqual([{ content }]);
			expect(await findSkillByName(env.DB, guildId, "nakamaba")).toBe(null);
		}
	});

	it("足すと20個を超えるなら、上限を伝える", async () => {
		const guildId = newGuild();
		await seedFull(guildId);
		const calls = mockGitHub({ [ARCHIVE_URL]: await tarGz(nakamabaFiles()) });

		await sendInteraction(installNakamaba(guildId));

		expect(edits(calls)).toEqual([
			{
				content:
					"スキルは20個までです。プラグイン「nakamaba」のスキル(1個)を足すと、上限を超えます。使っていないスキルを削除してから追加してください。",
			},
		]);
	});

	it("同じ名前があれば、置き換えるかを確かめる。「置き換える」を押すと、同じコミットを読み直して置き換える", async () => {
		const guildId = newGuild();
		const seeded = await seed(guildId, {
			...MEETING_NOTES,
			name: "nakamaba",
			body: "古い本文",
		});
		const archive = await tarGz(nakamabaFiles());
		const calls = mockGitHub({ [ARCHIVE_URL]: archive, [COMMIT_URL]: archive });

		await sendInteraction(installNakamaba(guildId));
		const [question] = edits(calls);
		const pressed = await sendInteraction(
			pressButton(guildId, overwriteButtonId(question)),
		);

		expect(question).toEqual({
			content:
				"「nakamaba」という名前のスキルは、すでにあります。プラグイン「nakamaba」(4rtoflow/Nakamaba)の内容で置き換えますか?",
			components: [overwriteRow(overwriteButtonId(question))],
		});
		expect(overwriteButtonId(question)).toMatch(
			/^skills:overwrite-plugin:\d+$/,
		);
		expect(pressed).toEqual({
			type: InteractionResponseType.DeferredMessageUpdate,
		});
		expect(githubCalls(calls)).toEqual([ARCHIVE_URL, COMMIT_URL]);
		expect(edits(calls).at(-1)).toEqual({
			content: SAVED_AGENT,
			components: [],
		});
		expect(await getSkill(env.DB, guildId, seeded.id)).toMatchObject({
			description: "Nakamabaに載せるページを作り、公開・更新する。",
			createdByName: "bob",
			editedByName: "Alice",
			fileCount: 1,
			source: { commit: COMMIT },
		});
	});

	it("古い「置き換える」ボタンや、ほかの人の確かめているボタンは使えない(画面はそのまま)", async () => {
		const guildId = newGuild();
		await seed(guildId, {
			...MEETING_NOTES,
			name: "nakamaba",
			body: "古い本文",
		});
		await seed(guildId);
		const archive = await tarGz(nakamabaFiles());
		const calls = mockGitHub({ [ARCHIVE_URL]: archive });

		await sendInteraction(installNakamaba(guildId));
		const [question] = edits(calls);
		// 同じ人が、SKILL.mdの添付で、別の置き換えを確かめ始めた(前の確かめは消える)
		vi.restoreAllMocks();
		const discord = mockDiscord(FILE);
		await sendInteraction(regskills(guildId, 100));
		await sendInteraction(pressButton(guildId, overwriteButtonId(question)));
		await sendInteraction(
			pressButton(guildId, overwriteButtonId(question), BOB),
		);

		expect(followups(discord)).toEqual([
			{ content: PENDING_GONE, flags: MessageFlags.Ephemeral },
			{ content: PENDING_GONE, flags: MessageFlags.Ephemeral },
		]);
		expect((await findSkillByName(env.DB, guildId, "nakamaba"))?.body).toBe(
			"古い本文",
		);
	});

	it("一覧では、ファイルが付いたスキルの名前の後ろに「(エージェント用)」を付ける", async () => {
		const guildId = newGuild();
		await seed(guildId);
		await installSkills(
			env.DB,
			guildId,
			[
				{
					content: {
						name: "nakamaba",
						description: "Nakamabaに載せるページを作る",
						body: "本文",
					},
					files: [{ path: "run.mjs", content: new Uint8Array([1]) }],
				},
			],
			{ repository: "4rtoflow/Nakamaba", plugin: "nakamaba", commit: COMMIT },
			{ id: BOB.id, name: "bob" },
			{ overwrite: false },
		);

		const response = await sendInteraction(skillsCommand(guildId));

		expect(response.data.content).toBe(
			[
				"**登録されたスキル**",
				`- \`meeting-notes\`: ${MEETING_NOTES.description}`,
				"- `nakamaba`(エージェント用): Nakamabaに載せるページを作る",
			].join("\n"),
		);
	});

	it("スキルの画面に、入手元(リポジトリ、プラグイン、コミット)と、付いているファイルの数を書く", async () => {
		const guildId = newGuild();
		const calls = mockGitHub({ [ARCHIVE_URL]: await tarGz(nakamabaFiles()) });
		await sendInteraction(installNakamaba(guildId));
		const skill = await findSkillByName(env.DB, guildId, "nakamaba");

		await sendInteraction(selectSkill(guildId, String(skill?.id)));

		const content = (edits(calls).at(-1) as { content: string }).content;
		expect(content.split("\n").slice(2)).toEqual([
			expect.stringMatching(/^-# 登録: Alice\(\d{4}-\d{2}-\d{2}\)$/),
			"-# 入手元: 4rtoflow/Nakamaba のプラグイン「nakamaba」(5e13cf2)・ファイル1個",
		]);
	});
});
