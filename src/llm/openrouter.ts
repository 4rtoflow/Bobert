import {
	MAX_FILE_READS,
	MAX_SKILL_READS,
	MAX_TOOL_CALLS,
	MAX_WEB_SEARCHES,
} from "../config/models";
import {
	countsTowardLimit,
	FILES_REJECTED,
	runChatTool,
	TOOL_LIMIT_REACHED,
	type ToolOutcome,
} from "./tools";
import {
	type ChatFile,
	type ChatMessage,
	type ChatRequest,
	type ChatResult,
	type ChatTool,
	describeError,
	LlmError,
	type LlmErrorKind,
	type Source,
	sumUsage,
	type TokenUsage,
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
			/** AIが呼んだBobertの道具 */
			tool_calls?: ToolCall[];
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
 * 1回の返答で、AIとやり取りする回数の上限。道具の結果を返すときに数える。
 * スキルを読む分とファイルを読む分は、道具の呼び出しの上限とは別に数えるので、その回数を足す
 */
const MAX_ROUNDS = 10 + MAX_SKILL_READS + MAX_FILE_READS;

/** 道具の結果で読んだ画像とPDFを、道具の結果の後に人の発言として渡すときの、前置き */
const TOOL_FILES_INTRO = "(ファイルを読む道具で読んだファイルです)";

/** 画像やPDFを読んだ道具の結果に書き足す文。OpenRouterでは、道具の結果に文しか入れられないため */
const FILES_ATTACHED_BELOW = "(このファイルは、この後の発言に添付しました)";

/**
 * PDFを渡すときの読み取り方。モデルが直接読む(native)に決める。
 * 指定しないと、モデルが読めなかったときに、有料の読み取り(mistral-ocr)が使われるため
 */
const NATIVE_PDF_PLUGIN = { id: "file-parser", pdf: { engine: "native" } };

/** 発言の中身の1つ(文、画像、PDF) */
type OpenRouterContentPart =
	| { type: "text"; text: string }
	| { type: "image_url"; image_url: { url: string } }
	| { type: "file"; file: { filename: string; file_data: string } };

/** 道具の結果。中身は文だけ */
interface OpenRouterToolMessage {
	role: "tool";
	tool_call_id: string;
	content: string;
}

/** OpenRouterに送る会話の1件 */
type OpenRouterMessage =
	| { role: "user" | "assistant"; content: string | OpenRouterContentPart[] }
	| { role: "system"; content: string }
	| { role: "assistant"; content: string | null; tool_calls: ToolCall[] }
	| OpenRouterToolMessage;

/** AIが呼んだ道具 */
interface ToolCall {
	id: string;
	type?: string;
	function?: { name?: string; arguments?: string };
}

/**
 * ユーザーのOpenRouterのキーで、モデルを呼ぶ。
 * 会話には他の人の発言も含まれるので、データを保存・学習しない提供元だけを使う
 * (仕様: docs/spec/llm-cost.md「対応する資格情報」)。
 * Bobertの道具をAIが呼んだら、実行して結果を返し、続きを頼む。呼び出しが上限に達したら、道具を使わずに答えさせる。
 */
export async function chatWithOpenRouter(
	apiKey: string,
	request: ChatRequest,
): Promise<ChatResult> {
	const messages: OpenRouterMessage[] = [
		{ role: "system", content: request.system.join("\n\n") },
		...request.messages.map(toOpenRouterMessage),
	];
	// 道具の定義は、毎回同じ並びにする(キャッシュのため)。Bobertの道具、Web検索の順
	const tools = [
		...request.tools.map(toOpenRouterTool),
		// Web検索はOpenRouterのサーバーで動く
		...(request.webSearch
			? [{ type: "openrouter:web_search", parameters: { max_results: 5 } }]
			: []),
	];
	const responses: OpenRouterResponse[] = [];
	/** 最後の答えが始まる応答。道具の結果を返したら、その次の応答から数え直す */
	let answerFrom = 0;
	let toolCalls = 0;
	/**
	 * 最後に返した道具の結果のうち、画像やPDFを、後の人の発言に添付したもの(textは、道具の結果の文)。
	 * 受け付けられたら空にする
	 */
	let withFiles: { message: OpenRouterToolMessage; text: string }[] = [];
	const send = () =>
		post(apiKey, {
			model: request.model,
			max_tokens: request.maxTokens,
			messages,
			provider: { data_collection: "deny" },
			// Claudeは指定したときだけキャッシュが効く。ほかの多くのモデルは自動で効く
			...(request.model.startsWith("anthropic/")
				? { cache_control: { type: "ephemeral" } }
				: {}),
			...(request.effort !== null
				? { reasoning: { effort: request.effort } }
				: {}),
			...(tools.length > 0 ? { tools } : {}),
			// 1回の返答で、Web検索を使える回数に上限を設ける
			...(request.webSearch ? { max_tool_calls: MAX_WEB_SEARCHES } : {}),
			...(request.tools.length > 0 && toolCalls >= MAX_TOOL_CALLS
				? { tool_choice: "none" }
				: {}),
			...(messages.some(hasPdf) ? { plugins: [NATIVE_PDF_PLUGIN] } : {}),
		});
	while (responses.length < MAX_ROUNDS) {
		let data: OpenRouterResponse;
		try {
			data = await send();
		} catch (error) {
			// 道具の結果で読んだファイルを、受け付けなかった(大きすぎる、壊れている、パスワード付きなど)。
			// 1つのファイルのために返答全体が失敗しないよう、そのファイルを外して、1回だけ送り直す。
			// 道具の結果の後の人の発言ごと外すので、その形を受け付けないモデルでも答えられる
			if (!filesRejected(error) || withFiles.length === 0) {
				throw error;
			}
			messages.pop();
			for (const { message, text } of withFiles) {
				message.content = `${text}\n${FILES_REJECTED}`;
			}
			withFiles = [];
			data = await send();
		}
		withFiles = [];
		responses.push(data);
		const choice = data.choices?.[0];
		const calls = choice?.message?.tool_calls ?? [];
		if (choice?.finish_reason !== "tool_calls" || calls.length === 0) {
			break;
		}
		messages.push({
			role: "assistant",
			content: choice.message?.content ?? null,
			tool_calls: calls,
		});
		const files: ToolOutcome["files"] = [];
		for (const call of calls) {
			// スキルを読む道具とファイルを読む道具は、上限に数えない(道具が自分で回数を数える)
			const name = call.function?.name ?? "";
			const counted = countsTowardLimit(request.tools, name);
			const outcome =
				!counted || toolCalls < MAX_TOOL_CALLS
					? await runChatTool(
							request.tools,
							name,
							parseArguments(call.function?.arguments),
						)
					: TOOL_LIMIT_REACHED;
			if (counted) {
				toolCalls++;
			}
			const message: OpenRouterToolMessage = {
				role: "tool",
				tool_call_id: call.id,
				content:
					outcome.files.length === 0
						? outcome.content
						: `${outcome.content}\n${FILES_ATTACHED_BELOW}`,
			};
			messages.push(message);
			if (outcome.files.length > 0) {
				files.push(...outcome.files);
				withFiles.push({ message, text: outcome.content });
			}
		}
		// 道具の結果(role: "tool")には文しか入れられないので、画像とPDFは、すぐ後の人の発言で渡す
		if (files.length > 0) {
			messages.push({
				role: "user",
				content: [
					{ type: "text", text: TOOL_FILES_INTRO },
					...files.flatMap(({ label, file }): OpenRouterContentPart[] => [
						{ type: "text", text: `${label}:` },
						toContentPart(file),
					]),
				],
			});
		}
		answerFrom = responses.length;
	}

	const finishReason = responses.at(-1)?.choices?.[0]?.finish_reason;
	const requestUsages = responses.map((data) => usageOf(data.usage));
	return {
		// 道具を呼ぶ前の前置き(「調べます」など)は、答えに入れない
		text: responses
			.slice(answerFrom)
			.map((data) => data.choices?.[0]?.message?.content ?? "")
			.join(""),
		stopReason:
			finishReason === "length"
				? "max_tokens"
				: finishReason === "content_filter"
					? "refusal"
					: "end",
		usage: sumUsage(requestUsages),
		requestUsages,
		sources: sourcesOf(
			responses.flatMap(
				(data) => data.choices?.[0]?.message?.annotations ?? [],
			),
		),
		toolCalls,
	};
}

/** 1回分を送る。失敗は、種類に分けて例外にする */
async function post(
	apiKey: string,
	body: unknown,
): Promise<OpenRouterResponse> {
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
	if (!data?.choices?.[0]) {
		throw new LlmError(
			"unknown",
			response.status,
			"OpenRouter returned no choices",
		);
	}
	return data;
}

/** 使ったトークン数と費用 */
function usageOf(usage: OpenRouterResponse["usage"]): TokenUsage {
	return {
		inputTokens: usage?.prompt_tokens ?? 0,
		outputTokens: usage?.completion_tokens ?? 0,
		cacheReadTokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
		cacheWriteTokens: usage?.prompt_tokens_details?.cache_write_tokens ?? 0,
		webSearchRequests:
			usage?.server_tool_use?.web_search_requests ??
			usage?.web_search_requests ??
			0,
		costUsd: typeof usage?.cost === "number" ? usage.cost : null,
	};
}

/** Bobertの道具を、OpenRouter(OpenAIと同じ形)の道具にする */
function toOpenRouterTool(tool: ChatTool) {
	return {
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.inputSchema,
		},
	};
}

/** 道具への入力(JSONの文字列)を読む。読めなければ、入力なしにする */
function parseArguments(text: string | undefined): unknown {
	try {
		return text ? JSON.parse(text) : {};
	} catch {
		return {};
	}
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

function toOpenRouterMessage(message: ChatMessage): OpenRouterMessage {
	const texts = message.parts.flatMap((part) =>
		part.type === "text" ? [part.text] : [],
	);
	if (texts.length === message.parts.length) {
		return { role: message.role, content: texts.join("\n\n") };
	}
	return {
		role: message.role,
		content: message.parts.map(
			(part): OpenRouterContentPart =>
				part.type === "text"
					? { type: "text", text: part.text }
					: toContentPart(part),
		),
	};
}

/** 画像とPDFは、URLのまま渡す。OpenRouterが読みに行く */
function toContentPart(file: ChatFile): OpenRouterContentPart {
	return file.type === "image"
		? { type: "image_url", image_url: { url: file.url } }
		: { type: "file", file: { filename: file.filename, file_data: file.url } };
}

/** 発言に、PDFが入っているか */
function hasPdf(message: OpenRouterMessage): boolean {
	return (
		Array.isArray(message.content) &&
		message.content.some((part) => part.type === "file")
	);
}

/** ファイルを受け付けなかったときの失敗か(400と413) */
function filesRejected(error: unknown): boolean {
	return (
		error instanceof LlmError &&
		(error.kind === "bad_request" || error.kind === "too_large")
	);
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
