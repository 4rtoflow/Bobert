import type {
	APIInteractionResponse,
	RESTPatchAPIWebhookWithTokenMessageJSONBody,
} from "discord-api-types/v10";
import {
	createFollowupMessage,
	editOriginalInteractionResponse,
	type MessageFile,
} from "../discord/api";
import { InteractionResponseType, MessageFlags } from "../discord/constants";
import { logEvent } from "../log";

/** 保留にしたメッセージの、新しい中身。filesを付けると、それを添付する */
export type MessageEdit = RESTPatchAPIWebhookWithTokenMessageJSONBody & {
	files?: MessageFile[];
};

/** 本人にだけ見せる、新しいメッセージ */
export interface EphemeralReply {
	content: string;
	files?: MessageFile[];
}

/** 保留にした後の結果。updateは元のメッセージを書き換え、replyは本人にだけ見える新しいメッセージを送る */
export type DeferredResult =
	| { update: MessageEdit }
	| { reply: EphemeralReply };

interface InteractionToken {
	application_id: string;
	token: string;
}

/**
 * 時間のかかる処理を、保留の応答を返してから続ける(最初の応答は3秒以内に返す必要があるため)。
 * 保留にしたメッセージを、処理が作った中身で書き換える。処理が失敗したら、failureの中身にする。
 * - reply: 本人にだけ見える、新しいメッセージを保留にする(コマンドなど)
 * - update: メニューなどがあるメッセージを、そのまま書き換える
 */
export function respondLater(
	ctx: ExecutionContext,
	interaction: InteractionToken,
	userId: string,
	mode: "reply" | "update",
	work: () => Promise<MessageEdit>,
	failure: MessageEdit,
): APIInteractionResponse {
	ctx.waitUntil(
		finish(interaction, userId, async () => ({ update: await work() }), {
			update: failure,
		}),
	);
	return mode === "update"
		? { type: InteractionResponseType.DeferredMessageUpdate }
		: {
				type: InteractionResponseType.DeferredChannelMessageWithSource,
				data: { flags: MessageFlags.Ephemeral },
			};
}

/**
 * ボタンから開いたモーダルの送信などで、元のメッセージを書き換えるか、本人にだけ見える新しいメッセージを送るかを、
 * 処理の結果で決める。先に、元のメッセージを書き換える保留の応答を返す(書き換えるまで、元のメッセージはそのまま)。
 * 処理が失敗したら、failureを本人にだけ見せる
 */
export function updateOrReplyLater(
	ctx: ExecutionContext,
	interaction: InteractionToken,
	userId: string,
	work: () => Promise<DeferredResult>,
	failure: EphemeralReply,
): APIInteractionResponse {
	ctx.waitUntil(finish(interaction, userId, work, { reply: failure }));
	return { type: InteractionResponseType.DeferredMessageUpdate };
}

async function finish(
	interaction: InteractionToken,
	userId: string,
	work: () => Promise<DeferredResult>,
	failure: DeferredResult,
): Promise<void> {
	let result: DeferredResult;
	try {
		result = await work();
	} catch (error) {
		log("deferred_work_failed", { userId, error: errorName(error) });
		result = failure;
	}
	if ("update" in result) {
		const { files, ...body } = result.update;
		try {
			await editOriginalInteractionResponse(
				interaction.application_id,
				interaction.token,
				body,
				files,
			);
		} catch (error) {
			log("interaction_edit_failed", { userId, error: errorName(error) });
		}
		return;
	}
	try {
		await createFollowupMessage(
			interaction.application_id,
			interaction.token,
			{ content: result.reply.content, flags: MessageFlags.Ephemeral },
			result.reply.files,
		);
	} catch (error) {
		log("interaction_followup_failed", { userId, error: errorName(error) });
	}
}

function errorName(error: unknown): string {
	return error instanceof Error ? error.name : "unknown";
}

function log(event: string, detail: Record<string, unknown>): void {
	logEvent("interactions", event, detail);
}
