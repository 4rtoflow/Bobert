import type {
	APIActionRowComponent,
	APIChatInputApplicationCommandInteraction,
	APIComponentInMessageActionRow,
	APIInteractionResponse,
	APIMessageComponentInteraction,
} from "discord-api-types/v10";
import {
	ApplicationCommandOptionType,
	ButtonStyle,
	ComponentType,
	InteractionResponseType,
	MessageFlags,
} from "../discord/constants";
import { logEvent } from "../log";
import {
	loadPlugin,
	MAX_ARCHIVE_BYTES,
	MAX_SKILL_FILE_BYTES,
	MAX_SKILL_FILES,
	MAX_SKILL_FILES_BYTES,
	parseRepository,
	type RepositoryRef,
	repositoryName,
} from "../plugins/marketplace";
import { formatJstDate } from "../respond/time";
import {
	deletePlugin,
	getPlugin,
	installPlugin,
	listPlugins,
	MAX_PLUGINS,
	type Plugin,
	type PluginSummary,
	updatePlugin,
} from "../store/plugins";
import type { InstallingSkill, SkillEditor } from "../store/skills";
import {
	type DeferredResult,
	type MessageEdit,
	respondLater,
	updateOrReplyLater,
} from "./deferred";
import { normalizeSkillName, skillProblemOf } from "./skills";

/**
 * /plugins: エージェントで使うClaude Codeのプラグインの一覧・追加・更新・削除(#108。仕様: docs/spec/behavior.md「プラグイン」)。
 * plugin と marketplace を入れると、claude plugin install と同じ一覧(.claude-plugin/marketplace.json)から入れる。
 * 画面はすべて本人にだけ見せる
 */

export const PLUGINS_COMMAND_NAME = "plugins";
export const PLUGINS_COMMAND_DESCRIPTION =
	"エージェントで使うClaude Codeのプラグインの一覧・追加・更新・削除";
export const PLUGINS_PLUGIN_OPTION = "plugin";
export const PLUGINS_MARKETPLACE_OPTION = "marketplace";
export const PLUGINS_PLUGIN_OPTION_DESCRIPTION =
	"入れるプラグインの名前(例: code-review)";
export const PLUGINS_MARKETPLACE_OPTION_DESCRIPTION =
	"プラグインを配っているGitHubのリポジトリ(例: anthropics/claude-plugins-official)";
/** ボタンとセレクトメニューのIDの頭。続けて操作の種類と、プラグインのIDを「:」でつなぐ */
export const PLUGINS_ID_PREFIX = "plugins:";

const Action = {
	Select: "select",
	Update: "update",
	Delete: "delete",
	DeleteConfirm: "delete-confirm",
} as const;

const PANEL_HEADER = "**入れたプラグイン**";
const PLUGIN_NEEDS_BOTH =
	"プラグインから入れるときは、pluginとmarketplaceの両方を指定してください。例: plugin `code-review`、marketplace `anthropics/claude-plugins-official`";
const INVALID_MARKETPLACE =
	"marketplaceは、GitHubのリポジトリを`持ち主/名前`の形で指定してください。例: `anthropics/claude-plugins-official`";
const GITHUB_FAILED =
	"GitHubとのやり取りでエラーが起きました。少し待ってから、もう一度試してください。";
const LIMIT_REACHED = `プラグインは${MAX_PLUGINS}個までです。使っていないプラグインを削除してから追加してください。`;
/** 消されたプラグインを選んだとき(スキルの画面の文に合わせる) */
const NOT_FOUND =
	"このプラグインは見つかりません。ほかの人が削除した可能性があります。`/plugins` から開き直してください。";
const SAVE_FAILED =
	"プラグインを保存できませんでした。少し待ってから、もう一度試してください。";
const MESSAGE_LENGTH = 2000;
/** スキルの説明を、プラグインの画面に書く長さ */
const DESCRIPTION_PREVIEW = 80;

/** /plugins: 欄が入っていればプラグインを入れ、なければ一覧を出す */
export async function pluginsCommand(
	interaction: APIChatInputApplicationCommandInteraction,
	env: Env,
	ctx: ExecutionContext,
	guildId: string,
	editor: SkillEditor,
): Promise<APIInteractionResponse> {
	const plugin = stringOption(interaction, PLUGINS_PLUGIN_OPTION);
	const marketplace = stringOption(interaction, PLUGINS_MARKETPLACE_OPTION);
	if (plugin === undefined && marketplace === undefined) {
		return {
			type: InteractionResponseType.ChannelMessageWithSource,
			data: {
				flags: MessageFlags.Ephemeral,
				...panel(await listPlugins(env.DB, guildId)),
			},
		};
	}
	if (plugin === undefined || marketplace === undefined) {
		return ephemeral(PLUGIN_NEEDS_BOTH);
	}
	const repository = parseRepository(marketplace);
	if (repository === null) {
		return ephemeral(INVALID_MARKETPLACE);
	}
	// GitHubからリポジトリを読むので、保留にしてから結果を書く
	return respondLater(
		ctx,
		interaction,
		editor.id,
		"reply",
		() => install(env.DB, guildId, repository, plugin, editor),
		{ content: SAVE_FAILED },
	);
}

/** 一覧の画面のセレクトメニューと、プラグインの画面のボタン。知らない操作ならnull */
export async function pluginComponent(
	interaction: APIMessageComponentInteraction,
	env: Env,
	ctx: ExecutionContext,
	guildId: string,
	editor: SkillEditor,
): Promise<APIInteractionResponse | null> {
	const [action, target] = interaction.data.custom_id
		.slice(PLUGINS_ID_PREFIX.length)
		.split(":");
	switch (action) {
		case Action.Select: {
			if (interaction.data.component_type !== ComponentType.StringSelect) {
				return null;
			}
			const plugin = await getPlugin(
				env.DB,
				guildId,
				Number(interaction.data.values[0]),
			);
			return plugin === null
				? ephemeral(NOT_FOUND)
				: ephemeralWith(pluginScreen(plugin));
		}
		case Action.Update:
			// GitHubから読み直すので、保留にする。結果は、プラグインの画面に書き換える
			return updateOrReplyLater(
				ctx,
				interaction,
				editor.id,
				() => update(env.DB, guildId, Number(target), editor),
				{ content: SAVE_FAILED },
			);
		case Action.Delete: {
			const plugin = await getPlugin(env.DB, guildId, Number(target));
			if (plugin === null) {
				return ephemeral(NOT_FOUND);
			}
			return ephemeralWith({
				content: `プラグイン「${plugin.name}」を削除します。そのスキルは、エージェントで使われなくなります。よろしいですか?`,
				components: [
					buttonRow([
						{
							style: ButtonStyle.Danger,
							custom_id: idOf(Action.DeleteConfirm, plugin.id),
							label: "削除する",
						},
					]),
				],
			});
		}
		case Action.DeleteConfirm: {
			const name = await deletePlugin(env.DB, guildId, Number(target));
			if (name === null) {
				return updateWith({ content: NOT_FOUND, components: [] });
			}
			log("plugin_deleted", { userId: editor.id, guildId, plugin: name });
			return updateWith({
				content: `プラグイン「${name}」を削除しました。`,
				components: [],
			});
		}
	}
	return null;
}

/** プラグインを入れる。同じ名前のプラグインがあれば、更新を案内する */
async function install(
	db: D1Database,
	guildId: string,
	repository: RepositoryRef,
	plugin: string,
	editor: SkillEditor,
): Promise<MessageEdit> {
	const prepared = await prepare(repository, plugin);
	if ("problem" in prepared) {
		return { content: prepared.problem };
	}
	const result = await installPlugin(
		db,
		guildId,
		{
			name: plugin,
			repository: repositoryName(repository),
			commit: prepared.commit,
			skills: prepared.skills,
		},
		editor,
	);
	switch (result) {
		case "exists":
			return {
				content: `プラグイン「${plugin}」は、すでに入っています。新しい版にするときは、\`/plugins\` の一覧から選んで「更新」を押してください。`,
			};
		case "limit":
			return { content: LIMIT_REACHED };
		case "installed":
			log("plugin_installed", {
				userId: editor.id,
				guildId,
				plugin,
				repository: repositoryName(repository),
				commit: prepared.commit,
			});
			return {
				content: `プラグイン「${plugin}」を入れました。スキル${quoted(prepared.skills.map((skill) => skill.content.name))}は、エージェント(\`/agent\`)の、次に始めるセッションから使います。`,
			};
	}
}

/** プラグインを、一覧のリポジトリの最新の版に入れ直す。結果は、プラグインの画面に書き換える */
async function update(
	db: D1Database,
	guildId: string,
	id: number,
	editor: SkillEditor,
): Promise<DeferredResult> {
	const current = await getPlugin(db, guildId, id);
	const repository =
		current === null ? null : parseRepository(current.repository);
	if (current === null || repository === null) {
		return { reply: { content: NOT_FOUND } };
	}
	const prepared = await prepare(repository, current.name);
	if ("problem" in prepared) {
		return { reply: { content: prepared.problem } };
	}
	if (prepared.commit === current.commit) {
		return {
			reply: { content: `プラグイン「${current.name}」は、最新の版です。` },
		};
	}
	const updated = await updatePlugin(db, guildId, id, {
		repository: current.repository,
		commit: prepared.commit,
		skills: prepared.skills,
	});
	if (!updated) {
		return { reply: { content: NOT_FOUND } };
	}
	log("plugin_updated", {
		userId: editor.id,
		guildId,
		plugin: current.name,
		commit: prepared.commit,
	});
	return {
		update: {
			content: `プラグイン「${current.name}」を更新しました(${shortCommit(current.commit)} → ${shortCommit(prepared.commit)})。`,
			components: [],
		},
	};
}

/** GitHubからプラグインのスキルを読み、決まり(名前の規則、長さとファイルの上限)を確かめる */
async function prepare(
	repository: RepositoryRef,
	plugin: string,
): Promise<
	{ commit: string; skills: InstallingSkill[] } | { problem: string }
> {
	const name = repositoryName(repository);
	const load = await loadPlugin(repository, plugin);
	switch (load.status) {
		case "unreadable":
			return {
				problem: `GitHubのリポジトリ「${repositoryName(load.repository)}」を読めませんでした。公開されているか、名前が合っているかを確かめてください。`,
			};
		case "too-large":
			return {
				problem: `GitHubのリポジトリ「${repositoryName(load.repository)}」が大きすぎるため、読めませんでした(${MAX_ARCHIVE_BYTES / (1024 * 1024)}MBまで)。`,
			};
		case "no-marketplace":
			return {
				problem: `「${name}」の、プラグインの一覧(\`.claude-plugin/marketplace.json\`)がないか、読めませんでした。`,
			};
		case "plugin-not-found":
			return { problem: pluginNotFound(name, plugin, load.available) };
		case "unsupported-source":
			return {
				problem: `プラグイン「${plugin}」は、GitHubのリポジトリ以外(npmなど)から配られているため、入れられません。`,
			};
		case "no-skills":
			return { problem: `プラグイン「${plugin}」には、スキルがありません。` };
		case "github-error":
			return { problem: GITHUB_FAILED };
	}
	const skills: InstallingSkill[] = [];
	for (const skill of load.skills) {
		if (skill.file === null) {
			return {
				problem: `プラグイン「${plugin}」のスキル「${skill.directory}」を登録できませんでした。\nSKILL.mdを読めませんでした。`,
			};
		}
		const content = {
			...skill.file,
			name: normalizeSkillName(skill.file.name),
		};
		const problem = skillProblemOf(content);
		if (problem !== null) {
			return {
				problem: `プラグイン「${plugin}」のスキル「${content.name}」を登録できませんでした。\n${problem}`,
			};
		}
		if (skill.tooManyFiles) {
			return {
				problem: `スキル「${content.name}」のファイルが多すぎるか、大きすぎます(1つのスキルで${MAX_SKILL_FILES}個・合計${MAX_SKILL_FILES_BYTES / (1024 * 1024)}MB・1つ${MAX_SKILL_FILE_BYTES / (1024 * 1024)}MBまで)。`,
			};
		}
		// 同じ名前のスキルが2つあるプラグインは、先のフォルダのものを使う
		if (!skills.some((added) => added.content.name === content.name)) {
			skills.push({ content, files: skill.files });
		}
	}
	return { commit: load.commit, skills };
}

/** 一覧の画面。プラグインがあれば、選ぶメニューを付ける */
function panel(plugins: readonly PluginSummary[]): Screen {
	if (plugins.length === 0) {
		return { content: `${PANEL_HEADER}: なし`, components: [] };
	}
	return {
		content: [
			PANEL_HEADER,
			...plugins.map(
				(plugin) =>
					`- \`${plugin.name}\`(${plugin.repository}): スキル${plugin.skillCount}個`,
			),
		].join("\n"),
		components: [
			{
				type: ComponentType.ActionRow,
				components: [
					{
						type: ComponentType.StringSelect,
						custom_id: idOf(Action.Select),
						placeholder: "プラグインを選んで、更新・削除する",
						options: plugins.map((plugin) => ({
							label: plugin.name.slice(0, 100),
							value: String(plugin.id),
							description: plugin.repository.slice(0, 100),
						})),
					},
				],
			},
		],
	};
}

/** プラグインの画面。入手元、スキル、入れた人を書き、「更新」「削除」のボタンを付ける */
function pluginScreen(plugin: Plugin): Screen {
	const lines = [
		`**${plugin.name}**`,
		`入手元: ${plugin.repository}(${shortCommit(plugin.commit)})・スキル${plugin.skillCount}個・ファイル${plugin.fileCount}個`,
		...plugin.skills.map(
			(skill) =>
				`- \`${plugin.name}:${skill.name}\`: ${preview(skill.description, DESCRIPTION_PREVIEW)}`,
		),
		`-# 入れた人: ${plugin.installedByName}(${formatJstDate(plugin.installedAt)})`,
	];
	return {
		content: fitToMessage(lines),
		components: [
			buttonRow([
				{
					style: ButtonStyle.Primary,
					custom_id: idOf(Action.Update, plugin.id),
					label: "更新",
				},
				{
					style: ButtonStyle.Danger,
					custom_id: idOf(Action.Delete, plugin.id),
					label: "削除",
				},
			]),
		],
	};
}

/** 1通(2000文字)に収まるよう、スキルの行を後ろから省く(見出しと最後の行は残す) */
function fitToMessage(lines: string[]): string {
	const text = lines.join("\n");
	if (text.length <= MESSAGE_LENGTH) {
		return text;
	}
	const head = lines.slice(0, 2);
	const tail = lines.at(-1) ?? "";
	const middle = lines.slice(2, -1);
	while (
		middle.length > 0 &&
		[...head, ...middle, "…", tail].join("\n").length > MESSAGE_LENGTH
	) {
		middle.pop();
	}
	return [...head, ...middle, "…", tail].join("\n");
}

/** 一覧に、名前がpluginのプラグインがないときの文。入れられるプラグインの名前を、1通に収まるまで並べる */
function pluginNotFound(
	repository: string,
	plugin: string,
	available: readonly string[],
): string {
	const text = `「${repository}」に、「${plugin}」という名前のプラグインはありません。`;
	if (available.length === 0) {
		return text;
	}
	let list = "";
	for (const [index, name] of available.entries()) {
		const next = `${list}${index === 0 ? "" : "、"}\`${name}\``;
		if (`${text}入れられるプラグイン: ${next}、…`.length > MESSAGE_LENGTH) {
			list = `${list}、…`;
			break;
		}
		list = next;
	}
	return `${text}入れられるプラグイン: ${list}`;
}

function quoted(names: readonly string[]): string {
	return names.map((name) => `「${name}」`).join("");
}

function shortCommit(commit: string): string {
	return commit.slice(0, 7);
}

/** 先頭のlength文字。改行は空白にし、長ければ省いて「…」を付ける */
function preview(text: string, length: number): string {
	const characters = [...text.replace(/\s*\n\s*/g, " ")];
	return characters.length > length
		? `${characters.slice(0, length).join("")}…`
		: characters.join("");
}

/** /plugins の、文字を入れる欄の値。前後の空白を除き、空なら(入れていなければ)undefined */
function stringOption(
	interaction: APIChatInputApplicationCommandInteraction,
	name: string,
): string | undefined {
	const option = interaction.data.options?.find(
		(candidate) => candidate.name === name,
	);
	if (option?.type !== ApplicationCommandOptionType.String) {
		return undefined;
	}
	const value = option.value.normalize("NFKC").trim();
	return value === "" ? undefined : value;
}

function buttonRow(
	buttons: {
		style: typeof ButtonStyle.Primary | typeof ButtonStyle.Danger;
		custom_id: string;
		label: string;
	}[],
): APIActionRowComponent<APIComponentInMessageActionRow> {
	return {
		type: ComponentType.ActionRow,
		components: buttons.map((button) => ({
			type: ComponentType.Button,
			...button,
		})),
	};
}

function idOf(action: string, id?: number): string {
	return id === undefined
		? `${PLUGINS_ID_PREFIX}${action}`
		: `${PLUGINS_ID_PREFIX}${action}:${id}`;
}

function ephemeral(content: string): APIInteractionResponse {
	return ephemeralWith({ content });
}

/** 画面の中身(本文とボタン) */
interface Screen {
	content: string;
	components?: APIActionRowComponent<APIComponentInMessageActionRow>[];
}

function ephemeralWith(message: Screen): APIInteractionResponse {
	return {
		type: InteractionResponseType.ChannelMessageWithSource,
		data: { flags: MessageFlags.Ephemeral, ...message },
	};
}

function updateWith(message: Screen): APIInteractionResponse {
	return { type: InteractionResponseType.UpdateMessage, data: message };
}

function log(event: string, detail: Record<string, unknown>): void {
	logEvent("interactions", event, detail);
}
