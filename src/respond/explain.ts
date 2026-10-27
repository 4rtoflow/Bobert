import { createMessage, editOriginalInteractionResponse } from "../discord/api";
import { logEvent } from "../log";
import type { ExplainJob, StoredMessageInput } from "../queue/messages";
import { saveExplainTarget } from "../store/explain";
import { claimMessage, releaseMessage } from "../store/messages";
import { compactButtonRow } from "./compact-button";
import {
	answer,
	type ComposedReply,
	historyFor,
	notAnswer,
	recordConversationSize,
	startImport,
	withReplyModel,
} from "./handler";
import { splitMessage } from "./split";

/** 「Bobertに聞く」で、選んだ人の発言としてAIに渡す依頼(AIにだけ見せる) */
export const EXPLAIN_REQUEST = "上のメッセージの意味を説明して";

/**
 * 右クリックメニューの「Bobertに聞く」の仕事(仕様: docs/spec/behavior.md「スラッシュコマンド」の右クリックメニュー)。
 * 選んだ人のキーと設定で、メッセージの意味をAIに説明してもらい、保留にした応答(チャンネルに見える)を書き換えて投稿する。
 * 予期しない失敗は例外のままにして、Queueにやり直させる。
 */
export async function handleExplainJob(
	job: ExplainJob,
	env: Env,
): Promise<void> {
	// 同じInteractionで2回投稿しないため(Queueのやり直しなど)
	const claimId = `explain:${job.interactionId}`;
	if (!(await claimMessage(env.DB, claimId))) {
		log("duplicate", { userId: job.userId });
		return;
	}
	try {
		await explain(job, env);
	} catch (error) {
		await releaseMessage(env.DB, claimId);
		throw error;
	}
}

async function explain(job: ExplainJob, env: Env): Promise<void> {
	await startImport(env, job.channelId, job.guildId);
	const history = historyFor(env, {
		guildId: job.guildId,
		channelId: job.channelId,
		knownNames: [{ id: job.userId, name: job.userName }],
	});
	// 依頼は、選んだ人の発言として、頼まれた時刻を付けて渡す(この時刻が、今の日時にあたる)。
	// 説明するメッセージが返信でも、返信のつながりは最初から渡さず、AIが必要なときに返信先を読む道具で読む
	const request: StoredMessageInput = {
		messageId: `explain:${job.interactionId}`,
		guildId: job.guildId,
		channelId: job.channelId,
		authorId: job.userId,
		authorName: job.userName,
		authorIsBot: false,
		content: EXPLAIN_REQUEST,
		replyToId: null,
		mentions: [],
		attachments: [],
		embeds: [],
		command: null,
		members: [],
		createdAt: job.requestedAt,
		editedAt: null,
	};
	const reply = await withReplyModel(
		env,
		{ userId: job.userId, guildId: job.guildId },
		(context) =>
			answer(context, env, history, {
				messages: [job.target, request],
				summary: null,
				summaryUsages: [],
			}),
		notAnswer,
	);
	const posted = await postExplanation(env, job, reply);
	const [first] = posted;
	if (first !== undefined) {
		await recordExplainTarget(env, first, job.target.messageId);
	}
	if (reply.inputTokens !== null) {
		await recordConversationSize(env, posted, reply.inputTokens);
	}
}

/**
 * 説明を投稿する。最初のメッセージは、保留にした応答(チャンネルに見える)を書き換える。
 * 長ければ分けて、2通目からは前のメッセージへの返信にする(返信のつながりから会話全体をたどれるように)。
 * 返答に含まれるメンションでは、誰にも通知しない
 */
async function postExplanation(
	env: Env,
	job: ExplainJob,
	reply: ComposedReply,
): Promise<string[]> {
	const parts = splitMessage(reply.text);
	const posted: string[] = [];
	for (const [index, content] of parts.entries()) {
		// 要約を勧める案内は最後のメッセージの末尾にあるので、ボタンもそこに付ける
		const components =
			reply.offerCompaction && index === parts.length - 1
				? { components: [compactButtonRow()] }
				: {};
		const previous = posted.at(-1);
		const message =
			previous === undefined
				? await editOriginalInteractionResponse(
						env.DISCORD_APPLICATION_ID,
						job.interactionToken,
						{ content, allowed_mentions: { parse: [] }, ...components },
					)
				: await createMessage(env.DISCORD_BOT_TOKEN, job.channelId, {
						content,
						message_reference: {
							message_id: previous,
							fail_if_not_exists: false,
						},
						allowed_mentions: { parse: [], replied_user: false },
						...components,
					});
		posted.push(message.id);
	}
	return posted;
}

/**
 * 返答と、説明の対象のメッセージの対応を保存する。返答に返信して会話を続けたときに、説明の対象も会話に入れるため。
 * 投稿した後なので、保存できなくても失敗にはしない(やり直すと、同じ説明をもう一度投稿してしまうため)
 */
async function recordExplainTarget(
	env: Env,
	responseMessageId: string,
	targetMessageId: string,
): Promise<void> {
	try {
		await saveExplainTarget(env.DB, responseMessageId, targetMessageId);
	} catch (error) {
		log("record_target_failed", {
			error: error instanceof Error ? error.message : "unknown",
		});
	}
}

function log(event: string, detail: Record<string, unknown> = {}): void {
	logEvent("explain", event, detail);
}
