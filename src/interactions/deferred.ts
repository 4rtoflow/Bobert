import type {
	APIInteractionResponse,
	RESTPatchAPIWebhookWithTokenMessageJSONBody,
} from "discord-api-types/v10";
import { editOriginalInteractionResponse } from "../discord/api";
import { InteractionResponseType, MessageFlags } from "../discord/constants";
import { logEvent } from "../log";

/** 保留にしたメッセージの、新しい中身 */
export type MessageEdit = RESTPatchAPIWebhookWithTokenMessageJSONBody;

/**
 * 時間のかかる処理を、保留の応答を返してから続ける(最初の応答は3秒以内に返す必要があるため)。
 * 保留にしたメッセージを、処理が作った中身で書き換える。処理が失敗したら、failureの中身にする。
 * - reply: 本人にだけ見える、新しいメッセージを保留にする(コマンドなど)
 * - update: メニューなどがあるメッセージを、そのまま書き換える
 */
export function respondLater(
	ctx: ExecutionContext,
	interaction: { application_id: string; token: string },
	userId: string,
	mode: "reply" | "update",
	work: () => Promise<MessageEdit>,
	failure: MessageEdit,
): APIInteractionResponse {
	ctx.waitUntil(finish(interaction, userId, work, failure));
	return mode === "update"
		? { type: InteractionResponseType.DeferredMessageUpdate }
		: {
				type: InteractionResponseType.DeferredChannelMessageWithSource,
				data: { flags: MessageFlags.Ephemeral },
			};
}

async function finish(
	interaction: { application_id: string; token: string },
	userId: string,
	work: () => Promise<MessageEdit>,
	failure: MessageEdit,
): Promise<void> {
	let body: MessageEdit;
	try {
		body = await work();
	} catch (error) {
		log("deferred_work_failed", { userId, error: errorName(error) });
		body = failure;
	}
	try {
		await editOriginalInteractionResponse(
			interaction.application_id,
			interaction.token,
			body,
		);
	} catch (error) {
		log("interaction_edit_failed", { userId, error: errorName(error) });
	}
}

function errorName(error: unknown): string {
	return error instanceof Error ? error.name : "unknown";
}

function log(event: string, detail: Record<string, unknown>): void {
	logEvent("interactions", event, detail);
}
