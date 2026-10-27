import type { APIInteractionResponse } from "discord-api-types/v10";
import {
	ApplicationCommandType,
	InteractionResponseType,
	MessageFlags,
} from "../discord/constants";
import { COMPACT_COMMAND_NAME } from "../respond/compact-button";
import { COMMANDS } from "./commands";

/** /help: 使い方を、本人にだけ見せる(仕様: docs/spec/behavior.md「スラッシュコマンド」) */
export function helpCommand(): APIInteractionResponse {
	return {
		type: InteractionResponseType.ChannelMessageWithSource,
		data: { flags: MessageFlags.Ephemeral, content: helpText() },
	};
}

/** 使い方の本文。コマンドの一覧は、登録するコマンドの説明から作る(コマンドを足せば、ここにも出る) */
export function helpText(): string {
	const commands = COMMANDS.flatMap((command) =>
		command.type === ApplicationCommandType.ChatInput
			? [`- \`/${command.name}\`: ${command.description}`]
			: [],
	);
	return [
		"**Bobertの使い方**",
		"- Bobertにメンションするか、Bobertの返答に返信すると、AIが答えます。",
		"- メッセージに返信しながらBobertにメンションすると、そのメッセージについて聞けます。",
		`- メッセージの右クリックメニュー(アプリ)の「${COMPACT_COMMAND_NAME}」: そのメッセージまでの会話を要約します。長い会話の費用を抑えられます`,
		"- 費用は、登録した本人のアカウントに請求されます。まず `/setup` でキーを登録してください。",
		"",
		"**コマンド**",
		...commands,
	].join("\n");
}
