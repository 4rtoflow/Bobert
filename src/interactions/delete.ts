import type { APIInteractionResponse } from "discord-api-types/v10";
import {
	ButtonStyle,
	ComponentType,
	InteractionResponseType,
	MessageFlags,
} from "../discord/constants";
import { logEvent } from "../log";
import { deleteUserData } from "../store/users";

/** /delete の確認のボタンのID */
export const DELETE_CONFIRM_ID = "delete:confirm";

/** /delete: 消してよいか、本人にだけ確かめる */
export function deleteCommand(): APIInteractionResponse {
	return {
		type: InteractionResponseType.ChannelMessageWithSource,
		data: {
			flags: MessageFlags.Ephemeral,
			content:
				"登録したAPIキー(AnthropicとOpenRouter)と設定を、すべて削除します。よろしいですか?",
			components: [
				{
					type: ComponentType.ActionRow,
					components: [
						{
							type: ComponentType.Button,
							style: ButtonStyle.Danger,
							custom_id: DELETE_CONFIRM_ID,
							label: "削除する",
						},
					],
				},
			],
		},
	};
}

/** 確認のボタン: キーと設定を消す(仕様: docs/spec/llm-cost.md「資格情報の登録・保存・削除」) */
export async function confirmDelete(
	env: Env,
	userId: string,
): Promise<APIInteractionResponse> {
	await deleteUserData(env.DB, userId);
	logEvent("interactions", "user_data_deleted", { userId });
	return {
		type: InteractionResponseType.UpdateMessage,
		data: {
			content:
				"削除しました。OpenRouterで発行されたキーは、OpenRouterのサイトでも削除できます。また使うときは `/setup` から登録してください。",
			components: [],
		},
	};
}
