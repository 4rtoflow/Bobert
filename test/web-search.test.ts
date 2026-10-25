import { afterEach, describe, expect, it, vi } from "vitest";
import { chatWithAnthropic } from "../src/llm/anthropic";
import { chatWithOpenRouter } from "../src/llm/openrouter";
import type { ChatRequest } from "../src/llm/types";
import { sourcesNote } from "../src/respond/web-search";
import { mockFetch } from "./helpers";

afterEach(() => {
	vi.restoreAllMocks();
});

const CREDENTIAL = { apiKey: "sk-ant-test", workspaceId: null };

function request(model: string, webSearch: boolean): ChatRequest {
	return {
		model,
		system: ["共通の指示"],
		messages: [
			{
				role: "user",
				parts: [{ type: "text", text: "Alice: 今日のニュースは?" }],
			},
		],
		effort: null,
		webSearch,
		maxTokens: 1000,
	};
}

/** 本文が引用したWebページ */
function citation(url: string, title: string) {
	return {
		type: "web_search_result_location",
		url,
		title,
		cited_text: "引用した文",
		encrypted_index: "x",
	};
}

type StreamBlock =
	| {
			type: "text";
			text: string;
			citations?: ReturnType<typeof citation>[];
	  }
	| { type: "server_tool_use"; id: string; query: string }
	| { type: "web_search_tool_result"; toolUseId: string; url: string };

/** AnthropicのAPIの、ストリーミングの応答。blocksは返答の中身 */
function anthropicStream(
	blocks: StreamBlock[],
	options: { stopReason?: string; webSearches?: number } = {},
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
					usage: { input_tokens: 10, output_tokens: 1 },
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

describe("Web検索(Anthropic)", () => {
	it("Web検索を使うときは、検索の道具を渡す。Haiku 5.5には古い版を使う", async () => {
		const calls = mockFetch(() =>
			anthropicStream([{ type: "text", text: "こんにちは" }]),
		);

		await chatWithAnthropic(CREDENTIAL, request("claude-haiku-5-5", true));

		expect(calls[0]?.body).toMatchObject({
			tools: [
				{
					type: "web_search_20250305",
					name: "web_search",
					max_uses: 5,
					user_location: {
						type: "approximate",
						country: "JP",
						timezone: "Asia/Tokyo",
					},
				},
			],
		});
	});

	it("Sonnet 5.5などには、検索結果を絞り込む新しい版を使う", async () => {
		const calls = mockFetch(() =>
			anthropicStream([{ type: "text", text: "こんにちは" }]),
		);

		await chatWithAnthropic(CREDENTIAL, request("claude-sonnet-5-5", true));

		expect(calls[0]?.body).toMatchObject({
			tools: [{ type: "web_search_20260209", name: "web_search" }],
		});
	});

	it("Web検索を使わないときは、道具を渡さない", async () => {
		const calls = mockFetch(() =>
			anthropicStream([{ type: "text", text: "こんにちは" }]),
		);

		await chatWithAnthropic(CREDENTIAL, request("claude-haiku-5-5", false));

		expect(calls[0]?.body).not.toHaveProperty("tools");
	});

	it("本文が引用したページを出典にし、検索の回数を数える", async () => {
		mockFetch(() =>
			anthropicStream(
				[
					{ type: "server_tool_use", id: "srvtoolu_1", query: "ニュース" },
					{
						type: "web_search_tool_result",
						toolUseId: "srvtoolu_1",
						url: "https://www.example.com/a",
					},
					{
						type: "text",
						text: "今日は晴れ。",
						citations: [citation("https://www.example.com/a", "天気")],
					},
					{
						type: "text",
						text: "円高が進んだ。",
						citations: [
							citation("https://news.example.jp/b", "円相場"),
							citation("https://www.example.com/a", "天気"),
						],
					},
				],
				{ webSearches: 1 },
			),
		);

		const result = await chatWithAnthropic(
			CREDENTIAL,
			request("claude-haiku-5-5", true),
		);

		expect(result.text).toBe("今日は晴れ。円高が進んだ。");
		expect(result.sources).toEqual([
			{ url: "https://www.example.com/a", title: "天気" },
			{ url: "https://news.example.jp/b", title: "円相場" },
		]);
		expect(result.usage.webSearchRequests).toBe(1);
	});

	it("返答が途中で止まったら(pause_turn)、止まったところまでを渡して続きを頼む", async () => {
		let call = 0;
		const calls = mockFetch(() =>
			call++ === 0
				? anthropicStream(
						[
							{ type: "text", text: "調べます。" },
							{ type: "server_tool_use", id: "srvtoolu_1", query: "ニュース" },
						],
						{ stopReason: "pause_turn", webSearches: 1 },
					)
				: anthropicStream([{ type: "text", text: "分かりました。" }], {
						webSearches: 1,
					}),
		);

		const result = await chatWithAnthropic(
			CREDENTIAL,
			request("claude-haiku-5-5", true),
		);

		expect(calls).toHaveLength(2);
		const resumed = calls[1]?.body as { messages: { role: string }[] };
		expect(resumed.messages.at(-1)).toMatchObject({
			role: "assistant",
			content: [
				{ type: "text", text: "調べます。" },
				{ type: "server_tool_use", id: "srvtoolu_1" },
			],
		});
		expect(result.text).toBe("調べます。分かりました。");
		expect(result.stopReason).toBe("end");
		// 2回分の合計
		expect(result.usage).toMatchObject({
			inputTokens: 20,
			outputTokens: 10,
			webSearchRequests: 2,
		});
	});
});

describe("Web検索(OpenRouter)", () => {
	it("Web検索を使うときは、OpenRouterの検索の道具を渡し、引用したページを出典にする", async () => {
		const calls = mockFetch(() =>
			Response.json({
				choices: [
					{
						message: {
							content: "今日は晴れ。",
							annotations: [
								{
									type: "url_citation",
									url_citation: { url: "https://example.com/a", title: "天気" },
								},
								{
									type: "url_citation",
									url_citation: { url: "https://example.com/a", title: "天気" },
								},
							],
						},
						finish_reason: "stop",
					},
				],
				usage: {
					prompt_tokens: 100,
					completion_tokens: 10,
					server_tool_use: { web_search_requests: 1 },
					cost: 0.008,
				},
			}),
		);

		const result = await chatWithOpenRouter(
			"sk-or-test",
			request("openai/gpt-6-luna", true),
		);

		expect(calls[0]?.body).toMatchObject({
			tools: [
				{ type: "openrouter:web_search", parameters: { max_results: 5 } },
			],
			max_tool_calls: 5,
		});
		expect(result.sources).toEqual([
			{ url: "https://example.com/a", title: "天気" },
		]);
		expect(result.usage.webSearchRequests).toBe(1);
	});

	it("Web検索を使わないときは、道具を渡さない", async () => {
		const calls = mockFetch(() =>
			Response.json({
				choices: [
					{ message: { content: "こんにちは" }, finish_reason: "stop" },
				],
			}),
		);

		await chatWithOpenRouter("sk-or-test", request("openai/gpt-6-luna", false));

		expect(calls[0]?.body).not.toHaveProperty("tools");
		expect(calls[0]?.body).not.toHaveProperty("max_tool_calls");
	});
});

describe("出典の行", () => {
	it("引用した順に、サイトのホスト名をリンクにして並べる。リンクの埋め込みは出させない", () => {
		expect(
			sourcesNote([
				{ url: "https://www.nikkei.com/article/1", title: "円相場" },
				{ url: "https://ja.wikipedia.org/wiki/円", title: "円" },
			]),
		).toBe(
			"-# 出典: [nikkei.com](<https://www.nikkei.com/article/1>)、[ja.wikipedia.org](<https://ja.wikipedia.org/wiki/%E5%86%86>)",
		);
	});

	it("httpとhttps以外や、読めないURLは使わず、5件までにする", () => {
		const many = Array.from({ length: 7 }, (_, index) => ({
			url: `https://site${index}.example/`,
			title: null,
		}));
		const note = sourcesNote([
			{ url: "javascript:alert(1)", title: null },
			{ url: "not a url", title: null },
			...many,
		]);

		expect(note).toBe(
			`-# 出典: ${[0, 1, 2, 3, 4].map((index) => `[site${index}.example](<https://site${index}.example/>)`).join("、")}`,
		);
	});

	it("引用がなければ、出典の行は作らない", () => {
		expect(sourcesNote([])).toBeNull();
	});
});
