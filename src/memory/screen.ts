import type {
	APIActionRowComponent,
	APIAllowedMentions,
	APIButtonComponentWithCustomId,
	APIComponentInMessageActionRow,
} from "discord-api-types/v10";
import { ButtonStyle, ComponentType } from "../discord/constants";
import { formatJst } from "../respond/time";
import type { MemoryState } from "../store/memory";
import {
	MEMORY_CLEAR_LABEL,
	MEMORY_COST_NOTE,
	MEMORY_DONATION_NOTE,
	MEMORY_EDIT_LABEL,
	MEMORY_EMPTY,
	MEMORY_KEPT_NOTE,
	MEMORY_OFF_EXPLANATION,
	MEMORY_OFF_LABEL,
	MEMORY_OFF_TITLE,
	MEMORY_ON_LABEL,
	MEMORY_ON_TITLE,
	memoryFailureLine,
	memoryUpdatedLine,
} from "./texts";

/** /memory の画面のボタンと入力画面のIDの先頭 */
export const MEMORY_ID_PREFIX = "memory:";
/** /memory の画面のボタン */
export const MEMORY_ON_ID = "memory:on";
export const MEMORY_OFF_ID = "memory:off";
export const MEMORY_EDIT_ID = "memory:edit";
export const MEMORY_CLEAR_ID = "memory:clear";
export const MEMORY_CLEAR_CONFIRM_ID = "memory:clear_confirm";
/** 「直す」の入力画面と、その欄 */
export const MEMORY_EDIT_MODAL_ID = "memory:edit_modal";
export const MEMORY_EDIT_INPUT_ID = "items";

/** Discordのメッセージの長さの上限 */
const MAX_CONTENT_LENGTH = 2000;

/** /memory の画面の中身。Interactionの応答にも、後からの書き換えにも使う */
export interface MemoryScreen {
	content: string;
	allowed_mentions?: APIAllowedMentions;
	components: APIActionRowComponent<APIComponentInMessageActionRow>[];
}

/**
 * /memory の画面(本人にだけ見える。仕様: docs/spec/behavior.md「記憶」)。
 * OFFなら、何をする機能かと費用、ONなら、覚えていることの一覧と、最後の更新を書く
 */
export function memoryScreen(state: MemoryState | null): MemoryScreen {
	if (state === null || !state.enabled) {
		return {
			content: [
				MEMORY_OFF_TITLE,
				MEMORY_OFF_EXPLANATION,
				MEMORY_COST_NOTE,
				MEMORY_DONATION_NOTE,
				...(state !== null && state.items.length > 0 ? [MEMORY_KEPT_NOTE] : []),
			].join("\n"),
			components: [
				row(button(MEMORY_ON_LABEL, MEMORY_ON_ID, ButtonStyle.Success)),
			],
		};
	}
	return {
		content: fitContent(
			MEMORY_ON_TITLE,
			state.items.length === 0
				? [MEMORY_EMPTY]
				: state.items.map((item, index) => `${index + 1}. ${item.text}`),
			[
				...(state.updatedAt === null
					? []
					: [memoryUpdatedLine(formatJst(state.updatedAt))]),
				...(state.failure === null ? [] : [memoryFailureLine(state.failure)]),
			],
		),
		// 項目に書かれたメンションで、通知を送らない
		allowed_mentions: { parse: [] },
		components: [
			row(
				button(MEMORY_EDIT_LABEL, MEMORY_EDIT_ID, ButtonStyle.Primary),
				button(MEMORY_CLEAR_LABEL, MEMORY_CLEAR_ID, ButtonStyle.Secondary),
				button(MEMORY_OFF_LABEL, MEMORY_OFF_ID, ButtonStyle.Secondary),
			),
		],
	};
}

/**
 * 見出し、一覧、末尾の行を、1通(2000文字)に収めて並べる。一覧の文字数は1500文字までだが、
 * 短い項目がとても多いと、番号の分で超えるため。収まらなければ、一覧を後ろから外して「…」を置く
 */
function fitContent(
	title: string,
	lines: readonly string[],
	tail: readonly string[],
): string {
	const shown = [...lines];
	const join = (more: readonly string[]) =>
		[title, ...shown, ...more, ...tail].join("\n");
	if (join([]).length <= MAX_CONTENT_LENGTH) {
		return join([]);
	}
	while (shown.length > 0 && join(["…"]).length > MAX_CONTENT_LENGTH) {
		shown.pop();
	}
	return join(["…"]);
}

export function button(
	label: string,
	customId: string,
	style: APIButtonComponentWithCustomId["style"],
): APIButtonComponentWithCustomId {
	return { type: ComponentType.Button, style, label, custom_id: customId };
}

export function row(
	...components: APIButtonComponentWithCustomId[]
): APIActionRowComponent<APIComponentInMessageActionRow> {
	return { type: ComponentType.ActionRow, components };
}
