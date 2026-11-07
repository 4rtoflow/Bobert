import { type ResolvedModel, resolveModel } from "../respond/model";
import {
	DEFAULT_USER_SETTINGS,
	getRegisteredProviders,
	loadCredential,
} from "../store/users";
import { chatWithAnthropic } from "./anthropic";
import { chatWithOpenRouter } from "./openrouter";
import type { ChatRequest, ChatResult } from "./types";

/** 本人のキーで呼ぶモデルと、その呼び出し */
export interface OwnKeyModel {
	resolved: ResolvedModel;
	call: (request: ChatRequest) => Promise<ChatResult>;
}

/**
 * 本人のキーで、決まったモデル(候補の一覧のキー)を呼ぶ準備をする。寄付は使わない
 * (記憶のまとめと、知識のファイルの要約。本人がその場で頼んでいないのにAIを呼ぶため)。
 * Anthropicのキーがあれば直接、なければOpenRouter経由で呼ぶ。呼べるキーがなければnull
 */
export async function ownKeyModel(
	env: Env,
	userId: string,
	modelKey: string,
): Promise<OwnKeyModel | null> {
	const providers = await getRegisteredProviders(env.DB, userId);
	const resolution = resolveModel(
		{ ...DEFAULT_USER_SETTINGS, modelKey },
		providers,
	);
	if (!resolution.ok) {
		return null;
	}
	const resolved = resolution.model;
	const credential = await loadCredential(env, userId, resolved.provider);
	if (credential === null) {
		return null;
	}
	return {
		resolved,
		call: (request) =>
			resolved.provider === "anthropic"
				? chatWithAnthropic(credential, request)
				: chatWithOpenRouter(credential.apiKey, request),
	};
}
