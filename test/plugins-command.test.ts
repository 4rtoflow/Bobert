import { env } from "cloudflare:workers";
import type { APIUser } from "discord-api-types/v10";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listAgentSkills, readAgentSkill } from "../src/agent/agent-skills";
import {
	ButtonStyle,
	ComponentType,
	InteractionResponseType,
	InteractionType,
	MessageFlags,
} from "../src/discord/constants";
import { COMMANDS } from "../src/interactions/commands";
import {
	getPlugin,
	installPlugin,
	listPluginSkillFiles,
	listPlugins,
	MAX_PLUGINS,
} from "../src/store/plugins";
import { addSkill, listSkills } from "../src/store/skills";
import { COMMIT, marketplaceJson, tarGz } from "./archive-fixtures";
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

const MARKETPLACE = "anthropics/claude-plugins-official";
const ARCHIVE_URL = `https://codeload.github.com/${MARKETPLACE}/tar.gz/HEAD`;
const NEWER = "f".repeat(40);

let nextGuildId = 8100;
function newGuild(): string {
	return String(nextGuildId++);
}

function inGuild(
	guildId: string,
	type: number,
	data: unknown,
	user: APIUser = ALICE,
) {
	return { ...guildInteraction(type, data, user), guild_id: guildId };
}

function skillFile(name: string, description = `${name}の説明`): string {
	return [
		"---",
		`name: ${name}`,
		`description: ${description}`,
		"---",
		`${name}の本文`,
	].join("\n");
}

/** code-review プラグイン(スキル2つ。review にはファイルが1つ)を配る一覧のリポジトリ */
async function marketplaceRepo(
	commit = COMMIT,
	extra: Record<string, string> = {},
) {
	return tarGz(
		{
			".claude-plugin/marketplace.json": marketplaceJson([
				{ name: "code-review", source: "./plugins/code-review" },
				{ name: "commit-commands", source: "./plugins/commit-commands" },
			]),
			"plugins/code-review/skills/review/SKILL.md": skillFile("review"),
			"plugins/code-review/skills/review/scripts/check.sh": "echo check",
			"plugins/code-review/skills/summarize/SKILL.md": skillFile("summarize"),
			...extra,
		},
		{ root: "claude-plugins-official-HEAD", commit },
	);
}

function pluginsCommand(
	guildId: string,
	fields: { plugin?: string; marketplace?: string } = {},
) {
	return inGuild(guildId, InteractionType.ApplicationCommand, {
		id: "1",
		name: "plugins",
		type: 1,
		options: [
			...(fields.plugin === undefined
				? []
				: [{ name: "plugin", type: 3, value: fields.plugin }]),
			...(fields.marketplace === undefined
				? []
				: [{ name: "marketplace", type: 3, value: fields.marketplace }]),
		],
	});
}

function component(
	guildId: string,
	customId: string,
	values?: string[],
	user?: APIUser,
) {
	return inGuild(
		guildId,
		InteractionType.MessageComponent,
		values === undefined
			? { custom_id: customId, component_type: ComponentType.Button }
			: {
					custom_id: customId,
					component_type: ComponentType.StringSelect,
					values,
				},
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

/** 保留にした応答の書き換え(PATCH @original)の本文 */
function edits(calls: FetchCall[]) {
	return calls
		.filter(
			(call) =>
				call.method === "PATCH" &&
				call.url.pathname.endsWith("/interaction-token/messages/@original"),
		)
		.map((call) => call.body as { content?: string; components?: unknown[] });
}

/** 本人にだけ見える、新しいメッセージ */
function followups(calls: FetchCall[]) {
	return calls
		.filter(
			(call) =>
				call.method === "POST" &&
				call.url.pathname.endsWith("/interaction-token"),
		)
		.map((call) => call.body as { content?: string });
}

async function installCodeReview(guildId: string) {
	const calls = mockGitHub({ [ARCHIVE_URL]: await marketplaceRepo() });
	await sendInteraction(
		pluginsCommand(guildId, {
			plugin: "code-review",
			marketplace: MARKETPLACE,
		}),
	);
	const [plugin] = await listPlugins(env.DB, guildId);
	if (plugin === undefined) {
		throw new Error("plugin was not installed");
	}
	return { calls, plugin };
}

describe("/plugins のコマンド", () => {
	it("コマンドの一覧に出る", () => {
		expect(COMMANDS).toContainEqual(
			expect.objectContaining({
				name: "plugins",
				description:
					"エージェントで使うClaude Codeのプラグインの一覧・追加・更新・削除",
				options: [
					{
						type: 3,
						name: "plugin",
						description: "入れるプラグインの名前(例: code-review)",
						required: false,
						max_length: 100,
					},
					{
						type: 3,
						name: "marketplace",
						description:
							"プラグインを配っているGitHubのリポジトリ(例: anthropics/claude-plugins-official)",
						required: false,
						max_length: 200,
					},
				],
			}),
		);
	});
});

describe("/plugins で入れる", () => {
	it("一覧からプラグインを読み、スキルとファイルを入れて、結果を書く(/skills には出さない)", async () => {
		const guildId = newGuild();
		const { calls, plugin } = await installCodeReview(guildId);

		expect(edits(calls)).toEqual([
			{
				content:
					"プラグイン「code-review」を入れました。スキル「review」「summarize」は、エージェント(`/agent`)の、次に始めるセッションから使います。",
			},
		]);
		expect(plugin).toMatchObject({
			name: "code-review",
			repository: MARKETPLACE,
			commit: COMMIT,
			skillCount: 2,
			fileCount: 1,
			installedByName: "Alice",
		});
		expect(await listSkills(env.DB, guildId)).toEqual([]);
	});

	it("同じ名前のプラグインがあれば、入れずに「更新」を案内する", async () => {
		const guildId = newGuild();
		await installCodeReview(guildId);
		const calls = mockGitHub({ [ARCHIVE_URL]: await marketplaceRepo() });

		await sendInteraction(
			pluginsCommand(guildId, {
				plugin: "code-review",
				marketplace: MARKETPLACE,
			}),
		);

		expect(edits(calls)).toEqual([
			{
				content:
					"プラグイン「code-review」は、すでに入っています。新しい版にするときは、`/plugins` の一覧から選んで「更新」を押してください。",
			},
		]);
	});

	it("10個あれば、上限を伝える", async () => {
		const guildId = newGuild();
		for (let index = 0; index < MAX_PLUGINS; index++) {
			await installPlugin(
				env.DB,
				guildId,
				{
					name: `p-${index}`,
					repository: MARKETPLACE,
					commit: COMMIT,
					skills: [],
				},
				{ id: BOB.id, name: "bob" },
			);
		}
		const calls = mockGitHub({ [ARCHIVE_URL]: await marketplaceRepo() });

		await sendInteraction(
			pluginsCommand(guildId, {
				plugin: "code-review",
				marketplace: MARKETPLACE,
			}),
		);

		expect(edits(calls)).toEqual([
			{
				content:
					"プラグインは10個までです。使っていないプラグインを削除してから追加してください。",
			},
		]);
	});

	it("欄が片方だけ、リポジトリの形が違うときは、GitHubを読まずに理由を見せる", async () => {
		const calls = mockGitHub({});
		const cases: [Parameters<typeof pluginsCommand>[1], string][] = [
			[
				{ plugin: "code-review" },
				"プラグインから入れるときは、pluginとmarketplaceの両方を指定してください。例: plugin `code-review`、marketplace `anthropics/claude-plugins-official`",
			],
			[
				{ plugin: "code-review", marketplace: "claude-plugins-official" },
				"marketplaceは、GitHubのリポジトリを`持ち主/名前`の形で指定してください。例: `anthropics/claude-plugins-official`",
			],
		];
		for (const [fields, content] of cases) {
			expect(await sendInteraction(pluginsCommand(newGuild(), fields))).toEqual(
				{
					type: InteractionResponseType.ChannelMessageWithSource,
					data: { flags: MessageFlags.Ephemeral, content },
				},
			);
		}
		expect(
			calls.some((call) => call.url.hostname === "codeload.github.com"),
		).toBe(false);
	});

	it("プラグインがないとき、SKILL.mdに問題があるときは、理由を書く", async () => {
		const cases: [Uint8Array, string, string][] = [
			[
				await marketplaceRepo(),
				"other",
				"「anthropics/claude-plugins-official」に、「other」という名前のプラグインはありません。入れられるプラグイン: `code-review`、`commit-commands`",
			],
			[
				await marketplaceRepo(COMMIT, {
					"plugins/code-review/skills/review/SKILL.md": "名前と説明がない",
				}),
				"code-review",
				"プラグイン「code-review」のスキル「review」を登録できませんでした。\nSKILL.mdを読めませんでした。",
			],
		];
		for (const [archive, plugin, content] of cases) {
			vi.restoreAllMocks();
			const guildId = newGuild();
			const calls = mockGitHub({ [ARCHIVE_URL]: archive });

			await sendInteraction(
				pluginsCommand(guildId, { plugin, marketplace: MARKETPLACE }),
			);

			expect(edits(calls)).toEqual([{ content }]);
			expect(await listPlugins(env.DB, guildId)).toEqual([]);
		}
	});
});

describe("/plugins の画面", () => {
	it("なければ「入れたプラグイン: なし」とだけ見せる", async () => {
		expect(await sendInteraction(pluginsCommand(newGuild()))).toEqual({
			type: InteractionResponseType.ChannelMessageWithSource,
			data: {
				flags: MessageFlags.Ephemeral,
				content: "**入れたプラグイン**: なし",
				components: [],
			},
		});
	});

	it("一覧と選ぶメニューを出し、選ぶとプラグインの画面(入手元、スキル、入れた人、更新・削除)を見せる", async () => {
		const guildId = newGuild();
		const { plugin } = await installCodeReview(guildId);

		const list = await sendInteraction(pluginsCommand(guildId));
		const screen = await sendInteraction(
			component(guildId, "plugins:select", [String(plugin.id)]),
		);

		expect(list.data).toEqual({
			flags: MessageFlags.Ephemeral,
			content:
				"**入れたプラグイン**\n- `code-review`(anthropics/claude-plugins-official): スキル2個",
			components: [
				{
					type: ComponentType.ActionRow,
					components: [
						{
							type: ComponentType.StringSelect,
							custom_id: "plugins:select",
							placeholder: "プラグインを選んで、更新・削除する",
							options: [
								{
									label: "code-review",
									value: String(plugin.id),
									description: MARKETPLACE,
								},
							],
						},
					],
				},
			],
		});
		expect(screen.data.content).toMatch(
			new RegExp(
				[
					"^\\*\\*code-review\\*\\*",
					"入手元: anthropics/claude-plugins-official\\(5e13cf2\\)・スキル2個・ファイル1個",
					"- `code-review:review`: reviewの説明",
					"- `code-review:summarize`: summarizeの説明",
					"-# 入れた人: Alice\\(\\d{4}-\\d{2}-\\d{2}\\)$",
				].join("\\n"),
			),
		);
		expect(screen.data.components).toEqual([
			{
				type: ComponentType.ActionRow,
				components: [
					{
						type: ComponentType.Button,
						style: ButtonStyle.Primary,
						custom_id: `plugins:update:${plugin.id}`,
						label: "更新",
					},
					{
						type: ComponentType.Button,
						style: ButtonStyle.Danger,
						custom_id: `plugins:delete:${plugin.id}`,
						label: "削除",
					},
				],
			},
		]);
	});

	it("「更新」で最新の版を読み、新しければスキルとファイルを入れ替える。同じ版なら、最新だと伝える", async () => {
		const guildId = newGuild();
		const { plugin } = await installCodeReview(guildId);
		const same = mockGitHub({ [ARCHIVE_URL]: await marketplaceRepo() });
		await sendInteraction(component(guildId, `plugins:update:${plugin.id}`));
		expect(followups(same)).toEqual([
			{
				content: "プラグイン「code-review」は、最新の版です。",
				flags: MessageFlags.Ephemeral,
			},
		]);

		vi.restoreAllMocks();
		const newer = mockGitHub({
			[ARCHIVE_URL]: await marketplaceRepo(NEWER, {
				"plugins/code-review/skills/review/scripts/check.sh": "echo newer",
				"plugins/code-review/skills/fix/SKILL.md": skillFile("fix"),
			}),
		});
		const pressed = await sendInteraction(
			component(guildId, `plugins:update:${plugin.id}`),
		);

		expect(pressed.type).toBe(InteractionResponseType.DeferredMessageUpdate);
		expect(edits(newer)).toEqual([
			{
				content: "プラグイン「code-review」を更新しました(5e13cf2 → fffffff)。",
				components: [],
			},
		]);
		const updated = await getPlugin(env.DB, guildId, plugin.id);
		expect(updated).toMatchObject({ commit: NEWER, skillCount: 3 });
		const review = updated?.skills.find((skill) => skill.name === "review");
		expect(
			await listPluginSkillFiles(env.DB, guildId, review?.id ?? 0),
		).toEqual([
			{
				path: "scripts/check.sh",
				content: new TextEncoder().encode("echo newer"),
			},
		]);
	});

	it("「削除」で確かめてから、スキルとファイルごと消す", async () => {
		const guildId = newGuild();
		const { plugin } = await installCodeReview(guildId);

		const question = await sendInteraction(
			component(guildId, `plugins:delete:${plugin.id}`),
		);
		const deleted = await sendInteraction(
			component(guildId, `plugins:delete-confirm:${plugin.id}`),
		);

		expect(question.data).toEqual({
			flags: MessageFlags.Ephemeral,
			content:
				"プラグイン「code-review」を削除します。そのスキルは、エージェントで使われなくなります。よろしいですか?",
			components: [
				{
					type: ComponentType.ActionRow,
					components: [
						{
							type: ComponentType.Button,
							style: ButtonStyle.Danger,
							custom_id: `plugins:delete-confirm:${plugin.id}`,
							label: "削除する",
						},
					],
				},
			],
		});
		expect(deleted).toEqual({
			type: InteractionResponseType.UpdateMessage,
			data: {
				content: "プラグイン「code-review」を削除しました。",
				components: [],
			},
		});
		expect(await listPlugins(env.DB, guildId)).toEqual([]);
		const { results } = await env.DB.prepare(
			"SELECT COUNT(*) AS count FROM plugin_files WHERE plugin_skill_id NOT IN (SELECT id FROM plugin_skills)",
		).all<{
			count: number;
		}>();
		expect(results[0]?.count).toBe(0);
	});
});

describe("エージェントに渡す", () => {
	it("サーバーのスキルの後ろに、プラグインのスキルを「<プラグイン名>:<スキル名>」で並べ、その名前で読める", async () => {
		const guildId = newGuild();
		await addSkill(
			env.DB,
			guildId,
			{ name: "review", description: "サーバーの review", body: "本文" },
			{ id: BOB.id, name: "bob" },
		);
		await installCodeReview(guildId);

		expect(await listAgentSkills(env.DB, guildId)).toEqual([
			{ name: "review", description: "サーバーの review" },
			{ name: "code-review:review", description: "reviewの説明" },
			{ name: "code-review:summarize", description: "summarizeの説明" },
		]);
		expect(
			await readAgentSkill(env.DB, guildId, "code-review:review"),
		).toMatchObject({
			kind: "plugin",
			name: "code-review:review",
			body: "reviewの本文",
			fileCount: 1,
			mountDir: "plugins/code-review/skills/review",
		});
		expect(await readAgentSkill(env.DB, guildId, "review")).toMatchObject({
			kind: "server",
			body: "本文",
			mountDir: "skills/review",
		});
		expect(await readAgentSkill(env.DB, guildId, "code-review:missing")).toBe(
			null,
		);
	});
});
