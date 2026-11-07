import type { ChatRequest } from "../llm/types";
import { KNOWLEDGE_SUMMARY_PROMPT } from "./texts";

/**
 * 知識のファイルの要約(仕様: docs/spec/architecture.md「知識チャンネル」)。
 * 送った人のキーで、Claude Haiku 5.5に作らせる。記憶と同じく、本人が /model で選んだモデルは使わず、寄付も使わない
 */

/** 要約に使うモデル(候補の一覧のキー) */
export const KNOWLEDGE_SUMMARY_MODEL_KEY = "claude-haiku-5.5";

/**
 * 要約に渡す長さの上限(文字数)。長いファイルは、先頭から渡す。
 * Haiku 5.5の単価が上がる、入力の10万トークンを超えないようにする(記憶のまとめと同じ目安)
 */
export const MAX_SUMMARY_INPUT_CHARS = 60_000;

/** 要約の長さの上限(文字数)。超えたら、「…」で省く */
export const MAX_SUMMARY_CHARS = 200;

/** 要約の答えの長さの上限(トークン)。考える分(thinking)もここに含まれる */
const MAX_SUMMARY_OUTPUT_TOKENS = 2_000;

/** 要約の依頼。headは、文字にした内容の先頭(長ければ、MAX_SUMMARY_INPUT_CHARSまで)、totalは全体の長さ */
export function summaryRequest(
	modelId: string,
	filename: string,
	head: string,
	total: number,
): ChatRequest {
	return {
		model: modelId,
		system: [KNOWLEDGE_SUMMARY_PROMPT],
		messages: [
			{
				role: "user",
				parts: [{ type: "text", text: summaryInput(filename, head, total) }],
			},
		],
		effort: "low",
		webSearch: false,
		tools: [],
		maxTokens: MAX_SUMMARY_OUTPUT_TOKENS,
	};
}

/** 要約の依頼の本文。どこまでがファイルの中身かが分かるよう、タグで囲む */
export function summaryInput(
	filename: string,
	head: string,
	total: number,
): string {
	return [
		`ファイル名: ${filename}`,
		...(total > head.length
			? [
					`(長いため、全${formatCount(total)}文字のうち、先頭の${formatCount(head.length)}文字だけを渡します)`,
				]
			: []),
		"",
		"<file>",
		head,
		"</file>",
	].join("\n");
}

/** 文字にした内容の先頭を、要約に渡す長さまでにする。サロゲートペア(絵文字など)の途中では切らない */
export function summaryHead(text: string): string {
	if (text.length <= MAX_SUMMARY_INPUT_CHARS) {
		return text;
	}
	const cut = text.slice(0, MAX_SUMMARY_INPUT_CHARS);
	const last = cut.charCodeAt(cut.length - 1);
	return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/**
 * 要約の答えを、一覧の1行に書ける形にする。改行と続く空白は1つの空白にし、長ければ「…」で省く(合わせて200文字まで)
 */
export function normalizeSummary(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	const chars = [...flat];
	return chars.length > MAX_SUMMARY_CHARS
		? `${chars.slice(0, MAX_SUMMARY_CHARS - 1).join("")}…`
		: flat;
}

/** 3桁ごとにカンマを入れる */
function formatCount(count: number): string {
	return count.toLocaleString("en-US");
}
