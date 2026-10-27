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
import { availableEfforts, openRouterEfforts } from "../respond/effort";
import {
	availableCandidates,
	customModelProvider,
	type ResolvedModel,
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
import { type MessageEdit, respondLater } from "./deferred";
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

/**
 * メニューで選んだとき: 「その他」ならIDを入力するモーダルを開き、候補なら保存する。
 * 保存した思考の深さを新しいモデルで選べるか確かめる(モデル情報の取得が要ることがある)ので、
 * 候補のときは、保留の応答を返してから、メニューのメッセージを結果で書き換える。
 */
export async function selectModel(
	interaction: { application_id: string; token: string },
	env: Env,
	ctx: ExecutionContext,
	userId: string,
	value: string,
): Promise<APIInteractionResponse> {
	if (value === CUSTOM_MODEL_KEY) {
		const settings = await getUserSettings(env.DB, userId);
		return customModelModal(settings.customModelId);
	}
	return respondLater(
		ctx,
		interaction,
		userId,
		"update",
		() => applyCandidate(env, userId, value),
		textOnly(CHECK_UNAVAILABLE),
	);
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
	return respondLater(
		ctx,
		interaction,
		userId,
		"update",
		async () => textOnly(await verifyAndSaveCustomModel(env, userId, modelId)),
		textOnly(CHECK_UNAVAILABLE),
	);
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
		content: "使うモデルを選んでください。",
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

/** メニューで選んだ候補を保存する。保存した思考の深さを新しいモデルで選べなければ、既定に戻す */
async function applyCandidate(
	env: Env,
	userId: string,
	value: string,
): Promise<MessageEdit> {
	const [providers, settings] = await Promise.all([
		getRegisteredProviders(env.DB, userId),
		getUserSettings(env.DB, userId),
	]);
	const candidate = findModelCandidate(value);
	if (!candidate) {
		// メニューを出した後に、候補の一覧が変わった。今の候補で出し直す
		return modelMenu(settings, providers);
	}
	// 「その他」で前に入力したIDは、次にモーダルを開いたときのために残しておく
	const next = { ...settings, modelKey: candidate.key };
	const resolution = resolveModel(next, providers);
	if (!resolution.ok) {
		// メニューを出した後に、資格情報が消された
		return textOnly(setupGuidance(resolution));
	}
	const resetEffort = await unsupportedEffort(
		env,
		userId,
		next,
		resolution.model,
	);
	await updateUserSettings(env.DB, userId, {
		modelKey: candidate.key,
		...(resetEffort === null ? {} : { effort: null }),
	});
	log("model_selected", {
		userId,
		model: candidate.key,
		effortReset: resetEffort !== null,
	});
	return textOnly(changedMessage(candidate.label, resetEffort));
}

/**
 * 保存した思考の深さを、新しいモデルで選べなければ、その段階を返す(既定に戻すため)。
 * モデル情報を取得できず、確かめられなかったときは、そのままにする。
 */
async function unsupportedEffort(
	env: Env,
	userId: string,
	settings: UserSettings,
	model: ResolvedModel,
): Promise<string | null> {
	const effort = settings.effort;
	if (effort === null) {
		return null;
	}
	try {
		const levels = await availableEfforts(env, userId, settings, model);
		return levels.includes(effort) ? null : effort;
	} catch (error) {
		log("effort_check_unavailable", {
			userId,
			error: error instanceof Error ? error.name : "unknown",
		});
		return null;
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
	const [providers, settings] = await Promise.all([
		getRegisteredProviders(env.DB, userId),
		getUserSettings(env.DB, userId),
	]);
	if (!providers.has(provider)) {
		return setupGuidance({ ok: false, missing: provider, label: modelId });
	}

	const check = await checkCustomModel(env, userId, provider, modelId);
	switch (check.status) {
		case "found": {
			// 保存した思考の深さを、このモデルで選べなければ、既定に戻す
			const resetEffort =
				settings.effort !== null && !check.efforts.includes(settings.effort)
					? settings.effort
					: null;
			await updateUserSettings(env.DB, userId, {
				modelKey: CUSTOM_MODEL_KEY,
				customModelId: modelId,
				...(resetEffort === null ? {} : { effort: null }),
			});
			log("custom_model_selected", {
				userId,
				provider,
				model: modelId,
				effortReset: resetEffort !== null,
			});
			return changedMessage(modelId, resetEffort);
		}
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
		const info = await findOpenRouterModel(modelId);
		return info === null
			? { status: "not_found" }
			: {
					status: "found",
					efforts: openRouterEfforts(info),
					webSearch: info.supportsTools,
					maxInputTokens: info.contextLength,
				};
	} catch (error) {
		return { status: "unavailable", detail: describeError(error) };
	}
}

/** モデルを変えたときの知らせ。思考の深さを既定に戻したときは、そのことも書く */
function changedMessage(label: string, resetEffort: string | null): string {
	const changed = `使うモデルを「${label}」に変えました。`;
	return resetEffort === null
		? changed
		: `${changed}このモデルでは思考の深さ「${resetEffort}」を選べないため、既定に戻しました。`;
}

/** 文だけのメッセージにする(メニューを消す) */
function textOnly(content: string): MessageEdit {
	return { content, components: [] };
}

function log(event: string, detail: Record<string, unknown>): void {
	logEvent("interactions", event, detail);
}
