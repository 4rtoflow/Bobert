import {
	createExecutionContext,
	waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { APIUser } from "discord-api-types/v10";
import { vi } from "vitest";
import type { ChannelInfo } from "../src/discord/channels";
import { handleInteraction } from "../src/interactions/handler";
import type { IngestDeps } from "../src/queue/ingest";
import {
	recomputeVisibility,
	saveChannels,
	saveEveryonePermissions,
} from "../src/store/channels";
import { type Provider, saveCredential } from "../src/store/users";
import { ALICE } from "./fixtures";

// テスト専用の秘密鍵(本物の秘密ではない)。
// 対になる公開鍵は vitest.config.ts の DISCORD_PUBLIC_KEY に入れてある。
const TEST_PRIVATE_KEY_PKCS8_BASE64 =
	"MC4CAQAwBQYDK2VwBCIEIDCm1PDxudFKdgOb5AdVwFP3XmMqU9X48Eg+6hhgNNds";

/** Discordから届くのと同じ形の、署名付きのInteractionsのリクエストを作る */
export async function signedInteractionRequest(
	payload: unknown,
	options: { tamper?: boolean } = {},
): Promise<Request> {
	const body = JSON.stringify(payload);
	const key = await crypto.subtle.importKey(
		"pkcs8",
		base64ToBytes(TEST_PRIVATE_KEY_PKCS8_BASE64),
		{ name: "Ed25519" },
		false,
		["sign"],
	);
	const timestamp = String(Math.floor(Date.now() / 1000));
	const signature = new Uint8Array(
		await crypto.subtle.sign(
			{ name: "Ed25519" },
			key,
			new TextEncoder().encode(timestamp + body),
		),
	);
	return new Request("https://bobert.example/interactions", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-Signature-Ed25519": bytesToHex(signature),
			"X-Signature-Timestamp": timestamp,
		},
		// 署名の後に本文を書き換えて、改ざんされたリクエストを作る
		body: options.tamper ? `${body} ` : body,
	});
}

/** サーバーの中で、userが起こしたInteraction */
export function guildInteraction(
	type: number,
	data: unknown,
	user: APIUser = ALICE,
) {
	return {
		id: "1",
		application_id: env.DISCORD_APPLICATION_ID,
		type,
		token: "interaction-token",
		version: 1,
		guild_id: "900",
		channel_id: "800",
		member: {
			user,
			roles: [],
			joined_at: "2026-10-01T00:00:00.000Z",
			deaf: false,
			mute: false,
			flags: 0,
			permissions: "0",
		},
		data,
	};
}

/** Interactionを送り、応答と、裏で続けた処理が終わるのを待つ */
export async function sendInteraction(
	payload: unknown,
	environment: Env = env,
) {
	const ctx = createExecutionContext();
	const response = await handleInteraction(
		await signedInteractionRequest(payload),
		environment,
		ctx,
	);
	await waitOnExecutionContext(ctx);
	// biome-ignore lint/suspicious/noExplicitAny: 応答の形はテストの中で確かめる
	return (await response.json()) as any;
}

/**
 * 資格情報を登録したユーザーを作る関数。呼ぶたびに別の人にする(IDはfirstIdから順に使う)。
 * テストのファイルごとに、ほかのファイルと重ならないfirstIdを使う。
 */
export function userFactory(firstId: number) {
	let nextId = firstId;
	return async (...providers: Provider[]): Promise<APIUser> => {
		const user = { ...ALICE, id: String(nextId++) };
		for (const provider of providers) {
			await saveCredential(env, user.id, provider, {
				apiKey: `key-${provider}`,
				workspaceId: null,
			});
		}
		return user;
	};
}

/** OpenRouterのモデル一覧に載せるモデル */
export interface ListedModel {
	id: string;
	inputModalities?: string[];
	/** 選べる思考の深さ */
	efforts?: string[];
	defaultEffort?: string;
}

/** OpenRouterのモデル一覧と、AnthropicのAPI、Discordへの書き換えに応える偽物 */
export function mockModelApis(
	models: ListedModel[],
	anthropic: (call: FetchCall) => Response = () =>
		new Response(null, { status: 500 }),
): FetchCall[] {
	return mockFetch((call) => {
		if (call.url.hostname === "openrouter.ai") {
			return Response.json({
				data: models.map((model) => ({
					id: model.id,
					architecture: { input_modalities: model.inputModalities ?? ["text"] },
					...(model.efforts
						? {
								reasoning: {
									supported_efforts: model.efforts,
									default_effort: model.defaultEffort,
								},
							}
						: {}),
				})),
			});
		}
		if (call.url.hostname === "api.anthropic.com") {
			return anthropic(call);
		}
		return Response.json({});
	});
}

/** 保留にした応答の書き換え(Discordに送った、メッセージの新しい中身) */
export function editedMessage(calls: FetchCall[]) {
	const edit = calls.find((call) => call.url.hostname === "discord.com");
	return edit?.body as
		| {
				content?: string;
				// biome-ignore lint/suspicious/noExplicitAny: メッセージの部品の形はテストの中で確かめる
				components?: any[];
		  }
		| undefined;
}

/** 偽のfetchが受け取ったリクエスト */
export interface FetchCall {
	method: string;
	url: URL;
	headers: Headers;
	/**
	 * JSONなら読んだもの、それ以外は文字列。
	 * ファイルを添付したもの(multipart/form-data)は、payload_jsonを読んだものに、filesとして添付したファイルを足す
	 */
	body: unknown;
}

/** 添付したファイル */
export interface SentFile {
	name: string;
	content: string;
}

/**
 * fetchを偽物に置き換える。呼び出しを記録し、handlerの返す応答を返す。
 * テストの中のWorkerのコードも同じ実行環境で動くので、Workerからの外向きの通信も置き換わる。
 */
export function mockFetch(
	handler: (call: FetchCall) => Response | Promise<Response>,
): FetchCall[] {
	const calls: FetchCall[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const request = new Request(input, init);
		const multipart = (request.headers.get("Content-Type") ?? "").startsWith(
			"multipart/form-data",
		);
		const call: FetchCall = {
			method: request.method,
			url: new URL(request.url),
			headers: request.headers,
			body: multipart
				? await parseFormData(await request.formData())
				: parseBody(await request.text()),
		};
		calls.push(call);
		return handler(call);
	});
	return calls;
}

/** ファイルを添付したリクエストの、payload_jsonと、添付したファイル */
async function parseFormData(form: FormData): Promise<unknown> {
	const payload = form.get("payload_json");
	const files: SentFile[] = [];
	for (const [key, value] of form.entries()) {
		if (key.startsWith("files[") && typeof value !== "string") {
			files.push({ name: value.name, content: await value.text() });
		}
	}
	return {
		...(typeof payload === "string" ? JSON.parse(payload) : {}),
		files,
	};
}

function parseBody(text: string): unknown {
	if (text === "") {
		return null;
	}
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
		"",
	);
}

/** 本文が引用したWebページ */
export function citation(url: string, title: string) {
	return {
		type: "web_search_result_location",
		url,
		title,
		cited_text: "引用した文",
		encrypted_index: "x",
	};
}

/** AnthropicのAPIの、ストリーミングの応答の中身 */
export type StreamBlock =
	| {
			type: "text";
			text: string;
			citations?: ReturnType<typeof citation>[];
	  }
	| { type: "server_tool_use"; id: string; query: string }
	| { type: "tool_use"; id: string; name: string; input?: unknown }
	| { type: "web_search_tool_result"; toolUseId: string; url: string };

/** AnthropicのAPIの、ストリーミングの応答(SSE)。blocksは返答の中身 */
export function anthropicStreamOf(
	blocks: StreamBlock[],
	options: {
		stopReason?: string;
		webSearches?: number;
		inputTokens?: number;
	} = {},
): Response {
	const events: [string, unknown][] = [
		[
			"message_start",
			{
				type: "message_start",
				message: {
					id: "msg_test",
					type: "message",
					role: "assistant",
					model: "claude-haiku-5-5",
					content: [],
					stop_reason: null,
					stop_sequence: null,
					usage: { input_tokens: options.inputTokens ?? 10, output_tokens: 1 },
				},
			},
		],
	];
	blocks.forEach((block, index) => {
		const delta = (data: unknown) =>
			events.push([
				"content_block_delta",
				{ type: "content_block_delta", index, delta: data },
			]);
		const start = (contentBlock: unknown) =>
			events.push([
				"content_block_start",
				{ type: "content_block_start", index, content_block: contentBlock },
			]);
		if (block.type === "text") {
			start({ type: "text", text: "", citations: null });
			delta({ type: "text_delta", text: block.text });
			for (const item of block.citations ?? []) {
				delta({ type: "citations_delta", citation: item });
			}
		} else if (block.type === "tool_use") {
			start({ type: "tool_use", id: block.id, name: block.name, input: {} });
			delta({
				type: "input_json_delta",
				partial_json: JSON.stringify(block.input ?? {}),
			});
		} else if (block.type === "server_tool_use") {
			start({
				type: "server_tool_use",
				id: block.id,
				name: "web_search",
				input: {},
			});
			delta({
				type: "input_json_delta",
				partial_json: JSON.stringify({ query: block.query }),
			});
		} else {
			start({
				type: "web_search_tool_result",
				tool_use_id: block.toolUseId,
				content: [
					{
						type: "web_search_result",
						url: block.url,
						title: "検索結果",
						encrypted_content: "x",
						page_age: null,
					},
				],
			});
		}
		events.push(["content_block_stop", { type: "content_block_stop", index }]);
	});
	events.push(
		[
			"message_delta",
			{
				type: "message_delta",
				delta: {
					stop_reason: options.stopReason ?? "end_turn",
					stop_sequence: null,
				},
				usage: {
					output_tokens: 5,
					server_tool_use: {
						web_search_requests: options.webSearches ?? 0,
						web_fetch_requests: 0,
					},
				},
			},
		],
		["message_stop", { type: "message_stop" }],
	);
	return new Response(
		events
			.map(
				([event, data]) => `event: ${event}
data: ${JSON.stringify(data)}

`,
			)
			.join(""),
		{ headers: { "Content-Type": "text/event-stream" } },
	);
}

/** テストの@everyoneの権限(チャンネルを見る、メッセージ履歴を読む) */
export const EVERYONE_CAN_READ = String((1n << 10n) | (1n << 16n));

/** チャンネルとスレッドを記録し、公開かどうかを決める。サーバーの@everyoneは、見て読めることにする */
export async function recordChannels(
	guildId: string,
	channels: (Partial<ChannelInfo> & { channelId: string })[],
): Promise<void> {
	await saveEveryonePermissions(env.DB, guildId, EVERYONE_CAN_READ, 1);
	await saveChannels(
		env.DB,
		channels.map((channel) => ({
			guildId,
			parentId: null,
			type: 0,
			name: `channel-${channel.channelId}`,
			nsfw: false,
			everyoneAllow: null,
			everyoneDeny: null,
			...channel,
		})),
		1,
	);
	await recomputeVisibility(env.DB, guildId);
}

/**
 * 偽物のVectorizeと埋め込み。呼ばれた内容を記録する。
 * 記録にないチャンネルは、DiscordのAPIで確かめると、公開のテキストチャンネルだったことにする
 */
export function fakeIngestDeps(botUserId: string) {
	const upserted: VectorizeVector[] = [];
	const deleted: string[] = [];
	const embedded: string[] = [];
	const deps: IngestDeps = {
		db: env.DB,
		vectors: {
			upsert: async (vectors) => {
				upserted.push(...vectors);
				return { mutationId: "mutation" };
			},
			deleteByIds: async (ids) => {
				deleted.push(...ids);
				return { mutationId: "mutation" };
			},
		},
		embed: async (texts) => {
			embedded.push(...texts);
			return texts.map(() => [0.1, 0.2]);
		},
		botUserId,
		fetchChannel: async (channelId, guildId) => ({
			channelId,
			guildId,
			parentId: null,
			type: 0,
			name: `channel-${channelId}`,
			nsfw: false,
			everyoneAllow: null,
			everyoneDeny: null,
		}),
		fetchEveryonePermissions: async () => EVERYONE_CAN_READ,
	};
	return { deps, upserted, deleted, embedded };
}
