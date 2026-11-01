import type {
	APIActionRowComponent,
	APIButtonComponent,
	APIButtonComponentWithCustomId,
	APIComponentInMessageActionRow,
} from "discord-api-types/v10";
import { ButtonStyle, ComponentType } from "../discord/constants";
import type { GitHubRepository } from "../github/api";
import type { MessageEdit } from "../interactions/deferred";
import {
	AGENT_LINK_FIRST,
	GITHUB_LINK_BUTTON_LABEL,
	GITHUB_OPEN_BUTTON_LABEL,
	NO_REPOSITORY_OPTION_LABEL,
	REPOSITORY_SELECT_PLACEHOLDER,
	repositoriesTruncated,
	START_WITHOUT_REPOSITORY_LABEL,
} from "./texts";

/**
 * /agent の返事で、セッションにつなぐGitHubのリポジトリを選んでもらう部品
 * (仕様: docs/spec/behavior.md「エージェント」の「始め方」)。
 * 連携していない人には、先に連携のボタンを出し、連携できたら、同じメッセージをセレクトメニューに書き換える
 */

/** /agent の返事の「GitHubと連携」。エージェントのチャンネルでの「GitHubと連携」(agent:github)とは、連携できた後が違う */
export const AGENT_GITHUB_START_ID = "agent:github_start";
/** 「リポジトリを使わずに始める」 */
export const AGENT_START_PLAIN_ID = "agent:start_plain";
/** リポジトリを選ぶセレクトメニュー */
export const AGENT_REPOSITORY_SELECT_ID = "agent:repository";
/** セレクトメニューの「リポジトリを使わない」の値。リポジトリの名前(owner/repo)には必ず「/」があるので、重ならない */
export const NO_REPOSITORY_VALUE = "none";

/** セレクトメニューに出すリポジトリの数。Discordの上限(25個)から、「リポジトリを使わない」の分を引く */
export const MAX_REPOSITORY_OPTIONS = 24;
/** 選択肢の名前と値の長さの上限(Discordの決まり) */
const MAX_OPTION_LENGTH = 100;

type Row = APIActionRowComponent<APIComponentInMessageActionRow>;

/** 連携していない人への、/agent の返事。「GitHubと連携」と「リポジトリを使わずに始める」 */
export function linkFirstMessage(): MessageEdit {
	return {
		content: AGENT_LINK_FIRST,
		components: [
			row(
				button(
					GITHUB_LINK_BUTTON_LABEL,
					AGENT_GITHUB_START_ID,
					ButtonStyle.Primary,
				),
				startWithoutRepositoryButton(),
			),
		],
	};
}

/** 「GitHubと連携」を押した後の、/agent の返事のボタン。GitHubへのリンクと、「リポジトリを使わずに始める」 */
export function linkOpenedComponents(url: string): Row[] {
	return [
		row(
			{
				type: ComponentType.Button,
				style: ButtonStyle.Link,
				label: GITHUB_OPEN_BUTTON_LABEL,
				url,
			},
			startWithoutRepositoryButton(),
		),
	];
}

/** 「リポジトリを使わずに始める」だけの行(GitHubとのやり取りに失敗したときにも出す) */
export function startWithoutRepositoryRow(): Row {
	return row(startWithoutRepositoryButton());
}

/**
 * リポジトリを選ぶメッセージ。先頭に「リポジトリを使わない」を置き、リポジトリは最近pushした順に並べる。
 * 出しきれなければ、出した数をメッセージの最後に書き足す
 */
export function repositorySelectMessage(
	content: string,
	repositories: readonly GitHubRepository[],
): MessageEdit {
	const usable = repositories
		.filter((repository) => repository.fullName.length <= MAX_OPTION_LENGTH)
		.sort((a, b) => (b.pushedAt ?? 0) - (a.pushedAt ?? 0));
	const shown = usable.slice(0, MAX_REPOSITORY_OPTIONS);
	return {
		content:
			usable.length > shown.length
				? `${content}\n${repositoriesTruncated(MAX_REPOSITORY_OPTIONS)}`
				: content,
		components: [
			{
				type: ComponentType.ActionRow,
				components: [
					{
						type: ComponentType.StringSelect,
						custom_id: AGENT_REPOSITORY_SELECT_ID,
						placeholder: REPOSITORY_SELECT_PLACEHOLDER,
						options: [
							{ label: NO_REPOSITORY_OPTION_LABEL, value: NO_REPOSITORY_VALUE },
							...shown.map((repository) => ({
								label: repository.fullName,
								value: repository.fullName,
							})),
						],
					},
				],
			},
		],
	};
}

function startWithoutRepositoryButton(): APIButtonComponent {
	return button(
		START_WITHOUT_REPOSITORY_LABEL,
		AGENT_START_PLAIN_ID,
		ButtonStyle.Secondary,
	);
}

function button(
	label: string,
	customId: string,
	style: APIButtonComponentWithCustomId["style"],
): APIButtonComponentWithCustomId {
	return { type: ComponentType.Button, style, label, custom_id: customId };
}

function row(...components: APIButtonComponent[]): Row {
	return { type: ComponentType.ActionRow, components };
}
