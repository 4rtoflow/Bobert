import Anthropic from "@anthropic-ai/sdk";
import {
	type ChatMessage,
	type ChatRequest,
	type ChatResult,
	describeError,
	type KeyCheckResult,
	LlmError,
	type ModelCheckResult,
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

/**
 * ユーザーのAnthropicのAPIキーで、Claudeを直接呼ぶ。
 * 思考(thinking)は指定しない。現行のClaudeは、省略するとモデルが必要に応じて考える。
 */
export async function chatWithAnthropic(
	credential: AnthropicCredential,
	request: ChatRequest,
): Promise<ChatResult> {
	const client = createClient(credential);
	let message: Anthropic.Message;
	try {
		// 長い返答でも打ち切られないよう、ストリーミングで受けて最後にまとめる
		message = await client.messages
			.stream({
				model: request.model,
				max_tokens: request.maxTokens,
				// 毎回同じ並びの会話を渡すので、最後のブロックまでを自動でキャッシュする
				// (仕様: docs/spec/architecture.md「プロンプトキャッシュ」)
				cache_control: { type: "ephemeral" },
				system: request.system.map((text) => ({ type: "text", text })),
				messages: request.messages.map(toMessageParam),
				...(request.effort !== null && isClaudeEffort(request.effort)
					? { output_config: { effort: request.effort } }
					: {}),
			})
			.finalMessage();
	} catch (error) {
		throw toLlmError(error);
	}

	return {
		text: message.content
			.flatMap((block) => (block.type === "text" ? [block.text] : []))
			.join(""),
		stopReason:
			message.stop_reason === "max_tokens"
				? "max_tokens"
				: message.stop_reason === "refusal"
					? "refusal"
					: "end",
		usage: {
			inputTokens: message.usage.input_tokens,
			outputTokens: message.usage.output_tokens,
			cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
			cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
		},
	};
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
		// 既定の段階は、モデルの情報に含まれない
		return {
			status: "found",
			efforts: {
				levels: claudeEfforts(model.capabilities),
				defaultLevel: null,
			},
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
