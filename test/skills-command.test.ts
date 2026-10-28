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
	findSkillByName,
	getSkill,
	MAX_SKILLS,
	type SkillContent,
	updateSkill,
} from "../src/store/skills";
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

/** /skills の画面の、スキルの説明 */
const EXPLANATION = [
	"スキルは、AIに教えておく手順や知識です。質問に関係するスキルがあると、AIがそれを読んで答えます。登録したスキルは、このサーバーの全員への返答で使われます。誰でも追加・編集・削除できます。",
	"-# スキルの名前と説明は毎回、本文は読んだときだけAIに渡します。その分、返答の費用が増えます。",
	"-# Claude Codeなどで使うSKILL.mdも、そのまま追加できます。参考資料とスクリプトは使えません。",
];

const ADD_BUTTONS = {
	type: ComponentType.ActionRow,
	components: [
		{
			type: ComponentType.Button,
			style: ButtonStyle.Primary,
			custom_id: "skills:add",
			label: "書いて追加",
		},
		{
			type: ComponentType.Button,
			style: ButtonStyle.Secondary,
			custom_id: "skills:upload",
			label: "ファイルで追加",
		},
	],
};

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

const MEETING_NOTES: SkillContent = {
	name: "meeting-notes",
	description: "会議の議事録を書く手順。議事録やまとめを頼まれたときに使う",
	body: "決まったこと、宿題、次回の予定の3つに分けて書く",
};

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

function skillsCommand(guildId: string) {
	return inGuild(guildId, InteractionType.ApplicationCommand, {
		id: "1",
		name: "skills",
		type: 1,
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

/** ファイルを添付する入力画面の送信。ファイルの中身は、CDN_URLから読む(mockDiscordで返す) */
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
		resolved: {
			attachments: {
				"700": {
					id: "700",
					filename: "SKILL.md",
					size,
					url: CDN_URL,
					proxy_url: CDN_URL,
				},
			},
		},
	});
}

const CDN_URL =
	"https://cdn.discordapp.com/ephemeral-attachments/1/700/SKILL.md";

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

describe("/skills", () => {
	it("コマンドの一覧と/helpに出る", () => {
		expect(COMMANDS).toContainEqual(
			expect.objectContaining({
				name: "skills",
				description: "このサーバーでAIが使うスキル(手順や知識)の一覧と登録",
			}),
		);
		expect(helpText()).toContain(
			"- `/skills` で登録したスキル(手順や知識)を、AIが必要に応じて読んで使います。",
		);
	});

	it("スキルがなければ「なし」と、スキルの説明と、追加のボタンを、本人にだけ見せる", async () => {
		const response = await sendInteraction(skillsCommand(newGuild()));

		expect(response).toEqual({
			type: InteractionResponseType.ChannelMessageWithSource,
			data: {
				flags: MessageFlags.Ephemeral,
				content: ["**このサーバーのスキル**: なし", "", ...EXPLANATION].join(
					"\n",
				),
				components: [ADD_BUTTONS],
			},
		});
	});

	it("一覧には、説明の先頭40文字と、最後に登録か編集をした人を、名前の順に書く。選ぶメニューも付ける", async () => {
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

		expect(response.data.content).toBe(
			[
				"**このサーバーのスキル**: 2個(20個まで)",
				"- `meeting-notes`(aliceが編集): 会議の議事録を書く手順。議事録やまとめを頼まれたときに使う",
				"- `trpg-rules`(bobが登録): このサーバーのTRPGのハウスルール。セッションの進め方と、判定の決まりをまとめ…",
				"",
				...EXPLANATION,
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
			ADD_BUTTONS,
		]);
	});
});

describe("書いて追加", () => {
	it("ボタンで入力画面を開き、送ると追加して、画面を結果に書き換える", async () => {
		const guildId = newGuild();

		const modal = await sendInteraction(pressButton(guildId, "skills:add"));
		const added = await sendInteraction(
			submitWritten(guildId, "skills:add-modal", MEETING_NOTES),
		);

		expect(modal).toEqual({
			type: InteractionResponseType.Modal,
			data: {
				custom_id: "skills:add-modal",
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
		expect(added).toEqual({
			type: InteractionResponseType.UpdateMessage,
			data: {
				content:
					"スキル「meeting-notes」を追加しました。次の返答から使います。",
				components: [],
			},
		});
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

		await sendInteraction(
			submitWritten(guildId, "skills:add-modal", {
				...MEETING_NOTES,
				name: " Ｍｅｅｔｉｎｇ－Notes ",
			}),
		);

		expect(await findSkillByName(env.DB, guildId, "meeting-notes")).not.toBe(
			null,
		);
	});

	it("名前が規則に合わないときや、同じ名前があるときは、追加せずに理由を本人にだけ見せる", async () => {
		const guildId = newGuild();
		await seed(guildId);

		const invalid = await sendInteraction(
			submitWritten(guildId, "skills:add-modal", {
				...MEETING_NOTES,
				name: "議事録",
			}),
		);
		const duplicate = await sendInteraction(
			submitWritten(guildId, "skills:add-modal", MEETING_NOTES),
		);

		expect(invalid).toEqual({
			type: InteractionResponseType.ChannelMessageWithSource,
			data: { flags: MessageFlags.Ephemeral, content: INVALID_NAME },
		});
		expect(duplicate.data.content).toBe(
			"「meeting-notes」という名前のスキルは、すでにあります。別の名前にするか、一覧から選んで編集してください。",
		);
	});

	it("20個あれば、ボタンを押したときも、送ったときも、上限を伝える", async () => {
		const guildId = newGuild();
		for (let index = 0; index < MAX_SKILLS; index++) {
			await seed(guildId, { ...MEETING_NOTES, name: `skill-${index}` });
		}

		const pressed = await sendInteraction(
			pressButton(guildId, "skills:upload"),
		);
		const submitted = await sendInteraction(
			submitWritten(guildId, "skills:add-modal", MEETING_NOTES),
		);

		expect(pressed.data).toEqual({
			flags: MessageFlags.Ephemeral,
			content: LIMIT_REACHED,
		});
		expect(submitted.data.content).toBe(LIMIT_REACHED);
	});
});

describe("ファイルで追加", () => {
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

	it("ボタンで、ファイルの欄がある入力画面を開く", async () => {
		const modal = await sendInteraction(
			pressButton(newGuild(), "skills:upload"),
		);

		expect(modal).toEqual({
			type: InteractionResponseType.Modal,
			data: {
				custom_id: "skills:upload-modal",
				title: "スキルをファイルで追加する",
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
			},
		});
	});

	it("添付されたSKILL.mdを読んで追加し、画面を結果に書き換える", async () => {
		const guildId = newGuild();
		const calls = mockDiscord(FILE);

		const response = await sendInteraction(
			submitFile(guildId, "skills:upload-modal"),
		);

		expect(response).toEqual({
			type: InteractionResponseType.DeferredMessageUpdate,
		});
		expect(calls.some((call) => call.url.href === CDN_URL)).toBe(true);
		expect(edits(calls)).toEqual([
			{
				content:
					"スキル「meeting-notes」を追加しました。次の返答から使います。",
				components: [],
			},
		]);
		expect(
			await findSkillByName(env.DB, guildId, "meeting-notes"),
		).toMatchObject(MEETING_NOTES);
	});

	it("読めないファイルや、本文が長すぎるファイルは、追加せずに理由を本人にだけ見せる(画面はそのまま)", async () => {
		const guildId = newGuild();
		const unreadable = mockDiscord("# 冒頭に名前と説明がない");
		await sendInteraction(submitFile(guildId, "skills:upload-modal"));
		vi.restoreAllMocks();
		const tooLong = mockDiscord(
			FILE.replace("決まったこと", "あ".repeat(20_001)),
		);
		await sendInteraction(submitFile(guildId, "skills:upload-modal"));

		expect(edits(unreadable)).toEqual([]);
		expect(followups(unreadable)).toEqual([
			{ content: UNREADABLE_FILE, flags: MessageFlags.Ephemeral },
		]);
		expect(followups(tooLong)).toEqual([
			{
				content: "本文は2万文字までにしてください(いまは20,019文字)。",
				flags: MessageFlags.Ephemeral,
			},
		]);
		expect(await findSkillByName(env.DB, guildId, "meeting-notes")).toBe(null);
	});

	it("大きすぎるファイルは、読まずに読めないと伝える", async () => {
		const calls = mockDiscord(FILE);

		await sendInteraction(
			submitFile(newGuild(), "skills:upload-modal", 2 * 1024 * 1024),
		);

		expect(calls.some((call) => call.url.href === CDN_URL)).toBe(false);
		expect(followups(calls)).toEqual([
			{ content: UNREADABLE_FILE, flags: MessageFlags.Ephemeral },
		]);
	});

	it("保存に失敗したら、保存できなかったと本人にだけ見せる", async () => {
		const calls = mockDiscord(FILE);
		const brokenDb = {
			prepare: () => {
				throw new Error("D1 is down");
			},
		} as unknown as D1Database;

		await sendInteraction(submitFile(newGuild(), "skills:upload-modal"), {
			...env,
			DB: brokenDb,
		});

		expect(followups(calls)).toEqual([
			{
				content:
					"スキルを保存できませんでした。少し待ってから、もう一度試してください。",
				flags: MessageFlags.Ephemeral,
			},
		]);
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

		expect(modal.data).toMatchObject({
			custom_id: `skills:replace-modal:${seeded.id}:${seeded.updatedAt}`,
			title: "スキルをファイルで置き換える",
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
