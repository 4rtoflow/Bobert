import type {
	APIInteractionResponse,
	APIModalSubmitInteraction,
	APIUser,
} from "discord-api-types/v10";
import { editOriginalInteractionResponse } from "../discord/api";
import {
	ButtonStyle,
	ComponentType,
	InteractionResponseType,
	MessageFlags,
	TextInputStyle,
} from "../discord/constants";
import { type AnthropicCredential, checkAnthropicKey } from "../llm/anthropic";
import type { KeyCheckResult } from "../llm/types";
import { logEvent } from "../log";
import { createOpenRouterAuthLink } from "../oauth/openrouter";
import { getRegisteredProviders, saveCredential } from "../store/users";

/** 「Anthropicのキーを登録」ボタンと、キーを入力するモーダルのID */
export const SETUP_ANTHROPIC_ID = "setup:anthropic";
const API_KEY_INPUT_ID = "api_key";
const WORKSPACE_INPUT_ID = "workspace_id";

/** Claude Consoleの、ワークスペースの一覧のページ(ID列でワークスペースIDを確かめられる) */
const WORKSPACES_URL = "https://platform.claude.com/settings/workspaces";

/**
 * /setup: 登録の状態と、登録・連携のボタンを本人にだけ見せる
 * (仕様: docs/spec/llm-cost.md「資格情報の登録・保存・削除」)
 */
export async function setupCommand(
	env: Env,
	origin: string,
	user: APIUser,
): Promise<APIInteractionResponse> {
	const [providers, openRouterLink] = await Promise.all([
		getRegisteredProviders(env.DB, user.id),
		createOpenRouterAuthLink(env, origin, user),
	]);
	const anthropic = providers.has("anthropic");
	const openRouter = providers.has("openrouter");
	return {
		type: InteractionResponseType.ChannelMessageWithSource,
		data: {
			flags: MessageFlags.Ephemeral,
			content: [
				"Bobertで使うプロバイダを登録します。",
				"",
				`- Anthropic: ${anthropic ? "登録済み" : "未登録"}`,
				`- OpenRouter: ${openRouter ? "連携済み" : "未連携"}`,
				"",
				"-# OpenRouterとの連携のリンクは10分間有効です。",
			].join("\n"),
			components: [
				{
					type: ComponentType.ActionRow,
					components: [
						{
							type: ComponentType.Button,
							style: ButtonStyle.Primary,
							custom_id: SETUP_ANTHROPIC_ID,
							label: anthropic
								? "Anthropicのキーを登録し直す"
								: "Anthropicのキーを登録",
						},
						{
							type: ComponentType.Button,
							style: ButtonStyle.Link,
							url: openRouterLink,
							label: openRouter ? "OpenRouterと連携し直す" : "OpenRouterと連携",
						},
					],
				},
			],
		},
	};
}

/** 「Anthropicのキーを登録」ボタン: キーを入力するモーダルを開く */
export function anthropicKeyModal(): APIInteractionResponse {
	return {
		type: InteractionResponseType.Modal,
		data: {
			custom_id: SETUP_ANTHROPIC_ID,
			title: "AnthropicのAPIキーの登録",
			components: [
				{
					type: ComponentType.Label,
					label: "APIキー",
					description: "Claude Consoleで発行したキー(sk-ant-で始まる)",
					component: {
						type: ComponentType.TextInput,
						custom_id: API_KEY_INPUT_ID,
						style: TextInputStyle.Short,
						placeholder: "sk-ant-...",
						required: true,
						min_length: 10,
						max_length: 200,
					},
				},
				{
					type: ComponentType.Label,
					label: "ワークスペースID(任意)",
					description:
						"キーがワークスペースに属していないとき(個人キーなど)に入力する。wrkspc_で始まる",
					component: {
						type: ComponentType.TextInput,
						custom_id: WORKSPACE_INPUT_ID,
						style: TextInputStyle.Short,
						placeholder: "wrkspc_...",
						required: false,
						max_length: 100,
					},
				},
			],
		},
	};
}

/**
 * モーダルの送信: キーが有効か確かめてから保存する。
 * 確かめるのに時間がかかることがあるので、先に保留の応答を返し、結果で書き換える。
 */
export function submitAnthropicKey(
	interaction: APIModalSubmitInteraction,
	env: Env,
	ctx: ExecutionContext,
	userId: string,
): APIInteractionResponse {
	const apiKey = normalizeCredentialInput(
		readTextInput(interaction, API_KEY_INPUT_ID) ?? "",
	);
	const workspaceId = normalizeCredentialInput(
		readTextInput(interaction, WORKSPACE_INPUT_ID) ?? "",
	);
	ctx.waitUntil(
		registerAnthropicKey(
			env,
			interaction.application_id,
			interaction.token,
			userId,
			{ apiKey, workspaceId: workspaceId === "" ? null : workspaceId },
		),
	);
	return {
		type: InteractionResponseType.DeferredChannelMessageWithSource,
		data: { flags: MessageFlags.Ephemeral },
	};
}

async function registerAnthropicKey(
	env: Env,
	applicationId: string,
	interactionToken: string,
	userId: string,
	credential: AnthropicCredential,
): Promise<void> {
	let content: string;
	try {
		content = await verifyAndSave(env, userId, credential);
	} catch (error) {
		log("anthropic_key_register_failed", { userId, error: errorName(error) });
		content =
			"登録中にエラーが起きました。少し待ってから、もう一度試してください。";
	}
	try {
		await editOriginalInteractionResponse(applicationId, interactionToken, {
			content,
		});
	} catch (error) {
		log("interaction_edit_failed", { userId, error: errorName(error) });
	}
}

/** キーが使えるか確かめ、使えれば保存する。本人に見せる結果の文を返す */
async function verifyAndSave(
	env: Env,
	userId: string,
	credential: AnthropicCredential,
): Promise<string> {
	const { apiKey, workspaceId } = credential;
	// 使えない文字が残っていると、APIに送ること自体ができない
	if (!PRINTABLE_ASCII.test(apiKey)) {
		log("anthropic_key_malformed", { userId, key: keyShape(apiKey) });
		return "キーに使えない文字が含まれています。Claude Consoleでコピーし直して、もう一度登録してください。";
	}
	if (workspaceId !== null && !PRINTABLE_ASCII.test(workspaceId)) {
		log("anthropic_workspace_malformed", { userId });
		return "ワークスペースIDに使えない文字が含まれています。Claude Consoleでコピーし直して、もう一度登録してください。";
	}

	const check: KeyCheckResult = await checkAnthropicKey(credential);
	const key = keyShape(apiKey);
	switch (check.status) {
		case "valid":
			await saveCredential(env, userId, "anthropic", credential);
			log("anthropic_key_registered", {
				userId,
				withWorkspace: workspaceId !== null,
			});
			return "AnthropicのAPIキーを登録しました。Bobertにメンションして話しかけてみてください。";
		case "invalid":
			log("anthropic_key_rejected", { userId, key });
			return "このAPIキーは使えませんでした。キーを確かめて、もう一度登録してください。";
		case "needs_workspace":
			log("anthropic_key_needs_workspace", { userId, key });
			return [
				"このキーはワークスペースに属していないため、使うワークスペースのIDも必要です。",
				`Claude ConsoleのWorkspacesのページ(<${WORKSPACES_URL}>)のID列で確かめて、キーと一緒に入力してください。`,
				"ワークスペースを指定して作ったキーなら、IDは要りません。",
			].join("\n");
		case "workspace_not_found":
			log("anthropic_workspace_not_found", { userId, key });
			return "ワークスペースIDが正しくないか、このキーではそのワークスペースを使えません。IDを確かめて、もう一度登録してください。";
		case "unavailable":
			log("anthropic_key_check_unavailable", {
				userId,
				key,
				detail: check.detail,
			});
			return "キーを確かめられませんでした。少し待ってから、もう一度登録してください。";
	}
}

/** モーダルで入力された値を読む */
function readTextInput(
	interaction: APIModalSubmitInteraction,
	customId: string,
): string | undefined {
	for (const component of interaction.data.components) {
		if (
			component.type === ComponentType.Label &&
			component.component.type === ComponentType.TextInput &&
			component.component.custom_id === customId
		) {
			return component.component.value;
		}
	}
	return undefined;
}

/** APIキーに使われる文字(空白を除く、表示できるASCII文字) */
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;

/**
 * 入力されたキーやワークスペースIDを整える。全角の英数字は半角にし、空白と見えない文字(ゼロ幅スペースなど)は取り除く。
 * コピーしたときや、日本語入力のままで入力したときに混ざることがあるため。
 */
export function normalizeCredentialInput(input: string): string {
	return input.normalize("NFKC").replace(/[\s\u200b-\u200d\u2060\ufeff]/g, "");
}

/**
 * 入力されたキーの形(調査用)。キーそのものは残さず、長さと、キーの種類を表す先頭の部分
 * (sk-ant-api など)と、表示できるASCII文字だけでできているかを残す。
 */
function keyShape(apiKey: string) {
	return {
		length: apiKey.length,
		prefix: apiKey.startsWith("sk-ant-") ? apiKey.slice(0, 10) : "(other)",
		printableAscii: PRINTABLE_ASCII.test(apiKey),
	};
}

function errorName(error: unknown): string {
	return error instanceof Error ? error.name : "unknown";
}

function log(event: string, detail: Record<string, unknown>): void {
	logEvent("interactions", event, detail);
}
