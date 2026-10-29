import { afterEach, describe, expect, it, vi } from "vitest";
import { chatWithAnthropic } from "../src/llm/anthropic";
import { chatWithOpenRouter } from "../src/llm/openrouter";
import { FILES_REJECTED } from "../src/llm/tools";
import {
	type ChatRequest,
	type ChatTool,
	LlmError,
	type ToolResult,
} from "../src/llm/types";
import { anthropicStreamOf, type FetchCall, mockFetch } from "./helpers";

afterEach(() => {
	vi.restoreAllMocks();
});

const CREDENTIAL = { apiKey: "sk-ant-test", workspaceId: null };
const IMAGE_URL =
	"https://cdn.discordapp.com/attachments/800/9001/photo.png?ex=1";
const PDF_URL =
	"https://cdn.discordapp.com/attachments/800/9002/report.pdf?ex=1";

/** 画像とPDFを読んだ、ファイルを読む道具の結果 */
const FILES_RESULT: ToolResult = {
	text: "ファイル1「photo.png」と、ファイル2「report.pdf」です。",
	files: [
		{
			label: "ファイル1「photo.png」",
			file: { type: "image", url: IMAGE_URL },
		},
		{
			label: "ファイル2「report.pdf」",
			file: { type: "pdf", url: PDF_URL, filename: "report.pdf" },
		},
	],
};

/** 決まった結果を返す、偽物のファイルを読む道具 */
function fileTool(result: ToolResult = FILES_RESULT): ChatTool {
	return {
		name: "read_file",
		description: "ファイルを読む",
		inputSchema: { type: "object", properties: {} },
		countsTowardLimit: false,
		run: async () => result,
	};
}

function request(model: string, tools: ChatTool[]): ChatRequest {
	return {
		model,
		system: ["共通の指示"],
		messages: [
			{ role: "user", parts: [{ type: "text", text: "Bob: この画像は?" }] },
		],
		effort: null,
		webSearch: false,
		tools,
		maxTokens: 1000,
	};
}

/** AnthropicのAPIの、受け付けなかったときの応答 */
function anthropicRejected() {
	return Response.json(
		{
			type: "error",
			error: { type: "invalid_request_error", message: "Could not process" },
		},
		{ status: 400 },
	);
}

/** OpenRouterの、ファイルを読む道具を呼ぶ応答 */
function openRouterReadFile(id: string) {
	return Response.json({
		choices: [
			{
				message: {
					content: null,
					tool_calls: [
						{
							id,
							type: "function",
							function: { name: "read_file", arguments: '{"file":1}' },
						},
					],
				},
				finish_reason: "tool_calls",
			},
		],
		usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.001 },
	});
}

/** OpenRouterの、ふつうの答え */
function openRouterAnswer(text: string) {
	return Response.json({
		choices: [{ message: { content: text }, finish_reason: "stop" }],
		usage: { prompt_tokens: 150, completion_tokens: 20, cost: 0.002 },
	});
}

function bodies(calls: FetchCall[]) {
	// biome-ignore lint/suspicious/noExplicitAny: 送った中身の形はテストの中で確かめる
	return calls.map((call) => call.body as any);
}

describe("道具の結果のファイル(Anthropic)", () => {
	/** 1回目は道具を呼び、後は答える */
	function toolThenAnswer(...rest: (() => Response)[]) {
		let call = 0;
		return mockFetch(() => {
			const index = call++;
			if (index === 0) {
				return anthropicStreamOf(
					[{ type: "tool_use", id: "toolu_1", name: "read_file" }],
					{ stopReason: "tool_use" },
				);
			}
			return (
				rest[index - 1]?.() ??
				anthropicStreamOf([{ type: "text", text: "猫の写真です。" }])
			);
		});
	}

	it("画像とPDFは、tool_resultの中に、文の後に並べて渡す(URLのまま)", async () => {
		const calls = toolThenAnswer();

		const result = await chatWithAnthropic(
			CREDENTIAL,
			request("claude-haiku-5-5", [fileTool()]),
		);

		expect(bodies(calls)[1].messages.at(-1)).toEqual({
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: "toolu_1",
					content: [
						{ type: "text", text: FILES_RESULT.text },
						{ type: "image", source: { type: "url", url: IMAGE_URL } },
						{
							type: "document",
							source: { type: "url", url: PDF_URL },
							title: "report.pdf",
						},
					],
				},
			],
		});
		expect(result.text).toBe("猫の写真です。");
	});

	it("ファイルを受け付けなかったら、そのファイルを外し、渡せなかったことを書いて、1回だけ送り直す", async () => {
		const calls = toolThenAnswer(anthropicRejected);

		const result = await chatWithAnthropic(
			CREDENTIAL,
			request("claude-haiku-5-5", [fileTool()]),
		);

		expect(calls).toHaveLength(3);
		expect(bodies(calls)[2].messages.at(-1)).toEqual({
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: "toolu_1",
					content: [
						{ type: "text", text: FILES_RESULT.text },
						{ type: "text", text: FILES_REJECTED },
					],
				},
			],
		});
		expect(result.text).toBe("猫の写真です。");
		// 受け付けなかった回は、使用量に入らない
		expect(result.requestUsages).toHaveLength(2);
	});

	it("送り直しても受け付けなければ、失敗にする", async () => {
		toolThenAnswer(anthropicRejected, anthropicRejected);

		await expect(
			chatWithAnthropic(CREDENTIAL, request("claude-haiku-5-5", [fileTool()])),
		).rejects.toMatchObject({ kind: "bad_request" });
	});

	it("道具の結果にファイルがなければ、送り直さない", async () => {
		const calls = mockFetch(() => anthropicRejected());

		await expect(
			chatWithAnthropic(CREDENTIAL, request("claude-haiku-5-5", [fileTool()])),
		).rejects.toBeInstanceOf(LlmError);
		expect(calls).toHaveLength(1);
	});
});

describe("道具の結果のファイル(OpenRouter)", () => {
	it("道具の結果には文だけを入れ、画像とPDFは、すぐ後の人の発言で渡す。PDFがあれば、読み取り方をnativeにする", async () => {
		let call = 0;
		const calls = mockFetch(() =>
			call++ === 0
				? openRouterReadFile("call_1")
				: openRouterAnswer("猫の写真です。"),
		);

		const result = await chatWithOpenRouter(
			"sk-or-test",
			request("openai/gpt-6-luna", [fileTool()]),
		);

		const [first, second] = bodies(calls);
		expect(first).not.toHaveProperty("plugins");
		expect(second.messages.slice(-2)).toEqual([
			{
				role: "tool",
				tool_call_id: "call_1",
				content: `${FILES_RESULT.text}\n(このファイルは、この後の発言に添付しました)`,
			},
			{
				role: "user",
				content: [
					{ type: "text", text: "(ファイルを読む道具で読んだファイルです)" },
					{ type: "text", text: "ファイル1「photo.png」:" },
					{ type: "image_url", image_url: { url: IMAGE_URL } },
					{ type: "text", text: "ファイル2「report.pdf」:" },
					{
						type: "file",
						file: { filename: "report.pdf", file_data: PDF_URL },
					},
				],
			},
		]);
		expect(second.plugins).toEqual([
			{ id: "file-parser", pdf: { engine: "native" } },
		]);
		expect(result.text).toBe("猫の写真です。");
	});

	it("受け付けなかったら、ファイルを添付した発言を外し、渡せなかったことを道具の結果に書いて、1回だけ送り直す", async () => {
		let call = 0;
		const calls = mockFetch(() => {
			const index = call++;
			if (index === 0) {
				return openRouterReadFile("call_1");
			}
			return index === 1
				? Response.json(
						{ error: { code: 400, message: "bad request" } },
						{ status: 400 },
					)
				: openRouterAnswer("読めなかったよ。");
		});

		const result = await chatWithOpenRouter(
			"sk-or-test",
			request("openai/gpt-6-luna", [fileTool()]),
		);

		expect(calls).toHaveLength(3);
		const retried = bodies(calls)[2];
		expect(retried.messages.at(-1)).toEqual({
			role: "tool",
			tool_call_id: "call_1",
			content: `${FILES_RESULT.text}\n${FILES_REJECTED}`,
		});
		// PDFを外したので、読み取り方の指定も要らない
		expect(retried).not.toHaveProperty("plugins");
		expect(result.text).toBe("読めなかったよ。");
	});
});
