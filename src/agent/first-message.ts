import type {
	APIButtonComponent,
	APIEmbed,
	RESTPostAPIChannelMessageJSONBody,
} from "discord-api-types/v10";
import { ButtonStyle, ComponentType } from "../discord/constants";
import { AGENT_END_ID } from "./relay";
import {
	END_BUTTON_LABEL,
	FIRST_MESSAGE_DESCRIPTION,
	FIRST_MESSAGE_FIELDS,
	FIRST_MESSAGE_TITLE,
	firstMessageContent,
} from "./texts";

/**
 * エージェントのチャンネルの最初のメッセージ(仕様: docs/spec/behavior.md「エージェント」)。
 * 埋め込みの見出し、説明、項目(コスト、ファイル、使い方)を出す。
 * 埋め込みリンクの権限がなければ、同じ内容を普通の文で書く
 */
export function firstMessage(
	ownerId: string,
	embed: boolean,
): RESTPostAPIChannelMessageJSONBody {
	const content = firstMessageContent(ownerId);
	const embeds: APIEmbed[] = [
		{
			title: FIRST_MESSAGE_TITLE,
			description: FIRST_MESSAGE_DESCRIPTION,
			fields: FIRST_MESSAGE_FIELDS.map((field) => ({ ...field })),
		},
	];
	const buttons: APIButtonComponent[] = [
		{
			type: ComponentType.Button,
			style: ButtonStyle.Secondary,
			label: END_BUTTON_LABEL,
			custom_id: AGENT_END_ID,
		},
	];
	const text = [
		content,
		"",
		`**${FIRST_MESSAGE_TITLE}**`,
		FIRST_MESSAGE_DESCRIPTION,
		...FIRST_MESSAGE_FIELDS.map((field) => `**${field.name}**: ${field.value}`),
	].join("\n");
	return {
		content: embed ? content : text,
		...(embed ? { embeds } : {}),
		components: [{ type: ComponentType.ActionRow, components: buttons }],
		allowed_mentions: { users: [ownerId] },
	};
}
