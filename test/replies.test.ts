import { describe, expect, it } from "vitest";
import type { ChatResult } from "../src/llm/types";
import { stripReplyHeader } from "../src/respond/conversation";
import { formatReply } from "../src/respond/replies";

function chatResult(text: string): ChatResult {
	const usage = {
		inputTokens: 10,
		outputTokens: 5,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		webSearchRequests: 0,
		costUsd: null,
	};
	return {
		text,
		stopReason: "end",
		usage,
		requestUsages: [usage],
		sources: [],
		toolCalls: 0,
	};
}

describe("返答の先頭の「[時刻] 名前: 」", () => {
	it("AIが会話の書式をまねて書いた「[時刻] Bobert: 」は、投稿する前に外す", () => {
		expect(
			formatReply(
				chatResult(
					"[2026-10-30(金) 00:01] Bobert: こんにちは！夜遅くにどうしたの？",
				),
				{ imagesSkipped: false, webSearchSkipped: false, usage: null },
			),
		).toBe("こんにちは！夜遅くにどうしたの？");
	});

	it("時刻だけ、ほかのチャンネルの名前付き、名前だけ(大文字と小文字、全角のコロン)でも外す", () => {
		expect(stripReplyHeader("[2026-10-30(金) 00:01] やあ")).toBe("やあ");
		expect(stripReplyHeader("[2026-10-30(金) 00:01] #雑談 Bobert: やあ")).toBe(
			"やあ",
		);
		expect(stripReplyHeader("bobert：やあ")).toBe("やあ");
		expect(stripReplyHeader("[2026-10-30(金) 00:01] Bobert:\nやあ")).toBe(
			"やあ",
		);
	});

	it("先頭でないものや、書式の違うものは外さない", () => {
		for (const text of [
			"[注意] 明日は休みです",
			"10/30の[2026-10-30(金) 00:01] Bobert: の発言のことだね",
			"Bobertは元気です",
			"2026-10-30(金) 00:01 に話していたね",
		]) {
			expect(stripReplyHeader(text)).toBe(text);
		}
	});
});
