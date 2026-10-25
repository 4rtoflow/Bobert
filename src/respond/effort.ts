import { DEFAULT_EFFORT } from "../config/models";
import { CLAUDE_EFFORTS } from "../llm/anthropic";
import {
	findClaudeEfforts,
	findOpenRouterModel,
	type OpenRouterModelInfo,
} from "../llm/model-info";
import { logEvent } from "../log";
import { loadCredential, type UserSettings } from "../store/users";
import { type ResolvedModel, selectedCandidate } from "./model";

/** 思考の深さの並び(浅い順)。段階を並べるときと、いちばん近い段階を選ぶときに使う */
const EFFORT_ORDER = [
	"none",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

/**
 * 本人が使うモデルで選べる思考の深さ(浅い順)。空なら選べない。モデル情報を取得できなければ、例外を投げる
 * (仕様: docs/spec/llm-cost.md「/effortの選択肢」)。
 * - Claudeの候補は low〜max
 * - 「その他」で入力したClaudeは、本人のキーで、Anthropicのモデル情報から作る
 * - ほかのモデルは、OpenRouterのモデル情報から作る
 */
export async function availableEfforts(
	env: Env,
	userId: string,
	settings: UserSettings,
	model: ResolvedModel,
): Promise<string[]> {
	if (selectedCandidate(settings)?.anthropicId) {
		return [...CLAUDE_EFFORTS];
	}
	if (model.provider === "anthropic") {
		const credential = await loadCredential(env, userId, "anthropic");
		if (credential === null) {
			throw new Error("Anthropic credential is missing");
		}
		return findClaudeEfforts(credential, model.modelId);
	}
	const info = await findOpenRouterModel(model.modelId);
	return info === null ? [] : openRouterEfforts(info);
}

/** OpenRouterのモデル情報の段階を、浅い順に並べる */
export function openRouterEfforts(info: OpenRouterModelInfo): string[] {
	return [...info.efforts].sort((a, b) => effortRank(a) - effortRank(b));
}

/**
 * 実際に使う思考の深さ。選んだ段階(選んでいなければ既定の段階)を、モデルが選べなければ、いちばん近い段階にする。
 * 近さが同じなら浅い方にする。none(考えない)は、ほかに選べる段階がないときだけ使う。
 * 選べる段階がなければnull。
 */
export function effectiveEffort(
	chosen: string | null,
	levels: readonly string[],
): string | null {
	const target = chosen ?? DEFAULT_EFFORT;
	if (levels.includes(target)) {
		return target;
	}
	const thinking = levels.filter((level) => level !== "none");
	const candidates = thinking.length > 0 ? thinking : levels;
	const distance = (level: string) =>
		Math.abs(effortRank(level) - effortRank(target));
	return (
		[...candidates].sort(
			(a, b) => distance(a) - distance(b) || effortRank(a) - effortRank(b),
		)[0] ?? null
	);
}

/**
 * 返答に使う思考の深さ。モデルで選べる段階を確かめてから決める。
 * モデル情報を取得できなければ、本人が選んだ段階をそのまま使う(選んでいなければ送らない)。
 */
export async function replyEffort(
	env: Env,
	userId: string,
	settings: UserSettings,
	model: ResolvedModel,
): Promise<string | null> {
	try {
		return effectiveEffort(
			settings.effort,
			await availableEfforts(env, userId, settings, model),
		);
	} catch (error) {
		logEvent("respond", "effort_check_unavailable", {
			userId,
			error: error instanceof Error ? error.message : "unknown",
		});
		return settings.effort;
	}
}

/** 浅い順の番号。知らない段階は、いちばん深いものとして扱う */
function effortRank(level: string): number {
	const index = EFFORT_ORDER.indexOf(level);
	return index === -1 ? EFFORT_ORDER.length : index;
}
