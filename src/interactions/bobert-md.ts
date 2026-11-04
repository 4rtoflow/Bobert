import type {
	APIInteractionResponse,
	APIModalSubmitInteraction,
} from "discord-api-types/v10";
import {
	ComponentType,
	InteractionResponseType,
	TextInputStyle,
} from "../discord/constants";
import { logEvent } from "../log";
import { formatJstDate } from "../respond/time";
import {
	type BobertMdEditor,
	getBobertMd,
	MAX_BOBERT_MD_LENGTH,
	saveBobertMd,
} from "../store/bobert-md";
import { type MessageEdit, respondLater } from "./deferred";
import { readTextInput } from "./input";

/*
 * Bobert.md(サーバーの全員への返答で、AIに毎回渡す、サーバーの情報や指示)を、誰でも編集できるようにする
 * (仕様: docs/spec/behavior.md「Bobert.md」。表示する文言は、2026-11-04に承認)
 */

/** /bobertmd の名前と説明 */
export const BOBERTMD_COMMAND_NAME = "bobertmd";
export const BOBERTMD_COMMAND_DESCRIPTION =
	"Bobert.md(このサーバーの全員への返答で、AIが毎回読む情報や指示)の確認と編集";

/** /help の使い方に足す1行 */
export const BOBERTMD_HELP =
	"- `/bobertmd` で、このサーバーの情報やAIへの指示を、Bobert.mdに書いておけます。AIは、このサーバーの全員への返答で毎回読みます。誰でも編集できます。";

/**
 * Bobert.mdを編集する入力画面のIDの頭。続けて、画面を開いたときの更新日時(まだ誰も編集していなければ0)を付ける。
 * 送ったときに比べて、ほかの人が変えていたら上書きしない
 */
export const BOBERTMD_MODAL_PREFIX = "bobertmd:edit:";
const CONTENT_INPUT_ID = "content";
/** 編集が重なったときに、送った内容を添付するファイルの名前 */
const FILE_NAME = "Bobert.md";

const SAVED =
	"Bobert.mdを保存しました。次の返答から、このサーバーの全員への返答で使います。";
const CLEARED = "Bobert.mdを消しました。次の返答から使いません。";
const CONFLICT_HEAD =
	"編集の画面を開いている間に、ほかの人がBobert.mdを変更したため、保存しませんでした。";
const CONTENT_ATTACHED = "送った内容を添付します。";
const CONFLICT_TAIL = "`/bobertmd` から開き直して、もう一度試してください。";
const SAVE_FAILED =
	"Bobert.mdを保存できませんでした。少し待ってから、もう一度試してください。";

/** /bobertmd: 今の内容を入れた入力画面を開く。編集されたことがあれば、最後に編集した人を上に書く */
export async function bobertmdCommand(
	env: Env,
	guildId: string,
): Promise<APIInteractionResponse> {
	const current = await getBobertMd(env.DB, guildId);
	return {
		type: InteractionResponseType.Modal,
		data: {
			custom_id: `${BOBERTMD_MODAL_PREFIX}${current?.updatedAt ?? 0}`,
			title: "Bobert.mdを編集する",
			components: [
				// 誰でも編集できるので、誰が最後に変えたか(空にしたときも)を見せる
				...(current === null
					? []
					: [
							{
								type: ComponentType.TextDisplay,
								content: `-# 最後の編集: ${current.editedByName}(${formatJstDate(current.updatedAt)})`,
							},
						]),
				{
					type: ComponentType.Label,
					label: "Bobert.md",
					description:
						"このサーバーの全員への返答で、AIが毎回読む情報や指示。4000文字まで。空にすると消える",
					component: {
						type: ComponentType.TextInput,
						custom_id: CONTENT_INPUT_ID,
						style: TextInputStyle.Paragraph,
						placeholder:
							"例: 大学のゲームサークルのサーバー。活動は毎週水曜。サークル内の用語には短い説明を付けて",
						required: false,
						max_length: MAX_BOBERT_MD_LENGTH,
						...(current?.content ? { value: current.content } : {}),
					},
				},
			],
		},
	};
}

/**
 * 入力画面の送信: Bobert.mdを保存し、結果を本人にだけ見せる。空なら消す。
 * 編集が重なったら保存せず、送った内容を添付して知らせる。添付を送るために、保留にしてから結果を書く
 */
export function submitBobertMd(
	interaction: APIModalSubmitInteraction,
	env: Env,
	ctx: ExecutionContext,
	guildId: string,
	editor: BobertMdEditor,
): APIInteractionResponse {
	const expectedUpdatedAt = Number(
		interaction.data.custom_id.slice(BOBERTMD_MODAL_PREFIX.length),
	);
	const content = truncate(
		(readTextInput(interaction, CONTENT_INPUT_ID) ?? "").trim(),
		MAX_BOBERT_MD_LENGTH,
	);
	return respondLater(
		ctx,
		interaction,
		editor.id,
		"reply",
		() => save(env.DB, guildId, expectedUpdatedAt, content, editor),
		{ content: SAVE_FAILED },
	);
}

async function save(
	db: D1Database,
	guildId: string,
	expectedUpdatedAt: number,
	content: string,
	editor: BobertMdEditor,
): Promise<MessageEdit> {
	const result = await saveBobertMd(
		db,
		guildId,
		expectedUpdatedAt,
		content,
		editor,
	);
	if (result === "conflict") {
		log("bobert_md_conflict", { userId: editor.id, guildId });
		// 空にしようとしたときは、添付するものがない(空のファイルは送らない)
		return content === ""
			? { content: `${CONFLICT_HEAD}${CONFLICT_TAIL}` }
			: {
					content: `${CONFLICT_HEAD}${CONTENT_ATTACHED}${CONFLICT_TAIL}`,
					files: [{ name: FILE_NAME, content }],
				};
	}
	if (result === "saved") {
		// 誰が変えたかを後から分かるようにする。中身は残さない
		log("bobert_md_updated", {
			userId: editor.id,
			guildId,
			length: content.length,
			cleared: content === "",
		});
	}
	return { content: content === "" ? CLEARED : SAVED };
}

/**
 * 長さ(UTF-16)をmaxまでにする。入力欄の上限はDiscordが守るが、念のためここでも切り詰める。
 * 上限を超えて保存すると、次に入力画面を開けなくなるため。切り目で、絵文字などを半分に割らない
 */
function truncate(text: string, max: number): string {
	if (text.length <= max) {
		return text;
	}
	const cut = text.slice(0, max);
	const last = cut.charCodeAt(cut.length - 1);
	return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

function log(event: string, detail: Record<string, unknown>): void {
	logEvent("interactions", event, detail);
}
