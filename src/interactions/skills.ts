import type {
	APIActionRowComponent,
	APIAttachment,
	APIChatInputApplicationCommandInteraction,
	APIComponentInMessageActionRow,
	APIInteractionResponse,
	APIMessageComponentInteraction,
	APIModalSubmitInteraction,
} from "discord-api-types/v10";
import type { MessageFile } from "../discord/api";
import {
	ApplicationCommandOptionType,
	ButtonStyle,
	ComponentType,
	InteractionResponseType,
	MessageFlags,
	TextInputStyle,
} from "../discord/constants";
import { logEvent } from "../log";
import { formatJstDate } from "../respond/time";
import {
	addSkill,
	countCharacters,
	countSkills,
	deletePendingSkill,
	deleteSkill,
	findSkillByName,
	getPendingSkill,
	getSkill,
	isValidSkillName,
	listSkills,
	MAX_BODY_LENGTH,
	MAX_DESCRIPTION_LENGTH,
	MAX_SKILL_NAME_LENGTH,
	MAX_SKILLS,
	overwriteSkill,
	type Skill,
	type SkillContent,
	type SkillEditor,
	type SkillSummary,
	savePendingSkill,
	updateSkill,
} from "../store/skills";
import {
	type DeferredResult,
	type MessageEdit,
	respondLater,
	updateOrReplyLater,
} from "./deferred";
import { readFileUpload, readTextInput } from "./input";
import { cleanSkillBody, formatSkillFile, parseSkillFile } from "./skill-file";

/** /skills のコマンドの名前 */
export const SKILLS_COMMAND_NAME = "skills";

/** /regskills のコマンドの名前と、SKILL.mdを添付する欄の名前 */
export const REGSKILLS_COMMAND_NAME = "regskills";
export const REGSKILLS_FILE_OPTION = "file";

/**
 * /skills と /regskills の、ボタン、セレクトメニュー、モーダルのIDの頭。
 * 続けて操作の種類と、対象のスキルのIDなどを「:」でつなぐ(例: skills:edit:12)
 */
export const SKILLS_ID_PREFIX = "skills:";

/** 操作の種類 */
const Action = {
	Select: "select",
	Edit: "edit",
	Replace: "replace",
	Delete: "delete",
	DeleteConfirm: "delete-confirm",
	Overwrite: "overwrite",
	RegisterModal: "register-modal",
	EditModal: "edit-modal",
	ReplaceModal: "replace-modal",
} as const;

const NAME_INPUT_ID = "name";
const DESCRIPTION_INPUT_ID = "description";
const BODY_INPUT_ID = "body";
const FILE_INPUT_ID = "file";

/** 入力画面で書ける本文の長さ(Discordの入力欄の上限) */
const MAX_MODAL_BODY_LENGTH = 4000;
/**
 * 一覧に書く説明の長さ。全文を書き、1通に収まらなければ、順に短くする(0は説明を書かない)
 */
const LIST_PREVIEW_LENGTHS = [Number.POSITIVE_INFINITY, 100, 40, 20, 0];
/** セレクトメニューの選択肢の説明の長さ(Discordの上限) */
const OPTION_DESCRIPTION_LENGTH = 100;
/** Discordの1メッセージの長さの上限 */
const MESSAGE_LENGTH = 2000;
/** 読むファイルの大きさの上限。本文の上限(2万文字)を、どんな文字でも超える大きさにする */
const MAX_FILE_BYTES = 1024 * 1024;
const SKILL_FILE_NAME = "SKILL.md";

/** /skills の画面の見出し */
const PANEL_HEADER = "**登録されたスキル**";

const INVALID_NAME =
	"名前は、英小文字、数字、ハイフンだけで、64文字までにしてください。例: `meeting-notes`";
const LIMIT_REACHED = `スキルは${MAX_SKILLS}個までです。使っていないスキルを削除してから追加してください。`;
const UNREADABLE_FILE = [
	"SKILL.mdを読めませんでした。冒頭に、次の形で名前と説明を書いたテキストのファイルを添付してください。",
	"```",
	"---",
	"name: meeting-notes",
	"description: 会議の議事録を書く手順。議事録を頼まれたときに使う",
	"---",
	"```",
].join("\n");
const DESCRIPTION_TOO_LONG = `説明(description)は${MAX_DESCRIPTION_LENGTH}文字までにしてください。`;
const TOO_LONG_FOR_MODAL =
	"本文が4000文字を超えているので、入力画面では編集できません。スキルの画面に添付したSKILL.mdを直して、「ファイルで置き換え」から登録してください。";
const CONFLICT =
	"編集の画面を開いている間に、ほかの人がこのスキルを変更したか削除したため、保存しませんでした。送った内容を添付します。`/skills` から開き直して、もう一度試してください。";
const NOT_FOUND =
	"このスキルは見つかりません。ほかの人が削除したか、名前を変えた可能性があります。`/skills` から開き直してください。";
const LOAD_FAILED =
	"スキルを読み込めませんでした。少し待ってから、もう一度試してください。";
const SAVE_FAILED =
	"スキルを保存できませんでした。少し待ってから、もう一度試してください。";
/** 入力画面で書いた内容を登録できないときに、書き添える文。書いた内容は、SKILL.mdにして添付する */
const DRAFT_ATTACHED =
	"書いた内容を添付します。直してから `/regskills` に添付すると、登録できます。";
const PENDING_GONE =
	"この置き換えは、もう使えません。もう一度 `/regskills` から登録してください。";

/**
 * /regskills: スキルを登録する(仕様: docs/spec/behavior.md「スキル」)。
 * SKILL.mdが添付されていれば、確かめて登録する(ファイルを読むので、保留にしてから結果を書く)。
 * 添付されていなければ、名前・説明・本文を書く入力画面を開く
 */
export async function regskillsCommand(
	interaction: APIChatInputApplicationCommandInteraction,
	env: Env,
	ctx: ExecutionContext,
	guildId: string,
	editor: SkillEditor,
): Promise<APIInteractionResponse> {
	const attachment = attachedFile(interaction);
	if (attachment === undefined) {
		if ((await countSkills(env.DB, guildId)) >= MAX_SKILLS) {
			return ephemeral(LIMIT_REACHED);
		}
		return writeModal(idOf(Action.RegisterModal), "スキルを追加する", null);
	}
	return respondLater(
		ctx,
		interaction,
		editor.id,
		"reply",
		async () => {
			const content = await readSkillFile(attachment);
			return typeof content === "string"
				? { content }
				: register(env.DB, guildId, content, editor, "file");
		},
		{ content: SAVE_FAILED },
	);
}

/**
 * /skills: このサーバーのスキルの一覧と、スキルを選ぶメニューを、本人にだけ見せる
 * (仕様: docs/spec/behavior.md「スキル」)
 */
export async function skillsCommand(
	env: Env,
	guildId: string,
): Promise<APIInteractionResponse> {
	return {
		type: InteractionResponseType.ChannelMessageWithSource,
		data: {
			flags: MessageFlags.Ephemeral,
			...(await panel(env.DB, guildId)),
		},
	};
}

/** /skills の画面のボタンとセレクトメニュー。知らない操作ならnull */
export async function skillComponent(
	interaction: APIMessageComponentInteraction,
	env: Env,
	ctx: ExecutionContext,
	guildId: string,
	editor: SkillEditor,
): Promise<APIInteractionResponse | null> {
	const [action, target] = parseId(interaction.data.custom_id);
	switch (action) {
		case Action.Select: {
			if (interaction.data.component_type !== ComponentType.StringSelect) {
				return null;
			}
			// スキルの画面には、SKILL.mdを添付する。最初の応答はJSONで返すので、添付は、保留にした応答の書き換えで送る
			const id = Number(interaction.data.values[0]);
			return respondLater(
				ctx,
				interaction,
				editor.id,
				"reply",
				async () => {
					const skill = await getSkill(env.DB, guildId, id);
					return skill === null ? { content: NOT_FOUND } : skillScreen(skill);
				},
				{ content: LOAD_FAILED },
			);
		}
		case Action.Edit: {
			const skill = await getSkill(env.DB, guildId, Number(target));
			if (skill === null) {
				return ephemeral(NOT_FOUND);
			}
			// 入力欄に入れる値が上限を超えると、入力画面を開けない。
			// 絵文字などはDiscordの数え方で2文字になることがあるので、UTF-16の長さで確かめる
			if (skill.body.length > MAX_MODAL_BODY_LENGTH) {
				return ephemeral(TOO_LONG_FOR_MODAL);
			}
			// 開いたときの更新日時を、送信のときに比べる(ほかの人が変えていたら、上書きしない)
			return writeModal(
				idOf(Action.EditModal, skill.id, skill.updatedAt),
				"スキルを編集する",
				skill,
			);
		}
		case Action.Replace: {
			const skill = await getSkill(env.DB, guildId, Number(target));
			return skill === null
				? ephemeral(NOT_FOUND)
				: fileModal(
						idOf(Action.ReplaceModal, skill.id, skill.updatedAt),
						"スキルをファイルで置き換える",
					);
		}
		case Action.Delete: {
			const skill = await getSkill(env.DB, guildId, Number(target));
			if (skill === null) {
				return ephemeral(NOT_FOUND);
			}
			return {
				type: InteractionResponseType.ChannelMessageWithSource,
				data: {
					flags: MessageFlags.Ephemeral,
					content: `スキル「${skill.name}」を削除します。このサーバーの全員の返答で、使われなくなります。よろしいですか?`,
					components: [
						{
							type: ComponentType.ActionRow,
							components: [
								{
									type: ComponentType.Button,
									style: ButtonStyle.Danger,
									custom_id: idOf(Action.DeleteConfirm, skill.id),
									label: "削除する",
								},
							],
						},
					],
				},
			};
		}
		case Action.DeleteConfirm: {
			const name = await deleteSkill(env.DB, guildId, Number(target));
			if (name === null) {
				return updateMessage(NOT_FOUND);
			}
			log("skill_deleted", { userId: editor.id, guildId, skill: name });
			return updateMessage(`スキル「${name}」を削除しました。`);
		}
		case Action.Overwrite: {
			// 置き換えられないときは、確かめる画面(書いた内容の添付)を残したまま、理由を見せる
			const id = Number(target);
			const pending = await getPendingSkill(env.DB, guildId, editor.id, id);
			if (pending === null) {
				return ephemeral(PENDING_GONE);
			}
			const result = await overwriteSkill(env.DB, guildId, pending, editor);
			if (result === "limit") {
				return ephemeral(LIMIT_REACHED);
			}
			await deletePendingSkill(env.DB, id);
			log(result === "saved" ? "skill_updated" : "skill_added", {
				userId: editor.id,
				guildId,
				skill: pending.name,
				via: "overwrite",
			});
			return {
				type: InteractionResponseType.UpdateMessage,
				data: {
					content:
						result === "saved"
							? savedText(pending.name)
							: addedText(pending.name),
					components: [],
					attachments: [],
				},
			};
		}
	}
	return null;
}

/** /skills の入力画面(モーダル)の送信。知らない操作ならnull */
export async function submitSkillModal(
	interaction: APIModalSubmitInteraction,
	env: Env,
	ctx: ExecutionContext,
	guildId: string,
	editor: SkillEditor,
): Promise<APIInteractionResponse | null> {
	const [action, target, expectedUpdatedAt] = parseId(
		interaction.data.custom_id,
	);
	const edited = {
		id: Number(target),
		expectedUpdatedAt: Number(expectedUpdatedAt),
	};
	switch (action) {
		case Action.RegisterModal:
			// /regskills から開いた入力画面。登録できないときは、書いた内容を添付して返す。
			// 元になるメッセージがないので、本人にだけ見える新しいメッセージを保留にして、そこに結果を書く
			return respondLater(
				ctx,
				interaction,
				editor.id,
				"reply",
				async () => {
					const content = writtenSkill(interaction);
					const problem = problemOf(content);
					return problem !== null
						? withDraft(problem, content)
						: register(env.DB, guildId, content, editor, "text");
				},
				{ content: SAVE_FAILED },
			);
		case Action.EditModal:
			// ほかの人が変えていたら、書いた内容を添付して知らせる。添付を送るために、保留にする
			return updateOrReplyLater(
				ctx,
				interaction,
				editor.id,
				async () => {
					const content = writtenSkill(interaction);
					const problem = problemOf(content);
					return problem !== null
						? { reply: { content: problem } }
						: save(env.DB, guildId, edited, content, editor, "text");
				},
				{ content: SAVE_FAILED },
			);
		case Action.ReplaceModal:
			return updateOrReplyLater(
				ctx,
				interaction,
				editor.id,
				async () => {
					const content = await readSkillFile(
						readFileUpload(interaction, FILE_INPUT_ID),
					);
					return typeof content === "string"
						? { reply: { content } }
						: save(env.DB, guildId, edited, content, editor, "file");
				},
				{ content: SAVE_FAILED },
			);
	}
	return null;
}

/** 入力された名前を整える。全角の英数字は半角に、大文字は小文字にし、前後の空白を除く */
export function normalizeSkillName(input: string): string {
	return input.normalize("NFKC").trim().toLowerCase();
}

/**
 * /regskills で、スキルを登録する。結果は、本人にだけ見えるメッセージに書く。
 * 同じ名前のスキルがあれば、置き換えるかを確かめる(内容は、確かめている間だけ保存する)。
 * 入力画面で書いた内容(viaがtext)は、登録できなければ、SKILL.mdにして添付する
 */
async function register(
	db: D1Database,
	guildId: string,
	content: SkillContent,
	editor: SkillEditor,
	via: "text" | "file",
): Promise<MessageEdit> {
	const result =
		(await findSkillByName(db, guildId, content.name)) === null
			? await addSkill(db, guildId, content, editor)
			: "duplicate";
	if (result === "added") {
		log("skill_added", {
			userId: editor.id,
			guildId,
			skill: content.name,
			via,
		});
		return { content: addedText(content.name) };
	}
	if (result === "limit") {
		return via === "text"
			? withDraft(LIMIT_REACHED, content)
			: { content: LIMIT_REACHED };
	}
	const pendingId = await savePendingSkill(db, guildId, editor.id, content);
	const question =
		via === "file"
			? `「${content.name}」という名前のスキルは、すでにあります。添付したSKILL.mdで置き換えますか?`
			: `「${content.name}」という名前のスキルは、すでにあります。書いた内容で置き換えますか?`;
	return {
		...(via === "text" ? withDraft(question, content) : { content: question }),
		components: [
			{
				type: ComponentType.ActionRow,
				components: [
					{
						type: ComponentType.Button,
						style: ButtonStyle.Danger,
						custom_id: idOf(Action.Overwrite, pendingId),
						label: "置き換える",
					},
				],
			},
		],
	};
}

/** 登録できなかった理由に、書いた内容を添付したことを書き添え、書いた内容をSKILL.mdにして添付する */
function withDraft(message: string, content: SkillContent): MessageEdit {
	return {
		content: `${message}\n${DRAFT_ATTACHED}`,
		files: [skillFileOf(content)],
	};
}

/** /regskills に添付されたファイル。なければundefined */
function attachedFile(
	interaction: APIChatInputApplicationCommandInteraction,
): APIAttachment | undefined {
	const option = interaction.data.options?.find(
		(candidate) =>
			candidate.name === REGSKILLS_FILE_OPTION &&
			candidate.type === ApplicationCommandOptionType.Attachment,
	);
	return option?.type === ApplicationCommandOptionType.Attachment
		? interaction.data.resolved?.attachments?.[option.value]
		: undefined;
}

function addedText(name: string): string {
	return `スキル「${name}」を追加しました。次の返答から使います。`;
}

function savedText(name: string): string {
	return `スキル「${name}」を保存しました。次の返答から使います。`;
}

/**
 * 編集した内容を保存する。保存できたら、スキルの画面を結果に書き換える(添付していたSKILL.mdも外す)。
 * 編集の画面を開いた後に、ほかの人が変えていたら保存せず、送った内容を添付して知らせる
 */
async function save(
	db: D1Database,
	guildId: string,
	target: { id: number; expectedUpdatedAt: number },
	content: SkillContent,
	editor: SkillEditor,
	via: "text" | "file",
): Promise<DeferredResult> {
	const result = await updateSkill(db, guildId, target, content, editor);
	if (result === "conflict") {
		return { reply: { content: CONFLICT, files: [skillFileOf(content)] } };
	}
	if (result === "duplicate") {
		return { reply: { content: duplicateName(content.name) } };
	}
	log("skill_updated", {
		userId: editor.id,
		guildId,
		skill: content.name,
		via,
	});
	return {
		update: {
			content: savedText(content.name),
			components: [],
			attachments: [],
		},
	};
}

/** 入力画面に書いたスキル。名前は整え、説明と本文は前後の空白を外す */
function writtenSkill(interaction: APIModalSubmitInteraction): SkillContent {
	return {
		name: normalizeSkillName(readTextInput(interaction, NAME_INPUT_ID) ?? ""),
		description: (
			readTextInput(interaction, DESCRIPTION_INPUT_ID) ?? ""
		).trim(),
		body: cleanSkillBody(readTextInput(interaction, BODY_INPUT_ID) ?? ""),
	};
}

/** 添付されたSKILL.mdを読む。読めないか、決まりに合わなければ、本人に見せる理由を返す */
async function readSkillFile(
	attachment: APIAttachment | undefined,
): Promise<SkillContent | string> {
	if (attachment === undefined || attachment.size > MAX_FILE_BYTES) {
		return UNREADABLE_FILE;
	}
	let text: string;
	try {
		const response = await fetch(attachment.url);
		const bytes = await response.arrayBuffer();
		if (!response.ok || bytes.byteLength > MAX_FILE_BYTES) {
			return UNREADABLE_FILE;
		}
		// UTF-8でなければ読まない。ignoreBOMをfalseにすると、先頭のBOMは外れる
		text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
			bytes,
		);
	} catch {
		return UNREADABLE_FILE;
	}
	const file = parseSkillFile(text);
	if (file === null) {
		return UNREADABLE_FILE;
	}
	const content = { ...file, name: normalizeSkillName(file.name) };
	return problemOf(content) ?? content;
}

/** スキルが決まり(名前の規則と、長さの上限)に合わなければ、その理由 */
function problemOf(content: SkillContent): string | null {
	if (!isValidSkillName(content.name)) {
		return INVALID_NAME;
	}
	if (countCharacters(content.description) > MAX_DESCRIPTION_LENGTH) {
		return DESCRIPTION_TOO_LONG;
	}
	const bodyLength = countCharacters(content.body);
	if (bodyLength > MAX_BODY_LENGTH) {
		return `本文は2万文字までにしてください(いまは${bodyLength.toLocaleString("en-US")}文字)。`;
	}
	return null;
}

function duplicateName(name: string): string {
	return `「${name}」という名前のスキルは、すでにあります。別の名前にするか、一覧から選んで編集してください。`;
}

/** /skills の画面。スキルがあれば、選ぶためのセレクトメニューを付ける(追加は /regskills から行う) */
async function panel(
	db: D1Database,
	guildId: string,
): Promise<{
	content: string;
	components: APIActionRowComponent<APIComponentInMessageActionRow>[];
}> {
	const skills = await listSkills(db, guildId);
	return {
		content: panelText(skills),
		components: skills.length > 0 ? [selectRow(skills)] : [],
	};
}

/**
 * /skills の画面の本文。見出しの次の行から、スキルの名前と説明を箇条書きにする(名前の順)。
 * 説明は全文を書き、1通に収まらなければ短くする
 */
function panelText(skills: SkillSummary[]): string {
	if (skills.length === 0) {
		return `${PANEL_HEADER}: なし`;
	}
	let text = "";
	for (const previewLength of LIST_PREVIEW_LENGTHS) {
		text = [
			PANEL_HEADER,
			...skills.map((skill) => listLine(skill, previewLength)),
		].join("\n");
		if (text.length <= MESSAGE_LENGTH) {
			return text;
		}
	}
	return text.slice(0, MESSAGE_LENGTH);
}

/** 一覧の1行。説明はpreviewLength文字まで(0なら書かない)。例: - `meeting-notes`: 会議の議事録を書く手順 */
function listLine(skill: SkillSummary, previewLength: number): string {
	const description =
		previewLength > 0 ? `: ${preview(skill.description, previewLength)}` : "";
	return `- \`${skill.name}\`${description}`;
}

/** スキルを選ぶセレクトメニュー。選択肢には、名前と説明の先頭を出す */
function selectRow(
	skills: SkillSummary[],
): APIActionRowComponent<APIComponentInMessageActionRow> {
	return {
		type: ComponentType.ActionRow,
		components: [
			{
				type: ComponentType.StringSelect,
				custom_id: idOf(Action.Select),
				placeholder: "スキルを選んで、中身を見る・編集する",
				options: skills.map((skill) => {
					const description = optionDescription(skill.description);
					return {
						label: skill.name,
						value: String(skill.id),
						...(description !== "" ? { description } : {}),
					};
				}),
			},
		],
	};
}

/** スキルの画面。説明と、登録した人と最後に編集した人を書き、SKILL.mdを添付する */
function skillScreen(skill: Skill): MessageEdit {
	const registered = `登録: ${skill.createdByName}(${formatJstDate(skill.createdAt)})`;
	const people =
		skill.editedByName === null
			? registered
			: `${registered}・最後の編集: ${skill.editedByName}(${formatJstDate(skill.updatedAt)})`;
	return {
		content: [`**${skill.name}**`, skill.description, `-# ${people}`].join(
			"\n",
		),
		components: [
			{
				type: ComponentType.ActionRow,
				components: [
					{
						type: ComponentType.Button,
						style: ButtonStyle.Primary,
						custom_id: idOf(Action.Edit, skill.id),
						label: "編集",
					},
					{
						type: ComponentType.Button,
						style: ButtonStyle.Secondary,
						custom_id: idOf(Action.Replace, skill.id),
						label: "ファイルで置き換え",
					},
					{
						type: ComponentType.Button,
						style: ButtonStyle.Danger,
						custom_id: idOf(Action.Delete, skill.id),
						label: "削除",
					},
				],
			},
		],
		files: [skillFileOf(skill)],
	};
}

/** 名前・説明・本文を書く入力画面。skillを渡すと、その内容を入れて開く */
function writeModal(
	customId: string,
	title: string,
	skill: SkillContent | null,
): APIInteractionResponse {
	return {
		type: InteractionResponseType.Modal,
		data: {
			custom_id: customId,
			title,
			components: [
				{
					type: ComponentType.Label,
					label: "名前",
					description: "英小文字、数字、ハイフンで64文字まで",
					component: {
						type: ComponentType.TextInput,
						custom_id: NAME_INPUT_ID,
						style: TextInputStyle.Short,
						placeholder: "例: meeting-notes",
						required: true,
						max_length: MAX_SKILL_NAME_LENGTH,
						...(skill ? { value: skill.name } : {}),
					},
				},
				{
					type: ComponentType.Label,
					label: "説明",
					description:
						"何をするスキルで、いつ使うか。AIはこれを見て、使うかどうかを決める",
					component: {
						type: ComponentType.TextInput,
						custom_id: DESCRIPTION_INPUT_ID,
						style: TextInputStyle.Paragraph,
						placeholder:
							"例: 会議の議事録を書く手順。議事録やまとめを頼まれたときに使う",
						required: true,
						// 今の説明に絵文字などがあると、UTF-16では上限より長いことがある。そのときも開けるように広げる
						// (送った説明の長さは、保存の前に確かめる)
						max_length: Math.max(
							MAX_DESCRIPTION_LENGTH,
							skill?.description.length ?? 0,
						),
						...(skill ? { value: skill.description } : {}),
					},
				},
				{
					type: ComponentType.Label,
					label: "本文",
					description:
						"AIに従ってほしい手順や知識。4000文字まで。長いときはファイルを使う",
					component: {
						type: ComponentType.TextInput,
						custom_id: BODY_INPUT_ID,
						style: TextInputStyle.Paragraph,
						placeholder: "例: 決まったこと、宿題、次回の予定の3つに分けて書く",
						required: true,
						max_length: MAX_MODAL_BODY_LENGTH,
						...(skill ? { value: skill.body } : {}),
					},
				},
			],
		},
	};
}

/** SKILL.mdを添付する入力画面 */
function fileModal(customId: string, title: string): APIInteractionResponse {
	return {
		type: InteractionResponseType.Modal,
		data: {
			custom_id: customId,
			title,
			components: [
				{
					type: ComponentType.Label,
					label: SKILL_FILE_NAME,
					description:
						"冒頭に名前(name)と説明(description)を書いたファイル。本文は2万文字まで",
					component: {
						type: ComponentType.FileUpload,
						custom_id: FILE_INPUT_ID,
						min_values: 1,
						max_values: 1,
						required: true,
					},
				},
			],
		},
	};
}

function skillFileOf(content: SkillContent): MessageFile {
	return { name: SKILL_FILE_NAME, content: formatSkillFile(content) };
}

/** 先頭のlength文字。改行は空白にし、長ければ省いて「…」を付ける */
function preview(text: string, length: number): string {
	const characters = [...text.replace(/\s*\n\s*/g, " ")];
	return characters.length > length
		? `${characters.slice(0, length).join("")}…`
		: characters.join("");
}

/** セレクトメニューの選択肢の説明。Discordの上限(100文字)に収める */
function optionDescription(description: string): string {
	let length = OPTION_DESCRIPTION_LENGTH - 1;
	let text = preview(description, length);
	// 絵文字などは、Discordの数え方では2文字になることがあるので、収まるまで縮める
	while (text.length > OPTION_DESCRIPTION_LENGTH && length > 0) {
		length--;
		text = preview(description, length);
	}
	return text;
}

function idOf(action: string, ...args: (string | number)[]): string {
	return [`${SKILLS_ID_PREFIX}${action}`, ...args].join(":");
}

/** IDから、操作の種類と、続く値を読む */
function parseId(customId: string): string[] {
	return customId.slice(SKILLS_ID_PREFIX.length).split(":");
}

function ephemeral(content: string): APIInteractionResponse {
	return {
		type: InteractionResponseType.ChannelMessageWithSource,
		data: { flags: MessageFlags.Ephemeral, content },
	};
}

/** ボタンを押したメッセージを、結果に書き換える(ボタンは外す) */
function updateMessage(content: string): APIInteractionResponse {
	return {
		type: InteractionResponseType.UpdateMessage,
		data: { content, components: [] },
	};
}

function log(event: string, detail: Record<string, unknown>): void {
	logEvent("interactions", event, detail);
}
