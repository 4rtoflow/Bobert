import type {
	APIActionRowComponent,
	APIComponentInMessageActionRow,
	APIInteractionResponse,
	APIModalSubmitInteraction,
	APISelectMenuOption,
} from "discord-api-types/v10";
import {
	CUSTOM_MODEL_KEY,
	DEFAULT_MODEL_KEY,
	findModelCandidate,
	type ModelCandidate,
} from "../config/models";
import { editOriginalInteractionResponse } from "../discord/api";
import {
	ComponentType,
	InteractionResponseType,
	MessageFlags,
	TextInputStyle,
} from "../discord/constants";
import { checkAnthropicModel } from "../llm/anthropic";
import { findOpenRouterModel } from "../llm/model-info";
import { describeError, type ModelCheckResult } from "../llm/types";
import { logEvent } from "../log";
import {
	availableCandidates,
	customModelProvider,
	resolveModel,
	selectedCandidate,
} from "../respond/model";
import { invalidKeyMessage, setupGuidance } from "../respond/replies";
import {
	getRegisteredProviders,
	getUserSettings,
	loadCredential,
	type Provider,
	type UserSettings,
	updateUserSettings,
} from "../store/users";
import { normalizeInput, PRINTABLE_ASCII, readTextInput } from "./input";

/** /model のセレクトメニューと、「その他」のモデルIDを入力するモーダルのID */
export const MODEL_SELECT_ID = "model:select";
export const MODEL_CUSTOM_ID = "model:custom";
const MODEL_ID_INPUT_ID = "model_id";

/** モデルを確かめられなかったときの知らせ */
const CHECK_UNAVAILABLE =
	"モデルを確かめられませんでした。少し待ってから、もう一度試してください。";

/**
 * /model: 使えるモデルのセレクトメニューを本人にだけ見せる
 * (仕様: docs/spec/llm-cost.md「ユーザーごとの設定」「モデルの候補」)
 */
export async function modelCommand(
	env: Env,
	userId: string,
): Promise<APIInteractionResponse> {
	const [providers, settings] = await Promise.all([
		getRegisteredProviders(env.DB, userId),
		getUserSettings(env.DB, userId),
	]);
	return {
		type: InteractionResponseType.ChannelMessageWithSource,
		data: { flags: MessageFlags.Ephemeral, ...modelMenu(settings, providers) },
	};
}

/** メニューで選んだとき: 候補なら保存し、「その他」ならIDを入力するモーダルを開く */
export async function selectModel(
	env: Env,
	userId: string,
	value: string,
): Promise<APIInteractionResponse> {
	const [providers, settings] = await Promise.all([
		getRegisteredProviders(env.DB, userId),
		getUserSettings(env.DB, userId),
	]);
	if (value === CUSTOM_MODEL_KEY) {
		return customModelModal(settings.customModelId);
	}
	const candidate = findModelCandidate(value);
	if (!candidate) {
		// メニューを出した後に、候補の一覧が変わった。今の候補で出し直す
		return {
			type: InteractionResponseType.UpdateMessage,
			data: modelMenu(settings, providers),
		};
	}
	// 「その他」で前に入力したIDは、次にモーダルを開いたときのために残しておく
	const resolution = resolveModel(
		{ ...settings, modelKey: candidate.key },
		providers,
	);
	if (!resolution.ok) {
		// メニューを出した後に、資格情報が消された
		return updateWith(setupGuidance(resolution));
	}
	await updateUserSettings(env.DB, userId, { modelKey: candidate.key });
	log("model_selected", { userId, model: candidate.key });
	return updateWith(changedMessage(candidate.label));
}

/**
 * 「その他」のモーダルの送信: 入力されたIDのモデルがあるか確かめてから保存する。
 * 確かめるのに時間がかかることがあるので、先に保留の応答を返し、メニューのメッセージを結果で書き換える。
 */
export function submitCustomModel(
	interaction: APIModalSubmitInteraction,
	env: Env,
	ctx: ExecutionContext,
	userId: string,
): APIInteractionResponse {
	const modelId = normalizeInput(
		readTextInput(interaction, MODEL_ID_INPUT_ID) ?? "",
	);
	ctx.waitUntil(
		registerCustomModel(
			env,
			interaction.application_id,
			interaction.token,
			userId,
			modelId,
		),
	);
	return { type: InteractionResponseType.DeferredMessageUpdate };
}

/** メニューを出すメッセージの中身。資格情報を登録していなければ、メニューの代わりに登録を案内する */
function modelMenu(
	settings: UserSettings,
	providers: ReadonlySet<Provider>,
): {
	content: string;
	components: APIActionRowComponent<APIComponentInMessageActionRow>[];
} {
	const resolution = resolveModel(settings, providers);
	if (!resolution.ok && resolution.missing === "credentials") {
		return { content: setupGuidance(resolution), components: [] };
	}
	const current = resolution.ok ? resolution.model.label : resolution.label;
	// 「その他」のモデルを使っているときは、どれも選んでいない状態で出す。
	// 選んだ状態の選択肢をもう一度選んでも、Discordは知らせてこないため
	const selected = selectedCandidate(settings)?.key;
	const options: APISelectMenuOption[] = [
		...availableCandidates(providers).map((candidate) => ({
			label:
				candidate.key === DEFAULT_MODEL_KEY
					? `${candidate.label}(既定)`
					: candidate.label,
			value: candidate.key,
			description: describeCandidate(candidate),
			default: candidate.key === selected,
		})),
		{
			label: "その他",
			value: CUSTOM_MODEL_KEY,
			description: "モデルIDを入力する(例: openai/gpt-6.1-sol)",
		},
	];
	return {
		content: `使うモデルを選んでください。今は「${current}」を使っています。`,
		components: [
			{
				type: ComponentType.ActionRow,
				components: [
					{
						type: ComponentType.StringSelect,
						custom_id: MODEL_SELECT_ID,
						placeholder: "モデルを選ぶ",
						options,
					},
				],
			},
		],
	};
}

/** 選択肢の説明: 100万トークンあたりの入力 / 出力の価格と、備考 */
export function describeCandidate(candidate: ModelCandidate): string {
	const price = `$${formatPrice(candidate.price.input)} / $${formatPrice(candidate.price.output)}`;
	return candidate.note ? `${price}(${candidate.note})` : price;
}

/** 価格の書き方。整数はそのまま、それ以外は小数点以下を2桁以上にする(0.1 → 0.10、0.435 → 0.435) */
function formatPrice(value: number): string {
	if (Number.isInteger(value)) {
		return String(value);
	}
	const decimals = String(value).split(".")[1]?.length ?? 0;
	return value.toFixed(Math.max(2, decimals));
}

/** 「その他」: モデルIDを入力するモーダル。前に入力したIDがあれば入れておく */
function customModelModal(previousId: string | null): APIInteractionResponse {
	return {
		type: InteractionResponseType.Modal,
		data: {
			custom_id: MODEL_CUSTOM_ID,
			title: "モデルIDの入力",
			components: [
				{
					type: ComponentType.Label,
					label: "モデルID",
					description:
						"Claudeはclaude-で始まるID(Anthropicのキーで呼ぶ)、それ以外はOpenRouterのID",
					component: {
						type: ComponentType.TextInput,
						custom_id: MODEL_ID_INPUT_ID,
						style: TextInputStyle.Short,
						placeholder: "openai/gpt-6.1-sol",
						required: true,
						max_length: 100,
						...(previousId ? { value: previousId } : {}),
					},
				},
			],
		},
	};
}

async function registerCustomModel(
	env: Env,
	applicationId: string,
	interactionToken: string,
	userId: string,
	modelId: string,
): Promise<void> {
	let content: string;
	try {
		content = await verifyAndSaveCustomModel(env, userId, modelId);
	} catch (error) {
		log("custom_model_failed", { userId, error: errorName(error) });
		content = CHECK_UNAVAILABLE;
	}
	try {
		await editOriginalInteractionResponse(applicationId, interactionToken, {
			content,
			components: [],
		});
	} catch (error) {
		log("interaction_edit_failed", { userId, error: errorName(error) });
	}
}

/**
 * 入力されたIDのモデルがあるか確かめ、あれば保存する。本人に見せる結果の文を返す。
 * 入力されたIDは、見つからなければログに残さない(誤ってキーを貼り付けたときなどのため)。
 */
async function verifyAndSaveCustomModel(
	env: Env,
	userId: string,
	modelId: string,
): Promise<string> {
	const notFound = `モデル「${modelId}」が見つかりませんでした。IDを確かめて、もう一度入力してください。`;
	// 使えない文字が残っていると、APIに送ること自体ができない
	if (!PRINTABLE_ASCII.test(modelId)) {
		log("custom_model_malformed", { userId });
		return notFound;
	}
	const provider = customModelProvider(modelId);
	const providers = await getRegisteredProviders(env.DB, userId);
	if (!providers.has(provider)) {
		return setupGuidance({ ok: false, missing: provider, label: modelId });
	}

	const check = await checkCustomModel(env, userId, provider, modelId);
	switch (check.status) {
		case "found":
			await updateUserSettings(env.DB, userId, {
				modelKey: CUSTOM_MODEL_KEY,
				customModelId: modelId,
			});
			log("custom_model_selected", { userId, provider, model: modelId });
			return changedMessage(modelId);
		case "not_found":
			log("custom_model_not_found", { userId, provider });
			return notFound;
		case "invalid_key":
			log("custom_model_invalid_key", { userId, provider });
			return invalidKeyMessage(provider);
		case "unavailable":
			log("custom_model_check_unavailable", {
				userId,
				provider,
				detail: check.detail,
			});
			return CHECK_UNAVAILABLE;
	}
}

/** Claudeは本人のキーでAnthropicに、それ以外はOpenRouterのモデル一覧で確かめる */
async function checkCustomModel(
	env: Env,
	userId: string,
	provider: Provider,
	modelId: string,
): Promise<ModelCheckResult> {
	if (provider === "anthropic") {
		const credential = await loadCredential(env, userId, "anthropic");
		return credential === null
			? { status: "invalid_key" }
			: checkAnthropicModel(credential, modelId);
	}
	try {
		return (await findOpenRouterModel(modelId)) === null
			? { status: "not_found" }
			: { status: "found" };
	} catch (error) {
		return { status: "unavailable", detail: describeError(error) };
	}
}

function changedMessage(label: string): string {
	return `使うモデルを「${label}」に変えました。`;
}

/** メニューを出したメッセージを、文だけのメッセージに書き換える */
function updateWith(content: string): APIInteractionResponse {
	return {
		type: InteractionResponseType.UpdateMessage,
		data: { content, components: [] },
	};
}

function errorName(error: unknown): string {
	return error instanceof Error ? error.name : "unknown";
}

function log(event: string, detail: Record<string, unknown>): void {
	logEvent("interactions", event, detail);
}
