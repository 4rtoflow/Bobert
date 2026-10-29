import { logEvent } from "../log";
import type { ChatTool, ToolResult } from "./types";

/** 道具を実行した結果。AIに返す */
export interface ToolOutcome {
	content: string;
	/** 文のほかに渡す画像とPDF(ファイルを読む道具) */
	files: ToolResult["files"];
	/** 失敗や、実行しなかったことを伝える結果か */
	isError: boolean;
}

/** 呼び出しの上限を超えて呼ばれた道具の結果 */
export const TOOL_LIMIT_REACHED: ToolOutcome = {
	content:
		"道具の呼び出しの上限に達したため、実行しませんでした。道具を使わずに答えてください。",
	files: [],
	isError: true,
};

/**
 * AIのプロバイダが受け付けなかったファイルの代わりに、道具の結果に書き足す文
 * (仕様: docs/spec/architecture.md「添付ファイルの読み取り」)。ファイルを外して、1回だけ送り直す
 */
export const FILES_REJECTED =
	"(このファイルは、AIのサービスが受け付けなかったため、渡せませんでした。大きすぎるか、壊れているか、パスワードが付いている可能性があります)";

/** 道具の呼び出しの上限に数える道具か。知らない道具も数える(呼ばれ続けても、上限で止まるように) */
export function countsTowardLimit(
	tools: readonly ChatTool[],
	name: string,
): boolean {
	return (
		tools.find((candidate) => candidate.name === name)?.countsTowardLimit !==
		false
	);
}

/** AIが呼んだ道具を実行する。知らない道具や、実行に失敗したときは、そう伝える結果にする */
export async function runChatTool(
	tools: readonly ChatTool[],
	name: string,
	input: unknown,
): Promise<ToolOutcome> {
	const tool = tools.find((candidate) => candidate.name === name);
	if (!tool) {
		return {
			content: `「${name}」という道具はありません。`,
			files: [],
			isError: true,
		};
	}
	try {
		const record =
			typeof input === "object" && input !== null && !Array.isArray(input)
				? (input as Record<string, unknown>)
				: {};
		const result = await tool.run(record);
		return typeof result === "string"
			? { content: result, files: [], isError: false }
			: { content: result.text, files: result.files, isError: false };
	} catch (error) {
		// 結果の本文は残さない
		logEvent("llm", "tool_failed", {
			tool: name,
			error: error instanceof Error ? error.name : "unknown",
		});
		return { content: "道具の実行に失敗しました。", files: [], isError: true };
	}
}
