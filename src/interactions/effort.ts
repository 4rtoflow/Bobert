import type {
	APIInteractionResponse,
	APISelectMenuOption,
} from "discord-api-types/v10";
import { ComponentType } from "../discord/constants";
import { CLAUDE_EFFORTS, checkAnthropicModel } from "../llm/anthropic";
import {
	findOpenRouterModel,
	type OpenRouterModelInfo,
} from "../llm/model-info";
import type { EffortSupport } from "../llm/types";
import { logEvent } from "../log";
import {
	type ResolvedModel,
	resolveModel,
	selectedCandidate,
} from "../respond/model";
import { setupGuidance } from "../respond/replies";
import {
	getRegisteredProviders,
	getUserSettings,
	loadCredential,
	type UserSettings,
	updateUserSettings,
} from "../store/users";
import { type MessageEdit, respondLater } from "./deferred";

/** /effort のセレクトメニューのID */
export const EFFORT_SELECT_ID = "effort:select";
/** 「モデルの既定」の選択肢の値 */
const MODEL_DEFAULT_VALUE = "model_default";

/** 思考の深さの並び(浅い順)。OpenRouterのモデル情報の段階を、この順に並べる */
const EFFORT_ORDER = [
	"none",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

/** 選択肢の説明 */
const EFFORT_DESCRIPTIONS: Record<string, string> = {
	none: "考えずに答える",
	minimal: "ほとんど考えずに答える",
	low: "軽く考える。速く、安い",
	medium: "ほどほどに考える",
	high: "よく考える",
	xhigh: "さらによく考える",
	max: "いちばん深く考える。遅く、高い",
};

const MODEL_INFO_UNAVAILABLE: MessageEdit = {
	content:
		"モデルの情報を取得できませんでした。少し待ってから、もう一度試してください。",
	components: [],
};

/**
 * /effort: 今のモデルで選べる思考の深さを、セレクトメニューで本人にだけ見せる
 * (仕様: docs/spec/llm-cost.md「/effortの選択肢」)。モデル情報を取得することがあるので、保留の応答を返してから出す。
 */
export function effortCommand(
	interaction: { application_id: string; token: string },
	env: Env,
	ctx: ExecutionContext,
	userId: string,
): APIInteractionResponse {
	return respondLater(
		ctx,
		interaction,
		userId,
		"reply",
		() => effortMenu(env, userId),
		MODEL_INFO_UNAVAILABLE,
	);
}

/** メニューで選んだとき: 今のモデルで選べる段階なら保存する */
export function selectEffort(
	interaction: { application_id: string; token: string },
	env: Env,
	ctx: ExecutionContext,
	userId: string,
	value: string,
): APIInteractionResponse {
	return respondLater(
		ctx,
		interaction,
		userId,
		"update",
		() => applyEffort(env, userId, value),
		MODEL_INFO_UNAVAILABLE,
	);
}

/**
 * 本人が使うモデルで選べる思考の深さ。モデル情報を取得できなければ、例外を投げる。
 * - Claudeの候補は low〜max。既定の段階は、OpenRouter経由で呼ぶときだけ、OpenRouterのモデル情報から取る
 *   (Anthropicで直接呼ぶときの既定は、OpenRouterの既定と違うことがあるため)
 * - 「その他」で入力したClaudeは、本人のキーで、Anthropicのモデル情報から作る
 * - ほかのモデルは、OpenRouterのモデル情報から作る
 */
export async function effortSupport(
	env: Env,
	userId: string,
	settings: UserSettings,
	model: ResolvedModel,
): Promise<EffortSupport> {
	const candidate = selectedCandidate(settings);
	if (candidate?.anthropicId) {
		return {
			levels: [...CLAUDE_EFFORTS],
			defaultLevel:
				model.provider === "openrouter"
					? await openRouterDefault(candidate.openRouterId)
					: null,
		};
	}
	if (model.provider === "anthropic") {
		const credential = await loadCredential(env, userId, "anthropic");
		const check =
			credential === null
				? null
				: await checkAnthropicModel(credential, model.modelId);
		if (check?.status !== "found") {
			throw new Error(
				`Anthropic model info is unavailable: ${check?.status ?? "no credential"}`,
			);
		}
		return check.efforts;
	}
	const info = await findOpenRouterModel(model.modelId);
	return info === null
		? { levels: [], defaultLevel: null }
		: openRouterEfforts(info);
}

/** OpenRouterのモデル情報から、選べる思考の深さを取り出す */
export function openRouterEfforts(info: OpenRouterModelInfo): EffortSupport {
	const rank = (level: string) => {
		const index = EFFORT_ORDER.indexOf(level);
		return index === -1 ? EFFORT_ORDER.length : index;
	};
	return {
		levels: [...info.efforts].sort((a, b) => rank(a) - rank(b)),
		defaultLevel: info.defaultEffort,
	};
}

/** OpenRouterのモデル情報にある既定の段階。取得できなくてもClaudeの段階は選べるので、nullにする */
async function openRouterDefault(openRouterId: string): Promise<string | null> {
	try {
		return (await findOpenRouterModel(openRouterId))?.defaultEffort ?? null;
	} catch {
		return null;
	}
}

async function effortMenu(env: Env, userId: string): Promise<MessageEdit> {
	const [providers, settings] = await Promise.all([
		getRegisteredProviders(env.DB, userId),
		getUserSettings(env.DB, userId),
	]);
	const resolution = resolveModel(settings, providers);
	if (!resolution.ok) {
		return { content: setupGuidance(resolution), components: [] };
	}
	const support = await effortSupport(env, userId, settings, resolution.model);
	return menuBody(settings, resolution.model, support);
}

async function applyEffort(
	env: Env,
	userId: string,
	value: string,
): Promise<MessageEdit> {
	const [providers, settings] = await Promise.all([
		getRegisteredProviders(env.DB, userId),
		getUserSettings(env.DB, userId),
	]);
	const resolution = resolveModel(settings, providers);
	if (!resolution.ok) {
		return { content: setupGuidance(resolution), components: [] };
	}
	if (value === MODEL_DEFAULT_VALUE) {
		await updateUserSettings(env.DB, userId, { effort: null });
		log("effort_selected", { userId, effort: null });
		return {
			content: "思考の深さを「モデルの既定」に戻しました。",
			components: [],
		};
	}
	const support = await effortSupport(env, userId, settings, resolution.model);
	if (!support.levels.includes(value)) {
		// メニューを出した後に、モデルが変わった。今のモデルで出し直す
		return menuBody(settings, resolution.model, support);
	}
	await updateUserSettings(env.DB, userId, { effort: value });
	log("effort_selected", { userId, effort: value });
	return { content: `思考の深さを「${value}」に変えました。`, components: [] };
}

/** メニューを出すメッセージの中身。思考の深さを選べないモデルなら、そう知らせる */
function menuBody(
	settings: UserSettings,
	model: ResolvedModel,
	support: EffortSupport,
): MessageEdit {
	if (support.levels.length === 0) {
		return {
			content: `「${model.label}」は、思考の深さを選べません。`,
			components: [],
		};
	}
	const defaultLabel = support.defaultLevel
		? `モデルの既定(${support.defaultLevel})`
		: "モデルの既定";
	const options: APISelectMenuOption[] = [
		{
			label: defaultLabel,
			value: MODEL_DEFAULT_VALUE,
			default: settings.effort === null,
		},
		...support.levels.map((level) => ({
			label: level,
			value: level,
			...(EFFORT_DESCRIPTIONS[level]
				? { description: EFFORT_DESCRIPTIONS[level] }
				: {}),
			default: settings.effort === level,
		})),
	];
	return {
		content: `思考の深さ(effort)を選んでください。今は「${settings.effort ?? defaultLabel}」です。`,
		components: [
			{
				type: ComponentType.ActionRow,
				components: [
					{
						type: ComponentType.StringSelect,
						custom_id: EFFORT_SELECT_ID,
						placeholder: "思考の深さを選ぶ",
						options,
					},
				],
			},
		],
	};
}

function log(event: string, detail: Record<string, unknown>): void {
	logEvent("interactions", event, detail);
}
