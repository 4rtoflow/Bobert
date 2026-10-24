import type {
	APIInteractionResponse,
	APIModalSubmitInteraction,
} from "discord-api-types/v10";
import {
	ComponentType,
	InteractionResponseType,
	MessageFlags,
	TextInputStyle,
} from "../discord/constants";
import { logEvent } from "../log";
import { getUserSettings, updateUserSettings } from "../store/users";
import { readTextInput } from "./input";

/** 自分用の指示を編集するモーダルのID */
export const PROMPT_MODAL_ID = "prompt:edit";
const PROMPT_INPUT_ID = "prompt";

/**
 * 自分用の指示の長さの上限(仕様: docs/spec/behavior.md「AIへの指示」)。
 * /settingsで、ほかの設定と一緒に1通で全文を見せられる長さにする
 */
export const MAX_PROMPT_LENGTH = 1500;

/** /prompt: 今の指示を入れた状態で、編集するモーダルを開く */
export async function promptCommand(
	env: Env,
	userId: string,
): Promise<APIInteractionResponse> {
	const { customPrompt } = await getUserSettings(env.DB, userId);
	return {
		type: InteractionResponseType.Modal,
		data: {
			custom_id: PROMPT_MODAL_ID,
			title: "自分用のAIへの指示",
			components: [
				{
					type: ComponentType.Label,
					label: "指示",
					description:
						"返答するときに、共通の指示に加えて従ってほしいこと。空にすると、指示なしに戻る",
					component: {
						type: ComponentType.TextInput,
						custom_id: PROMPT_INPUT_ID,
						style: TextInputStyle.Paragraph,
						placeholder: "例: 箇条書きで答えて。専門用語には短い説明を付けて",
						required: false,
						max_length: MAX_PROMPT_LENGTH,
						...(customPrompt ? { value: customPrompt } : {}),
					},
				},
			],
		},
	};
}

/** モーダルの送信: 指示を保存し、結果を本人にだけ見せる。空なら指示なしに戻す */
export async function submitPrompt(
	interaction: APIModalSubmitInteraction,
	env: Env,
	userId: string,
): Promise<APIInteractionResponse> {
	// 入力欄の上限はDiscordが守るが、念のためここでも切り詰める
	const prompt = (readTextInput(interaction, PROMPT_INPUT_ID) ?? "")
		.trim()
		.slice(0, MAX_PROMPT_LENGTH);
	await updateUserSettings(env.DB, userId, {
		customPrompt: prompt === "" ? null : prompt,
	});
	logEvent("interactions", "custom_prompt_updated", {
		userId,
		length: prompt.length,
	});
	return {
		type: InteractionResponseType.ChannelMessageWithSource,
		data: {
			flags: MessageFlags.Ephemeral,
			content:
				prompt === ""
					? "自分用の指示を消しました。次の返答から、共通の指示だけで答えます。"
					: "自分用の指示を保存しました。次の返答から使います。",
		},
	};
}
