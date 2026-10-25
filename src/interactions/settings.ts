import type { APIInteractionResponse } from "discord-api-types/v10";
import { DEFAULT_EFFORT } from "../config/models";
import { availableEfforts, effectiveEffort } from "../respond/effort";
import {
	type ModelResolution,
	type ResolvedModel,
	resolveModel,
	selectedCandidate,
} from "../respond/model";
import {
	getRegisteredProviders,
	getUserSettings,
	type UserSettings,
} from "../store/users";
import { type MessageEdit, respondLater } from "./deferred";

/** 自分用の指示を見せるときの長さの上限(文字数) */
const PROMPT_PREVIEW_LENGTH = 50;

/**
 * /settings: 今の設定を、本人にだけ見せる(仕様: docs/spec/behavior.md「スラッシュコマンド」)。
 * 思考の深さは、モデル情報を見て実際に使う段階を出すので、保留の応答を返してから出す。
 */
export function settingsCommand(
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
		() => settingsMessage(env, userId),
		{
			content:
				"モデルの情報を取得できませんでした。少し待ってから、もう一度試してください。",
			components: [],
		},
	);
}

async function settingsMessage(env: Env, userId: string): Promise<MessageEdit> {
	const [providers, settings] = await Promise.all([
		getRegisteredProviders(env.DB, userId),
		getUserSettings(env.DB, userId),
	]);
	const resolution = resolveModel(settings, providers);
	const lines = [
		"今の設定です。",
		`- Anthropic: ${providers.has("anthropic") ? "登録済み" : "未登録"}`,
		`- OpenRouter: ${providers.has("openrouter") ? "連携済み" : "未連携"}`,
		`- モデル: ${modelLine(settings, resolution)}`,
		`- 思考の深さ: ${
			resolution.ok
				? await effortLine(env, userId, settings, resolution.model)
				: (settings.effort ?? `${DEFAULT_EFFORT}(既定)`)
		}`,
		`- Web検索: ${onOff(settings.featWebSearch)}`,
		`- 利用量の表示: ${onOff(settings.featUsageDisplay)}`,
		`- 画像の読み取り: ${onOff(settings.featImageInput)}`,
		`- 自分用の指示: ${promptPreview(settings.customPrompt)}`,
	];
	return { content: lines.join("\n"), components: [] };
}

/** 使うモデルと、その呼び出し先。キーが足りなければ、登録が必要だと書く */
function modelLine(
	settings: UserSettings,
	resolution: ModelResolution,
): string {
	if (resolution.ok) {
		const route =
			resolution.model.provider === "anthropic"
				? "Anthropicで直接呼ぶ"
				: "OpenRouter経由";
		return `${resolution.model.label}(${route})`;
	}
	const label =
		selectedCandidate(settings)?.label ?? settings.customModelId ?? "";
	return `${label}(\`/setup\`で登録が必要)`;
}

/** 実際に使う思考の深さ。既定の段階(lowを選べなければ、代わりに使う段階)には「(既定)」を付ける */
async function effortLine(
	env: Env,
	userId: string,
	settings: UserSettings,
	model: ResolvedModel,
): Promise<string> {
	const levels = await availableEfforts(env, userId, settings, model);
	const level = effectiveEffort(settings.effort, levels);
	if (level === null) {
		return "このモデルでは選べません";
	}
	return level === effectiveEffort(null, levels) ? `${level}(既定)` : level;
}

/** 自分用の指示の先頭。改行は空白にし、長ければ省く */
function promptPreview(prompt: string | null): string {
	if (prompt === null) {
		return "なし";
	}
	const characters = [...prompt.split("\n").join(" ")];
	return characters.length > PROMPT_PREVIEW_LENGTH
		? `${characters.slice(0, PROMPT_PREVIEW_LENGTH).join("")}…`
		: characters.join("");
}

function onOff(enabled: boolean): string {
	return enabled ? "ON" : "OFF";
}
