import { logEvent } from "../log";
import type { ChatTool } from "./types";

/** 道具を実行した結果。AIに返す */
export interface ToolOutcome {
	content: string;
	/** 失敗や、実行しなかったことを伝える結果か */
	isError: boolean;
}

/** 呼び出しの上限を超えて呼ばれた道具の結果 */
export const TOOL_LIMIT_REACHED: ToolOutcome = {
	content:
		"道具の呼び出しの上限に達したため、実行しませんでした。道具を使わずに答えてください。",
	isError: true,
};

/** AIが呼んだ道具を実行する。知らない道具や、実行に失敗したときは、そう伝える結果にする */
export async function runChatTool(
	tools: readonly ChatTool[],
	name: string,
	input: unknown,
): Promise<ToolOutcome> {
	const tool = tools.find((candidate) => candidate.name === name);
	if (!tool) {
		return { content: `「${name}」という道具はありません。`, isError: true };
	}
	try {
		const record =
			typeof input === "object" && input !== null && !Array.isArray(input)
				? (input as Record<string, unknown>)
				: {};
		return { content: await tool.run(record), isError: false };
	} catch (error) {
		// 結果の本文は残さない
		logEvent("llm", "tool_failed", {
			tool: name,
			error: error instanceof Error ? error.name : "unknown",
		});
		return { content: "道具の実行に失敗しました。", isError: true };
	}
}
