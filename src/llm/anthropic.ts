import Anthropic from "@anthropic-ai/sdk";
import { MAX_TOOL_CALLS, MAX_WEB_SEARCHES } from "../config/models";
import { runChatTool, TOOL_LIMIT_REACHED } from "./tools";
import {
	type ChatMessage,
	type ChatRequest,
	type ChatResult,
	type ChatTool,
	describeError,
	type KeyCheckResult,
	LlmError,
	type ModelCheckResult,
	type Source,
	sumUsage,
	type TokenUsage,
} from "./types";

type Effort = NonNullable<Anthropic.OutputConfig["effort"]>;

/** Claudeで選べる思考の深さ(浅い順)。仕様: docs/spec/llm-cost.md「/effortの選択肢」 */
export const CLAUDE_EFFORTS = [
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const satisfies readonly Effort[];

function isClaudeEffort(value: string): value is Effort {
	return (CLAUDE_EFFORTS as readonly string[]).includes(value);
}

/** ユーザーのAnthropicの資格情報 */
export interface AnthropicCredential {
	apiKey: string;
	/** キーがワークスペースに属さないとき(個人キーなど)に使うワークスペースのID */
	workspaceId: string | null;
}

/** 検索結果を絞り込む、新しい版のWeb検索を使えるClaude。ほかのClaudeは、古い版を使う */
const DYNAMIC_WEB_SEARCH_MODELS: ReadonlySet<string> = new Set([
	"claude-sonnet-5-5",
	"claude-opus-5-5",
	"claude-fable-5-1",
]);

/** サーバー側の処理が長くて、返答が途中で止まった(pause_turn)ときに、続きを頼む回数の上限 */
const MAX_CONTINUATIONS = 3;

/** 1回の返答で、AIとやり取りする回数の上限。続きを頼むときと、道具の結果を返すときに数える */
const MAX_ROUNDS = 10;

/**
 * ユーザーのAnthropicのAPIキーで、Claudeを直接呼ぶ。
 * 思考(thinking)は指定しない。現行のClaudeは、省略するとモデルが必要に応じて考える。
 * - Web検索はサーバー側で動く。処理が長いと返答が途中で止まる(pause_turn)ので、そのときは続きを頼む
 * - Bobertの道具をAIが呼んだら、実行して結果を返し、続きを頼む。呼び出しが上限に達したら、道具を使わずに答えさせる
 */
export async function chatWithAnthropic(
	credential: AnthropicCredential,
	request: ChatRequest,
): Promise<ChatResult> {
	const client = createClient(credential);
	const messages: Anthropic.MessageParam[] =
		request.messages.map(toMessageParam);
	// 道具の定義は、毎回同じ並びにする(キャッシュのため)。Bobertの道具、Web検索の順
	const tools: Anthropic.Messages.ToolUnion[] = [
		...request.tools.map(toAnthropicTool),
		...(request.webSearch ? [webSearchTool(request.model)] : []),
	];
	const responses: Anthropic.Message[] = [];
	/** 最後の答えが始まる応答。道具の結果を返したら、その次の応答から数え直す */
	let answerFrom = 0;
	let continuations = 0;
	let toolCalls = 0;
	try {
		while (responses.length < MAX_ROUNDS) {
			// 長い返答でも打ち切られないよう、ストリーミングで受けて最後にまとめる
			const message = await client.messages
				.stream({
					model: request.model,
					max_tokens: request.maxTokens,
					// 毎回同じ並びの会話を渡すので、最後のブロックまでを自動でキャッシュする
					// (仕様: docs/spec/architecture.md「プロンプトキャッシュ」)
					cache_control: { type: "ephemeral" },
					...(tools.length > 0 ? { tools } : {}),
					...(request.tools.length > 0 && toolCalls >= MAX_TOOL_CALLS
						? { tool_choice: { type: "none" } }
						: {}),
					system: request.system.map((text) => ({ type: "text", text })),
					messages,
					...(request.effort !== null && isClaudeEffort(request.effort)
						? { output_config: { effort: request.effort } }
						: {}),
				})
				.finalMessage();
			responses.push(message);
			if (
				message.stop_reason === "pause_turn" &&
				continuations < MAX_CONTINUATIONS
			) {
				continuations++;
				// 止まったところまでの返答を渡すと、その続きから始まる
				messages.push({ role: "assistant", content: message.content });
				continue;
			}
			const uses = message.content.filter(
				(block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
			);
			if (message.stop_reason !== "tool_use" || uses.length === 0) {
				break;
			}
			messages.push({ role: "assistant", content: message.content });
			const results: Anthropic.ToolResultBlockParam[] = [];
			for (const use of uses) {
				const outcome =
					toolCalls < MAX_TOOL_CALLS
						? await runChatTool(request.tools, use.name, use.input)
						: TOOL_LIMIT_REACHED;
				toolCalls++;
				results.push({
					type: "tool_result",
					tool_use_id: use.id,
					content: outcome.content,
					...(outcome.isError ? { is_error: true } : {}),
				});
			}
			// 道具の結果は、まとめて1つのメッセージで返す
			messages.push({ role: "user", content: results });
			answerFrom = responses.length;
		}
	} catch (error) {
		throw toLlmError(error);
	}

	const blocks = responses.flatMap((message) => message.content);
	const stopReason = responses.at(-1)?.stop_reason;
	return {
		// 道具を呼ぶ前の前置き(「調べます」など)は、答えに入れない
		text: responses
			.slice(answerFrom)
			.flatMap((message) => message.content)
			.flatMap((block) => (block.type === "text" ? [block.text] : []))
			.join(""),
		stopReason:
			stopReason === "max_tokens"
				? "max_tokens"
				: stopReason === "refusal"
					? "refusal"
					: "end",
		usage: sumUsage(responses.map((message) => usageOf(message.usage))),
		sources: sourcesOf(blocks),
		toolCalls,
	};
}

/**
 * Bobertの道具を、Anthropicの形にする。
 * 入力は、生成されながら届くようにする(届いた入力は、道具の側で確かめる)。
 */
function toAnthropicTool(tool: ChatTool): Anthropic.Messages.ToolUnion {
	return {
		name: tool.name,
		description: tool.description,
		input_schema: tool.inputSchema,
		eager_input_streaming: true,
	};
}

/**
 * Web検索の道具。1回の返答で使える回数に上限を設ける。
 * 自分たちのサーバーの人は日本にいるので、日本向けの検索結果になるよう、地域を日本にする。
 */
function webSearchTool(model: string): Anthropic.Messages.ToolUnion {
	const common = {
		name: "web_search",
		max_uses: MAX_WEB_SEARCHES,
		user_location: {
			type: "approximate",
			country: "JP",
			timezone: "Asia/Tokyo",
		},
	} as const;
	return DYNAMIC_WEB_SEARCH_MODELS.has(model)
		? { ...common, type: "web_search_20260209" }
		: { ...common, type: "web_search_20250305" };
}

/** 使ったトークン数。Anthropicのinput_tokensは、キャッシュを使わなかった分だけなので、キャッシュの分を足す */
function usageOf(usage: Anthropic.Usage): TokenUsage {
	const cacheRead = usage.cache_read_input_tokens ?? 0;
	const cacheWrite = usage.cache_creation_input_tokens ?? 0;
	return {
		inputTokens: usage.input_tokens + cacheRead + cacheWrite,
		outputTokens: usage.output_tokens,
		cacheReadTokens: cacheRead,
		cacheWriteTokens: cacheWrite,
		webSearchRequests: usage.server_tool_use?.web_search_requests ?? 0,
		costUsd: null,
	};
}

/** 本文が引用したWebページ(出典)。同じURLは1つにまとめる */
function sourcesOf(blocks: readonly Anthropic.ContentBlock[]): Source[] {
	const sources = new Map<string, Source>();
	for (const block of blocks) {
		if (block.type !== "text") {
			continue;
		}
		for (const citation of block.citations ?? []) {
			if (
				citation.type === "web_search_result_location" &&
				!sources.has(citation.url)
			) {
				sources.set(citation.url, { url: citation.url, title: citation.title });
			}
		}
	}
	return [...sources.values()];
}

/** キーが有効か確かめる。料金のかからない、モデル一覧のAPIを呼ぶ */
export async function checkAnthropicKey(
	credential: AnthropicCredential,
): Promise<KeyCheckResult> {
	const client = createClient(credential, 1);
	try {
		await client.models.list({ limit: 1 });
		return { status: "valid" };
	} catch (error) {
		if (
			error instanceof Anthropic.AuthenticationError ||
			error instanceof Anthropic.PermissionDeniedError
		) {
			return { status: "invalid" };
		}
		// このリクエストに誤りが入る余地はないので、400はワークスペースの指定が原因になる。
		// ワークスペースに属さないキーでIDがないか、入力されたIDの形が正しくない
		if (error instanceof Anthropic.BadRequestError) {
			return credential.workspaceId === null
				? { status: "needs_workspace" }
				: { status: "workspace_not_found" };
		}
		// 入力されたワークスペースが存在しないか、このキーでは使えない
		if (
			error instanceof Anthropic.NotFoundError &&
			credential.workspaceId !== null
		) {
			return { status: "workspace_not_found" };
		}
		return { status: "unavailable", detail: describeError(error) };
	}
}

/**
 * 「その他」で入力されたClaudeのモデルを、このキーで使えるか確かめる。
 * 料金のかからない、モデルの情報のAPIを呼ぶ。選べる思考の深さも、モデルの情報から取り出す。
 */
export async function checkAnthropicModel(
	credential: AnthropicCredential,
	modelId: string,
): Promise<ModelCheckResult> {
	const client = createClient(credential, 1);
	try {
		const model = await client.models.retrieve(modelId);
		// Web検索を使えるかの情報がなければ、使えることにする
		return {
			status: "found",
			efforts: claudeEfforts(model.capabilities),
			webSearch:
				model.capabilities?.server_tools?.web_search?.supported ?? true,
		};
	} catch (error) {
		// 形の正しくないIDは、404ではなく400になることがある
		if (
			error instanceof Anthropic.NotFoundError ||
			error instanceof Anthropic.BadRequestError
		) {
			return { status: "not_found" };
		}
		if (
			error instanceof Anthropic.AuthenticationError ||
			error instanceof Anthropic.PermissionDeniedError
		) {
			return { status: "invalid_key" };
		}
		return { status: "unavailable", detail: describeError(error) };
	}
}

/**
 * モデルの情報から、選べる思考の深さを取り出す。古いモデルには、選べない段階がある。
 * 情報がなければ(応答に含まれないことがある)、Claudeの段階をすべて選べることにする。
 */
function claudeEfforts(
	capabilities: Anthropic.ModelCapabilities | null | undefined,
): string[] {
	const effort = capabilities?.effort;
	if (!effort) {
		return [...CLAUDE_EFFORTS];
	}
	if (!effort.supported) {
		return [];
	}
	return CLAUDE_EFFORTS.filter((level) => effort[level]?.supported === true);
}

/**
 * SDKのクライアントを作る。
 * ワークスペースに属さないキーでは、使うワークスペースのIDをリクエストのたびにヘッダーで送る。
 */
function createClient(
	credential: AnthropicCredential,
	maxRetries?: number,
): Anthropic {
	return new Anthropic({
		apiKey: credential.apiKey,
		...(maxRetries === undefined ? {} : { maxRetries }),
		...(credential.workspaceId === null
			? {}
			: {
					defaultHeaders: { "anthropic-workspace-id": credential.workspaceId },
				}),
	});
}

function toMessageParam(message: ChatMessage): Anthropic.MessageParam {
	return {
		role: message.role,
		content: message.parts.map(
			(part): Anthropic.ContentBlockParam =>
				part.type === "text"
					? { type: "text", text: part.text }
					: { type: "image", source: { type: "url", url: part.url } },
		),
	};
}

/**
 * SDKの例外を、失敗の種類に分ける。
 * APIのエラーは、種類とステータスだけを持つ(エラーの文に、送った内容の一部が入ることがあるため)
 */
function toLlmError(error: unknown): LlmError {
	if (error instanceof Anthropic.APIConnectionError) {
		return new LlmError(
			"unavailable",
			null,
			"connection failed",
			describeError(error),
		);
	}
	if (!(error instanceof Anthropic.APIError)) {
		// 応答の読み取りの失敗などは、エラーの文に返答の一部が入りうるので、名前だけを残す
		return new LlmError(
			"unknown",
			null,
			"unexpected error",
			error instanceof Error ? error.name : typeof error,
		);
	}
	const status = error.status ?? null;
	const message = `Anthropic API error ${status} ${error.type ?? ""}`.trim();
	if (error instanceof Anthropic.AuthenticationError) {
		return new LlmError("invalid_key", status, message);
	}
	if (error.type === "billing_error" || status === 402) {
		return new LlmError("insufficient_credit", status, message);
	}
	if (error instanceof Anthropic.PermissionDeniedError) {
		return new LlmError("forbidden", status, message);
	}
	if (error instanceof Anthropic.NotFoundError) {
		return new LlmError("model_not_found", status, message);
	}
	if (error instanceof Anthropic.RateLimitError) {
		return new LlmError("rate_limited", status, message);
	}
	if (error instanceof Anthropic.InternalServerError) {
		return new LlmError("unavailable", status, message);
	}
	if (status === 413) {
		return new LlmError("too_large", status, message);
	}
	if (error instanceof Anthropic.BadRequestError) {
		return new LlmError("bad_request", status, message);
	}
	return new LlmError("unknown", status, message);
}
