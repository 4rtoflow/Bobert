import type {
	APIActionRowComponent,
	APIButtonComponent,
} from "discord-api-types/v10";
import { ButtonStyle, ComponentType } from "../discord/constants";

/**
 * 会話の要約を始める入り口(仕様: docs/spec/architecture.md「長い会話の自動要約」)。
 * 要約を勧める案内の「今すぐ要約」ボタンと、右クリックメニュー(アプリ)の「会話を要約」
 */

/** 要約を勧める案内に付ける「今すぐ要約」ボタンのID */
export const COMPACT_BUTTON_ID = "compact";

/** 右クリックメニュー(アプリ)の、会話を要約する項目の名前 */
export const COMPACT_COMMAND_NAME = "会話を要約";

/** 要約を勧める案内に付ける、「今すぐ要約」ボタン */
export function compactButtonRow(): APIActionRowComponent<APIButtonComponent> {
	return {
		type: ComponentType.ActionRow,
		components: [
			{
				type: ComponentType.Button,
				style: ButtonStyle.Primary,
				label: "今すぐ要約",
				custom_id: COMPACT_BUTTON_ID,
			},
		],
	};
}
