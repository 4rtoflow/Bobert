import type { APIInteractionResponse } from "discord-api-types/v10";
import {
	ApplicationCommandType,
	InteractionResponseType,
	MessageFlags,
} from "../discord/constants";
import { COMPACT_COMMAND_NAME } from "../respond/compact-button";
import { COMMANDS } from "./commands";
import { EXPLAIN_COMMAND_NAME } from "./explain";

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
		"- AIは必要なときに、このサーバーでBotが見られるチャンネルの過去のメッセージを探して答えます。年齢制限のチャンネルと非公開スレッドのメッセージは、その中での返答にだけ使います。",
		"- ほかのチャンネルの内容を、そのチャンネルを見られない人もいるチャンネルで答えることがあります。AIに読ませたくないチャンネルは、Botの「チャンネルを見る」権限を外してください。",
		`- メッセージの右クリックメニュー(アプリ)の「${EXPLAIN_COMMAND_NAME}」: そのメッセージの意味を説明します`,
		`- メッセージの右クリックメニュー(アプリ)の「${COMPACT_COMMAND_NAME}」: そのメッセージまでの会話を要約します。長い会話の費用を抑えられます`,
		"- 費用は、登録した本人のアカウントに請求されます。まず `/setup` でキーを登録してください。",
		"- サーバーに寄付されたクレジット(`/donate`)があれば、先にそれを使います。キーがなくても使えます。",
		"- `/regskills` で登録したスキル(手順や知識)を、AIが必要に応じて読んで使います。一覧と編集は `/skills` で行います。",
		"",
		"**コマンド**",
		...commands,
	].join("\n");
}
