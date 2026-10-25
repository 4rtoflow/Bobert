import type {
	APIInteractionResponse,
	APISelectMenuOption,
} from "discord-api-types/v10";
import { ComponentType } from "../discord/constants";
import { logEvent } from "../log";
import { availableEfforts, effectiveEffort } from "../respond/effort";
import { type ResolvedModel, resolveModel } from "../respond/model";
import { setupGuidance } from "../respond/replies";
import {
	getRegisteredProviders,
	getUserSettings,
	type UserSettings,
	updateUserSettings,
} from "../store/users";
import { type MessageEdit, respondLater } from "./deferred";

/** /effort のセレクトメニューのID */
export const EFFORT_SELECT_ID = "effort:select";

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

async function effortMenu(env: Env, userId: string): Promise<MessageEdit> {
	const [providers, settings] = await Promise.all([
		getRegisteredProviders(env.DB, userId),
		getUserSettings(env.DB, userId),
	]);
	const resolution = resolveModel(settings, providers);
	if (!resolution.ok) {
		return { content: setupGuidance(resolution), components: [] };
	}
	const levels = await availableEfforts(
		env,
		userId,
		settings,
		resolution.model,
	);
	return menuBody(settings, resolution.model, levels);
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
	const levels = await availableEfforts(
		env,
		userId,
		settings,
		resolution.model,
	);
	if (!levels.includes(value)) {
		// メニューを出した後に、モデルが変わった。今のモデルで出し直す
		return menuBody(settings, resolution.model, levels);
	}
	// 既定の段階を選んだら、設定を消して既定に従う。モデルを変えても、そのモデルの既定の段階を使えるようにするため
	const effort = value === effectiveEffort(null, levels) ? null : value;
	await updateUserSettings(env.DB, userId, { effort });
	log("effort_selected", { userId, effort });
	return { content: `思考の深さを「${value}」に変えました。`, components: [] };
}

/**
 * メニューを出すメッセージの中身。思考の深さを選べないモデルなら、そう知らせる。
 * 既定の段階(モデルが選べなければ、代わりに使う段階)に「(既定)」を付け、今使う段階を選んだ状態で出す。
 */
function menuBody(
	settings: UserSettings,
	model: ResolvedModel,
	levels: readonly string[],
): MessageEdit {
	if (levels.length === 0) {
		return {
			content: `「${model.label}」は、思考の深さを選べません。`,
			components: [],
		};
	}
	const defaultLevel = effectiveEffort(null, levels);
	const selected = effectiveEffort(settings.effort, levels);
	const options: APISelectMenuOption[] = levels.map((level) => ({
		label: level === defaultLevel ? `${level}(既定)` : level,
		value: level,
		...(EFFORT_DESCRIPTIONS[level]
			? { description: EFFORT_DESCRIPTIONS[level] }
			: {}),
		default: level === selected,
	}));
	return {
		content: "思考の深さ(effort)を選んでください。",
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
