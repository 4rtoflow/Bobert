import type { TextTool } from "../llm/types";
import {
	loadMemoryItems,
	MAX_MEMORY_ITEM_LENGTH,
	MAX_MEMORY_TOTAL_LENGTH,
	type MemoryItem,
	saveMemoryItems,
} from "../store/memory";
import { totalLength, UPDATE_MEMORY_TOOL_NAME } from "./prompts";

/** 1回の返答で、記憶を直せる回数 */
const MAX_MEMORY_EDITS = 3;

/** 1回の返答で、記憶を直した記録。直したら、返答の末尾に、そのことを書く */
export interface MemoryEdits {
	calls: number;
	updated: boolean;
}

/**
 * 記憶を直す道具(仕様: docs/spec/architecture.md「記憶」)。返答を頼んだ本人が、覚えておいてほしいこと、
 * 忘れてほしいことを頼んだときに、AIが使う。足した項目は、本人が書いた項目にする(まとめ直しでは変えない)。
 * 道具の呼び出しの上限には数えず、1回の返答で3回まで
 */
export function updateMemoryTool(
	db: D1Database,
	userId: string,
	guildId: string,
	edits: MemoryEdits,
): TextTool {
	return {
		name: UPDATE_MEMORY_TOOL_NAME,
		description: `このユーザー(最後の発言をした人)について覚えておくことの一覧(記憶)を直します。本人が、覚えておいてほしいこと、忘れてほしいこと、直してほしいことを頼んだときだけ使ってください。パスワード、口座番号、住所、電話番号などは、頼まれても書かないでください。1つの項目は${MAX_MEMORY_ITEM_LENGTH}文字まで、全体で${MAX_MEMORY_TOTAL_LENGTH}文字までです。直すときは、古い項目を消して、新しい項目を足してください。`,
		inputSchema: {
			type: "object",
			properties: {
				add: {
					type: "array",
					items: { type: "string" },
					description: `足す項目(1つ${MAX_MEMORY_ITEM_LENGTH}文字まで)`,
				},
				remove: {
					type: "array",
					items: { type: "string" },
					description: "消す項目。今の一覧の項目の文を、そのまま書きます",
				},
			},
		},
		countsTowardLimit: false,
		run: async (input) => {
			if (edits.calls >= MAX_MEMORY_EDITS) {
				return `1回の返答で記憶を直せるのは${MAX_MEMORY_EDITS}回までです。`;
			}
			edits.calls++;
			const add = strings(input.add).map((text) =>
				text.replace(/\s*\n\s*/g, " ").trim(),
			);
			const remove = new Set(strings(input.remove).map((text) => text.trim()));
			const items = await loadMemoryItems(db, userId, guildId);
			const tooLong = add.filter(
				(text) => [...text].length > MAX_MEMORY_ITEM_LENGTH,
			);
			if (tooLong.length > 0) {
				return `1つの項目は${MAX_MEMORY_ITEM_LENGTH}文字までです。短くしてから、もう一度呼んでください: ${tooLong.join("、")}`;
			}
			const missing = [...remove].filter(
				(text) => !items.some((item) => item.text === text),
			);
			const next: MemoryItem[] = items.filter((item) => !remove.has(item.text));
			for (const text of add) {
				if (text !== "" && !next.some((item) => item.text === text)) {
					next.push({ text, userWritten: true, sources: [] });
				}
			}
			if (totalLength(next) > MAX_MEMORY_TOTAL_LENGTH) {
				return `全体で${MAX_MEMORY_TOTAL_LENGTH}文字を超えるので、直しませんでした。大事でない項目を消してから、足してください。\n${listOf(items)}`;
			}
			const changed =
				next.length !== items.length ||
				next.some((item, index) => item.text !== items[index]?.text);
			if (!changed) {
				return `直すものがありませんでした。${missing.length > 0 ? `一覧にない項目: ${missing.join("、")}` : ""}\n${listOf(items)}`;
			}
			await saveMemoryItems(db, userId, guildId, next);
			edits.updated = true;
			return [
				"記憶を直しました。",
				...(missing.length > 0
					? [`一覧になかったので消さなかった項目: ${missing.join("、")}`]
					: []),
				listOf(next),
			].join("\n");
		},
	};
}

function listOf(items: readonly MemoryItem[]): string {
	return [
		"今の一覧:",
		...(items.length === 0
			? ["(まだありません)"]
			: items.map((item) => `- ${item.text}`)),
	].join("\n");
}

function strings(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((entry): entry is string => typeof entry === "string")
		: [];
}
