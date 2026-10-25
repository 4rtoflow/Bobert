import { findClaudeModel, findOpenRouterModel } from "../llm/model-info";
import type { Source } from "../llm/types";
import { logEvent } from "../log";
import { loadCredential, type UserSettings } from "../store/users";
import { type ResolvedModel, selectedCandidate } from "./model";

/** 出典として書くページの数の上限 */
const MAX_SOURCES = 5;

/**
 * 本人のモデルでWeb検索を使えるか(仕様: docs/spec/behavior.md「Web検索」)。
 * - Claudeの候補は使える
 * - 「その他」で入力したClaudeは、本人のキーで、Anthropicのモデル情報から確かめる
 * - ほかのモデルは、OpenRouterのモデル情報で、道具を使えるかを確かめる(OpenRouterのWeb検索は、モデルが道具として呼ぶため)
 * 確かめられなかったときはnull。検索はしないが、「使えません」とも書かない。
 */
export async function webSearchAvailable(
	env: Env,
	userId: string,
	settings: UserSettings,
	model: ResolvedModel,
): Promise<boolean | null> {
	if (selectedCandidate(settings)?.anthropicId) {
		return true;
	}
	try {
		if (model.provider === "anthropic") {
			const credential = await loadCredential(env, userId, "anthropic");
			return credential === null
				? null
				: (await findClaudeModel(credential, model.modelId)).webSearch;
		}
		return (await findOpenRouterModel(model.modelId))?.supportsTools ?? false;
	} catch (error) {
		logEvent("respond", "web_search_check_unavailable", {
			userId,
			error: error instanceof Error ? error.message : "unknown",
		});
		return null;
	}
}

/**
 * 出典の行。返答が引用したページを、引用した順に、サイトのホスト名をリンクにして並べる。
 * リンクは「<>」で囲み、Discordに埋め込みを出させない。引用がなければnull。
 */
export function sourcesNote(sources: readonly Source[]): string | null {
	const links = sources
		.flatMap((source) => {
			const link = sourceLink(source.url);
			return link === null ? [] : [link];
		})
		.slice(0, MAX_SOURCES);
	return links.length === 0 ? null : `-# 出典: ${links.join("、")}`;
}

/** 1つの出典のリンク。httpとhttps以外のURLや、読めないURLは使わない */
function sourceLink(url: string): string | null {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		return null;
	}
	const host = parsed.hostname.startsWith("www.")
		? parsed.hostname.slice("www.".length)
		: parsed.hostname;
	// 整えたURL(href)では、リンクの書き方を崩す空白や「<」「>」が、%で始まる形に置き換わっている
	return `[${host}](<${parsed.href}>)`;
}
