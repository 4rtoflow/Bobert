import { MAX_WEB_SEARCHES } from "../config/models";
import {
	type ChatMessage,
	type ChatRequest,
	type ChatResult,
	describeError,
	LlmError,
	type LlmErrorKind,
	type Source,
} from "./types";

const OPENROUTER_API_BASE = "https://openrouter.ai/api/v1";

/** OpenRouterのサイトでの、アプリの表示(任意のヘッダー) */
const APP_HEADERS = {
	"HTTP-Referer": "https://github.com/4rtoflow/Bobert",
	"X-Title": "Bobert",
};

interface OpenRouterError {
	code?: number;
	message?: string;
}

interface OpenRouterResponse {
	choices?: {
		message?: {
			content?: string | null;
			/** Web検索の結果から引用したページ */
			annotations?: {
				type?: string;
				url_citation?: { url?: string; title?: string };
			}[];
		};
		finish_reason?: string | null;
		error?: OpenRouterError;
	}[];
	usage?: {
		/** 入力のトークン数。キャッシュの分を含む */
		prompt_tokens?: number;
		completion_tokens?: number;
		/** 費用(OpenRouterのクレジット。1クレジットは1ドル)。応答にいつも含まれる */
		cost?: number;
		prompt_tokens_details?: {
			cached_tokens?: number;
			cache_write_tokens?: number;
		};
		/** Web検索の回数。どちらの場所に入るかは、ドキュメントに書かれていないので両方を見る */
		server_tool_use?: { web_search_requests?: number };
		web_search_requests?: number;
	};
	error?: OpenRouterError;
}

/**
 * ユーザーのOpenRouterのキーで、モデルを呼ぶ。
 * 会話には他の人の発言も含まれるので、データを保存・学習しない提供元だけを使う
 * (仕様: docs/spec/llm-cost.md「対応する資格情報」)。
 */
export async function chatWithOpenRouter(
	apiKey: string,
	request: ChatRequest,
): Promise<ChatResult> {
	const body = {
		model: request.model,
		max_tokens: request.maxTokens,
		messages: [
			{ role: "system", content: request.system.join("\n\n") },
			...request.messages.map(toOpenRouterMessage),
		],
		provider: { data_collection: "deny" },
		// Claudeは指定したときだけキャッシュが効く。ほかの多くのモデルは自動で効く
		...(request.model.startsWith("anthropic/")
			? { cache_control: { type: "ephemeral" } }
			: {}),
		...(request.effort !== null
			? { reasoning: { effort: request.effort } }
			: {}),
		// Web検索はOpenRouterのサーバーで動く。1回の返答で使える回数に上限を設ける
		...(request.webSearch
			? {
					tools: [
						{ type: "openrouter:web_search", parameters: { max_results: 5 } },
					],
					max_tool_calls: MAX_WEB_SEARCHES,
				}
			: {}),
	};

	let response: Response;
	try {
		response = await fetch(`${OPENROUTER_API_BASE}/chat/completions`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
				...APP_HEADERS,
			},
			body: JSON.stringify(body),
		});
	} catch (error) {
		throw new LlmError(
			"unavailable",
			null,
			"connection failed",
			describeError(error),
		);
	}
	const data = (await response
		.json()
		.catch(() => null)) as OpenRouterResponse | null;

	// 生成が始まった後のエラーは、ステータス200のまま本文のerrorに入る
	const error = data?.error ?? data?.choices?.[0]?.error;
	if (!response.ok || error) {
		const status = error?.code ?? response.status;
		throw new LlmError(
			kindFromStatus(status),
			status,
			`OpenRouter error ${status}`,
		);
	}
	const choice = data?.choices?.[0];
	if (!choice) {
		throw new LlmError(
			"unknown",
			response.status,
			"OpenRouter returned no choices",
		);
	}

	return {
		text: choice.message?.content ?? "",
		stopReason:
			choice.finish_reason === "length"
				? "max_tokens"
				: choice.finish_reason === "content_filter"
					? "refusal"
					: "end",
		usage: {
			inputTokens: data?.usage?.prompt_tokens ?? 0,
			outputTokens: data?.usage?.completion_tokens ?? 0,
			cacheReadTokens: data?.usage?.prompt_tokens_details?.cached_tokens ?? 0,
			cacheWriteTokens:
				data?.usage?.prompt_tokens_details?.cache_write_tokens ?? 0,
			webSearchRequests:
				data?.usage?.server_tool_use?.web_search_requests ??
				data?.usage?.web_search_requests ??
				0,
			costUsd: typeof data?.usage?.cost === "number" ? data.usage.cost : null,
		},
		sources: sourcesOf(choice.message?.annotations ?? []),
	};
}

/** Web検索の結果から引用したページ(出典)。同じURLは1つにまとめる */
function sourcesOf(
	annotations: NonNullable<
		NonNullable<
			NonNullable<OpenRouterResponse["choices"]>[number]["message"]
		>["annotations"]
	>,
): Source[] {
	const sources = new Map<string, Source>();
	for (const annotation of annotations) {
		const url = annotation.url_citation?.url;
		if (annotation.type === "url_citation" && url && !sources.has(url)) {
			sources.set(url, { url, title: annotation.url_citation?.title ?? null });
		}
	}
	return [...sources.values()];
}

/** OAuth(PKCE)のcodeを、ユーザー本人のAPIキーと交換する */
export async function exchangeOpenRouterCode(
	code: string,
	codeVerifier: string,
): Promise<string> {
	const response = await fetch(`${OPENROUTER_API_BASE}/auth/keys`, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...APP_HEADERS },
		body: JSON.stringify({
			code,
			code_verifier: codeVerifier,
			code_challenge_method: "S256",
		}),
	});
	if (!response.ok) {
		throw new Error(
			`OpenRouter key exchange failed with status ${response.status}`,
		);
	}
	const data = (await response.json()) as { key?: string };
	if (!data.key) {
		throw new Error("OpenRouter key exchange returned no key");
	}
	return data.key;
}

function toOpenRouterMessage(message: ChatMessage) {
	const texts = message.parts.flatMap((part) =>
		part.type === "text" ? [part.text] : [],
	);
	if (texts.length === message.parts.length) {
		return { role: message.role, content: texts.join("\n\n") };
	}
	return {
		role: message.role,
		content: message.parts.map((part) =>
			part.type === "text"
				? { type: "text", text: part.text }
				: { type: "image_url", image_url: { url: part.url } },
		),
	};
}

/** OpenRouterのエラーコード(HTTPのステータスと同じ)を、失敗の種類に分ける */
function kindFromStatus(status: number): LlmErrorKind {
	switch (status) {
		case 400:
			return "bad_request";
		case 401:
			return "invalid_key";
		case 402:
			return "insufficient_credit";
		case 403:
			return "forbidden";
		case 404:
			return "model_not_found";
		case 413:
			return "too_large";
		case 429:
			return "rate_limited";
		case 408:
		case 502:
			return "unavailable";
		// 条件(学習に使わない提供元)に合う提供元がない
		case 503:
			return "no_provider";
		default:
			return status >= 500 ? "unavailable" : "unknown";
	}
}
