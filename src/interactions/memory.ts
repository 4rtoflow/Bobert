import type {
	APIInteractionResponse,
	APIInteractionResponseCallbackData,
	APIModalSubmitInteraction,
} from "discord-api-types/v10";
import {
	ButtonStyle,
	ComponentType,
	InteractionResponseType,
	MessageFlags,
	TextInputStyle,
} from "../discord/constants";
import { logEvent } from "../log";
import { totalLength } from "../memory/prompts";
import {
	button,
	MEMORY_CLEAR_CONFIRM_ID,
	MEMORY_CLEAR_ID,
	MEMORY_EDIT_ID,
	MEMORY_EDIT_INPUT_ID,
	MEMORY_EDIT_MODAL_ID,
	MEMORY_OFF_ID,
	MEMORY_ON_ID,
	memoryScreen,
	row,
} from "../memory/screen";
import {
	MEMORY_BUILDING,
	MEMORY_CLEAR_CONFIRM,
	MEMORY_CLEAR_CONFIRM_LABEL,
	MEMORY_CLEARED,
	MEMORY_EDIT_DESCRIPTION,
	MEMORY_EDIT_LABEL_TEXT,
	MEMORY_EDIT_TITLE,
	MEMORY_KEY_REQUIRED,
	memoryItemTooLong,
	memoryTotalTooLong,
} from "../memory/texts";
import type { QueueMessage } from "../queue/messages";
import {
	claimMemoryUpdate,
	clearMemoryItems,
	loadMemory,
	MAX_MEMORY_ITEM_LENGTH,
	MAX_MEMORY_TOTAL_LENGTH,
	type MemoryItem,
	saveMemoryItems,
	setMemoryEnabled,
} from "../store/memory";
import { getRegisteredProviders } from "../store/users";
import { readTextInput } from "./input";

/**
 * /memory と、その画面の操作(仕様: docs/spec/behavior.md「記憶」)。どれも本人にだけ見える。記憶はサーバーごと
 */

/** /memory: 今の記憶の画面を見せる */
export async function memoryCommand(
	env: Env,
	userId: string,
	guildId: string,
): Promise<APIInteractionResponse> {
	return {
		type: InteractionResponseType.ChannelMessageWithSource,
		data: {
			flags: MessageFlags.Ephemeral,
			...memoryScreen(await loadMemory(env.DB, userId, guildId)),
		},
	};
}

/** /memory の画面のボタン。知らないボタンならnull */
export async function memoryComponent(
	interaction: { token: string },
	env: Env,
	userId: string,
	guildId: string,
	customId: string,
): Promise<APIInteractionResponse | null> {
	switch (customId) {
		case MEMORY_ON_ID:
			return turnOn(interaction, env, userId, guildId);
		case MEMORY_OFF_ID: {
			await setMemoryEnabled(env.DB, userId, guildId, false);
			log("disabled", { userId });
			return update(memoryScreen(await loadMemory(env.DB, userId, guildId)));
		}
		case MEMORY_EDIT_ID:
			return editModal(env, userId, guildId);
		case MEMORY_CLEAR_ID:
			return {
				type: InteractionResponseType.ChannelMessageWithSource,
				data: {
					flags: MessageFlags.Ephemeral,
					content: MEMORY_CLEAR_CONFIRM,
					components: [
						row(
							button(
								MEMORY_CLEAR_CONFIRM_LABEL,
								MEMORY_CLEAR_CONFIRM_ID,
								ButtonStyle.Danger,
							),
						),
					],
				},
			};
		case MEMORY_CLEAR_CONFIRM_ID: {
			await clearMemoryItems(env.DB, userId, guildId);
			log("cleared", { userId });
			return update({ content: MEMORY_CLEARED, components: [] });
		}
		default:
			return null;
	}
}

/**
 * 「ONにする」: キーがなければ、登録を案内する。最初の一覧をまだ作っていなければ、作る仕事をQueueに入れ、
 * 画面を「まとめています」にする(まとめ終わったら、仕事が画面を一覧に書き換える)
 */
async function turnOn(
	interaction: { token: string },
	env: Env,
	userId: string,
	guildId: string,
): Promise<APIInteractionResponse> {
	// まとめる費用は本人のキーにかけるので、キーが要る(寄付は使わない)
	if ((await getRegisteredProviders(env.DB, userId)).size === 0) {
		return {
			type: InteractionResponseType.ChannelMessageWithSource,
			data: { flags: MessageFlags.Ephemeral, content: MEMORY_KEY_REQUIRED },
		};
	}
	await setMemoryEnabled(env.DB, userId, guildId, true);
	log("enabled", { userId });
	const state = await loadMemory(env.DB, userId, guildId);
	// 最初の一覧を作ってあれば、すぐに一覧を見せる(更新は、次に話しかけたときに、1日1回)
	if (state === null || state.readUntil !== null) {
		return update(memoryScreen(state));
	}
	await claimMemoryUpdate(env.DB, userId, guildId, { force: true });
	await env.RESPOND_QUEUE.send({
		kind: "memory",
		userId,
		guildId,
		interactionToken: interaction.token,
	} satisfies QueueMessage);
	return update({ content: MEMORY_BUILDING, components: [] });
}

/** 「直す」: 今の一覧を、1行に1つ入れた入力画面を開く */
async function editModal(
	env: Env,
	userId: string,
	guildId: string,
): Promise<APIInteractionResponse> {
	const state = await loadMemory(env.DB, userId, guildId);
	const value = (state?.items ?? []).map((item) => item.text).join("\n");
	return {
		type: InteractionResponseType.Modal,
		data: {
			custom_id: MEMORY_EDIT_MODAL_ID,
			title: MEMORY_EDIT_TITLE,
			components: [
				{
					type: ComponentType.Label,
					label: MEMORY_EDIT_LABEL_TEXT,
					description: MEMORY_EDIT_DESCRIPTION,
					component: {
						type: ComponentType.TextInput,
						custom_id: MEMORY_EDIT_INPUT_ID,
						style: TextInputStyle.Paragraph,
						required: false,
						// 長すぎるときは、送った後に知らせる(書いた内容を付けて返す)
						max_length: 4000,
						...(value === "" ? {} : { value }),
					},
				},
			],
		},
	};
}

/**
 * 「直す」の入力画面の送信: 1行を1つの項目にして保存し、画面を書き換える。
 * 変えなかった行は、覚えた日ともとの発言の記録を残す。変えた行と足した行は、本人が書いた項目にする。
 * 長すぎたら保存せず、書いた内容を付けて知らせる(入力画面は送ると閉じるため)
 */
export async function submitMemoryEdit(
	interaction: APIModalSubmitInteraction,
	env: Env,
	userId: string,
	guildId: string,
): Promise<APIInteractionResponse> {
	const text = readTextInput(interaction, MEMORY_EDIT_INPUT_ID) ?? "";
	const lines = text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "");
	const tooLong = lines.findIndex(
		(line) => [...line].length > MAX_MEMORY_ITEM_LENGTH,
	);
	if (tooLong >= 0) {
		return ephemeral(
			withText(
				memoryItemTooLong(tooLong + 1, [...(lines[tooLong] ?? "")].length),
				text,
			),
		);
	}
	const total = totalLength(lines.map((line) => ({ text: line })));
	if (total > MAX_MEMORY_TOTAL_LENGTH) {
		return ephemeral(withText(memoryTotalTooLong(total), text));
	}
	const state = await loadMemory(env.DB, userId, guildId);
	const current = new Map(
		(state?.items ?? []).map((item) => [item.text, item] as const),
	);
	const items: MemoryItem[] = [...new Set(lines)].map(
		(line) =>
			current.get(line) ?? { text: line, userWritten: true, sources: [] },
	);
	await saveMemoryItems(env.DB, userId, guildId, items);
	log("edited", { userId, items: items.length });
	return update(memoryScreen(await loadMemory(env.DB, userId, guildId)));
}

/** 知らせの文の後に、書いた内容をコードブロックで付ける(1通に収まるように切る) */
function withText(message: string, text: string): string {
	const body = [...text.replaceAll("```", "'''")].slice(0, 1800).join("");
	return `${message}\n\`\`\`\n${body}\n\`\`\``;
}

function update(
	data: APIInteractionResponseCallbackData,
): APIInteractionResponse {
	return { type: InteractionResponseType.UpdateMessage, data };
}

function ephemeral(content: string): APIInteractionResponse {
	return {
		type: InteractionResponseType.ChannelMessageWithSource,
		data: { flags: MessageFlags.Ephemeral, content },
	};
}

function log(event: string, detail: Record<string, unknown>): void {
	logEvent("memory", event, detail);
}
