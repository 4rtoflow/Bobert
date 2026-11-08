import type {
	APIActionRowComponent,
	APIChatInputApplicationCommandInteraction,
	APIComponentInMessageActionRow,
	APIInteractionResponse,
	APIMessageComponentInteraction,
	APIModalSubmitInteraction,
} from "discord-api-types/v10";
import { agentClient, agentModel, describeAgentError } from "../agent/managed";
import {
	type AddSecretResult,
	type AgentSecret,
	addAgentSecret,
	deleteAgentSecret,
	isValidSecretName,
	listAgentSecrets,
	MAX_AGENT_SECRETS,
	MAX_SECRET_NAME_LENGTH,
	parseSecretUrl,
} from "../agent/secrets";
import {
	ButtonStyle,
	ComponentType,
	InteractionResponseType,
	MessageFlags,
	TextInputStyle,
} from "../discord/constants";
import { getUserSettings, loadCredential } from "../store/users";
import { type MessageEdit, respondLater } from "./deferred";
import { readTextInput } from "./input";

/**
 * /agentsecrets: エージェントに渡す秘密(ログインの情報やAPIキー)の登録と一覧(#99。仕様: docs/spec/behavior.md「エージェント」)。
 * 値は本人のAnthropicのアカウントのvaultに預け、Bobertには残さない。画面はすべて本人にだけ見せる
 */

export const AGENT_SECRETS_COMMAND_NAME = "agentsecrets";
export const AGENT_SECRETS_COMMAND_DESCRIPTION =
	"エージェントに渡す秘密(ログインの情報やAPIキー)の登録と一覧";
/** ボタン、セレクトメニュー、入力画面のIDの頭。続けて操作の種類と値を「:」でつなぐ */
export const AGENT_SECRETS_ID_PREFIX = "agentsecrets:";

const Action = {
	Add: "add",
	Select: "select",
	Delete: "delete",
	AddModal: "add-modal",
} as const;

const NAME_INPUT_ID = "name";
const VALUE_INPUT_ID = "value";
const URL_INPUT_ID = "url";

const PANEL_HEADER = "**エージェントに渡す秘密**";
const PANEL_NOTE =
	"-# 値はAnthropicに預け、Bobertにもエージェントのサンドボックスにも残しません。同じAnthropicのワークスペースの開発者は、この秘密を自分のセッションで使えます(値は見られません)。";
const KEY_MISSING =
	"秘密を登録するには、AnthropicのAPIキーの登録が必要です(OpenRouterでは使えません)。`/setup` から登録してください。";
const INVALID_NAME =
	"名前は、英大文字、数字、_ だけで、先頭は英大文字にしてください。例: `WEATHER_API_KEY`";
const INVALID_URL = "送り先は、https:// で始まるURLにしてください。";
const LIMIT_REACHED = `秘密は${MAX_AGENT_SECRETS}個までです。使っていない秘密を削除してから追加してください。`;

/** /agentsecrets: 預けた秘密の一覧を、本人にだけ見せる(vaultを読むので、保留にしてから書く) */
export async function agentSecretsCommand(
	interaction: APIChatInputApplicationCommandInteraction,
	env: Env,
	ctx: ExecutionContext,
	userId: string,
): Promise<APIInteractionResponse> {
	const credential = await loadCredential(env, userId, "anthropic");
	if (credential === null) {
		return ephemeral(KEY_MISSING);
	}
	return respondLater(
		ctx,
		interaction,
		userId,
		"reply",
		async () => {
			try {
				const secrets = await listAgentSecrets(
					env.DB,
					userId,
					agentClient(credential),
				);
				return panel(secrets);
			} catch (error) {
				return { content: await failed(env, userId, "読み込め", error) };
			}
		},
		{ content: "秘密を読み込めませんでした。" },
	);
}

/** 一覧の画面のボタンとセレクトメニュー。知らない操作ならnull */
export async function agentSecretsComponent(
	interaction: APIMessageComponentInteraction,
	env: Env,
	ctx: ExecutionContext,
	userId: string,
): Promise<APIInteractionResponse | null> {
	const [action, ...values] = parseId(interaction.data.custom_id);
	switch (action) {
		case Action.Add:
			return addModal();
		case Action.Select: {
			if (interaction.data.component_type !== ComponentType.StringSelect) {
				return null;
			}
			const [id = "", name = ""] = (interaction.data.values[0] ?? "").split(
				":",
			);
			return {
				type: InteractionResponseType.ChannelMessageWithSource,
				data: {
					flags: MessageFlags.Ephemeral,
					content: `秘密「${name}」を削除します。よろしいですか?`,
					components: [
						{
							type: ComponentType.ActionRow,
							components: [
								{
									type: ComponentType.Button,
									style: ButtonStyle.Danger,
									custom_id: idOf(Action.Delete, id, name),
									label: "削除する",
								},
							],
						},
					],
				},
			};
		}
		case Action.Delete: {
			const [id = "", name = ""] = values;
			const credential = await loadCredential(env, userId, "anthropic");
			if (credential === null) {
				return ephemeral(KEY_MISSING);
			}
			return respondLater(
				ctx,
				interaction,
				userId,
				"update",
				async () => {
					try {
						await deleteAgentSecret(
							env.DB,
							userId,
							agentClient(credential),
							id,
						);
					} catch (error) {
						return {
							content: await failed(env, userId, "削除でき", error),
							components: [],
						};
					}
					return {
						content: `秘密「${name}」を削除しました。`,
						components: [],
					};
				},
				{ content: "秘密を削除できませんでした。", components: [] },
			);
		}
	}
	return null;
}

/** 入力画面の送信。名前と送り先を確かめてから、vaultに預ける(保留にしてから、結果を書く) */
export async function submitAgentSecretModal(
	interaction: APIModalSubmitInteraction,
	env: Env,
	ctx: ExecutionContext,
	userId: string,
): Promise<APIInteractionResponse | null> {
	const [action] = parseId(interaction.data.custom_id);
	if (action !== Action.AddModal) {
		return null;
	}
	const name = (readTextInput(interaction, NAME_INPUT_ID) ?? "")
		.normalize("NFKC")
		.trim()
		.toUpperCase();
	if (!isValidSecretName(name)) {
		return ephemeral(INVALID_NAME);
	}
	const destination = parseSecretUrl(
		(readTextInput(interaction, URL_INPUT_ID) ?? "").normalize("NFKC"),
	);
	if (destination === null) {
		return ephemeral(INVALID_URL);
	}
	const value = readTextInput(interaction, VALUE_INPUT_ID) ?? "";
	const credential = await loadCredential(env, userId, "anthropic");
	if (credential === null) {
		return ephemeral(KEY_MISSING);
	}
	return respondLater(
		ctx,
		interaction,
		userId,
		"reply",
		async () => {
			let result: AddSecretResult;
			try {
				result = await addAgentSecret(env.DB, userId, agentClient(credential), {
					name,
					value,
					...destination,
				});
			} catch (error) {
				return { content: await failed(env, userId, "保存でき", error) };
			}
			return { content: addedText(name, result) };
		},
		{ content: "秘密を保存できませんでした。" },
	);
}

function addedText(name: string, result: AddSecretResult): string {
	switch (result) {
		case "added":
			return `秘密「${name}」を追加しました。次に始めるエージェントのセッションから使えます。`;
		case "duplicate":
			return `「${name}」という名前の秘密は、すでにあります。置き換えるときは、削除してから追加してください。`;
		case "limit":
			return LIMIT_REACHED;
	}
}

/** Anthropicとのやり取りに失敗したときの文。理由は、/agent と同じエラーの文 */
async function failed(
	env: Env,
	userId: string,
	verb: "読み込め" | "保存でき" | "削除でき",
	error: unknown,
): Promise<string> {
	const model = agentModel(await getUserSettings(env.DB, userId));
	return `秘密を${verb}ませんでした。${describeAgentError(error, model)}`;
}

/** 一覧の画面。名前と送り先を並べ、追加のボタンと、削除する秘密を選ぶメニューを付ける */
function panel(secrets: readonly AgentSecret[]): MessageEdit {
	const lines =
		secrets.length === 0
			? [`${PANEL_HEADER}: なし`]
			: [
					PANEL_HEADER,
					...secrets.map(
						(secret) =>
							`- \`${secret.name}\`: ${secret.url} に送るときだけ使う`,
					),
				];
	const buttons: APIActionRowComponent<APIComponentInMessageActionRow> = {
		type: ComponentType.ActionRow,
		components: [
			{
				type: ComponentType.Button,
				style: ButtonStyle.Primary,
				custom_id: idOf(Action.Add),
				label: "追加",
			},
		],
	};
	return {
		content: [...lines, PANEL_NOTE].join("\n"),
		components:
			secrets.length === 0
				? [buttons]
				: [
						buttons,
						{
							type: ComponentType.ActionRow,
							components: [
								{
									type: ComponentType.StringSelect,
									custom_id: idOf(Action.Select),
									placeholder: "削除する秘密を選ぶ",
									options: secrets.map((secret) => ({
										label: secret.name,
										value: `${secret.id}:${secret.name}`,
										...(secret.url === ""
											? {}
											: { description: secret.url.slice(0, 100) }),
									})),
								},
							],
						},
					],
	};
}

function nameField(placeholder: string) {
	return {
		type: ComponentType.Label,
		label: "名前",
		description: "エージェントが使う環境変数の名前。英大文字、数字、_",
		component: {
			type: ComponentType.TextInput,
			custom_id: NAME_INPUT_ID,
			style: TextInputStyle.Short,
			placeholder,
			required: true,
			max_length: MAX_SECRET_NAME_LENGTH,
		},
	};
}

const URL_FIELD = {
	type: ComponentType.Label,
	label: "送り先",
	description: "この値を送ってよいURL。このホストへのリクエストにだけ使う",
	component: {
		type: ComponentType.TextInput,
		custom_id: URL_INPUT_ID,
		style: TextInputStyle.Short,
		placeholder: "例: https://api.example.com",
		required: true,
		max_length: 200,
	},
};

/** 「追加」の入力画面(名前・値・送り先) */
function addModal(): APIInteractionResponse {
	return {
		type: InteractionResponseType.Modal,
		data: {
			custom_id: idOf(Action.AddModal),
			title: "秘密を追加する",
			components: [
				nameField("例: WEATHER_API_KEY"),
				{
					type: ComponentType.Label,
					label: "値",
					description: "秘密の値。Anthropicに預け、Bobertには残さない",
					component: {
						type: ComponentType.TextInput,
						custom_id: VALUE_INPUT_ID,
						style: TextInputStyle.Paragraph,
						required: true,
						max_length: 4000,
					},
				},
				URL_FIELD,
			],
		},
	};
}

function idOf(action: string, ...args: string[]): string {
	return [`${AGENT_SECRETS_ID_PREFIX}${action}`, ...args].join(":");
}

function parseId(customId: string): string[] {
	return customId.slice(AGENT_SECRETS_ID_PREFIX.length).split(":");
}

function ephemeral(content: string): APIInteractionResponse {
	return {
		type: InteractionResponseType.ChannelMessageWithSource,
		data: { flags: MessageFlags.Ephemeral, content },
	};
}
