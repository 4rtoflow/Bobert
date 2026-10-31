import type {
	APIButtonComponent,
	APIEmbed,
	RESTPostAPIChannelMessageJSONBody,
} from "discord-api-types/v10";
import { ButtonStyle, ComponentType } from "../discord/constants";
import { AGENT_END_ID } from "./relay";
import {
	END_BUTTON_LABEL,
	effortLine,
	FIRST_MESSAGE_NOTES,
	FIRST_MESSAGE_TITLE,
	firstMessageContent,
	modelLine,
	repositoryLine,
} from "./texts";

/**
 * エージェントのチャンネルの最初のメッセージ(仕様: docs/spec/behavior.md「エージェント」)。
 * 埋め込みリンクの権限がなければ、同じ内容を普通の文で書く。
 * GitHubのリポジトリをつないだセッションには、「リポジトリ: owner/repo」の行を足す
 */
export function firstMessage(
	ownerId: string,
	modelLabel: string,
	effort: string,
	embed: boolean,
	repository: string | null,
): RESTPostAPIChannelMessageJSONBody {
	const details = [
		modelLine(modelLabel),
		effortLine(effort),
		...(repository === null ? [] : [repositoryLine(repository)]),
		"",
		...FIRST_MESSAGE_NOTES.map((note) => `- ${note}`),
	].join("\n");
	const content = firstMessageContent(ownerId);
	const embeds: APIEmbed[] = [
		{ title: FIRST_MESSAGE_TITLE, description: details },
	];
	const buttons: APIButtonComponent[] = [
		{
			type: ComponentType.Button,
			style: ButtonStyle.Secondary,
			label: END_BUTTON_LABEL,
			custom_id: AGENT_END_ID,
		},
	];
	return {
		content: embed
			? content
			: `${content}\n\n**${FIRST_MESSAGE_TITLE}**\n${details}`,
		...(embed ? { embeds } : {}),
		components: [{ type: ComponentType.ActionRow, components: buttons }],
		allowed_mentions: { users: [ownerId] },
	};
}
