import { createMessage, editOriginalInteractionResponse } from "../discord/api";
import type { JevError } from "../jev/api";
import { formatJevAnswers } from "../jev/format";
import { JEV_REQUEST, JEV_SYSTEM_PROMPT } from "../jev/prompt";
import {
	JEV_ERROR,
	JEV_NO_QUESTION,
	JEV_NO_TOOLS,
	TYPESAFE_KEY_INVALID,
	TYPESAFE_KEY_REQUIRED,
} from "../jev/texts";
import { askJevTool, emptyJevOutcome, type JevOutcome } from "../jev/tool";
import type { ChatResult } from "../llm/types";
import { logEvent } from "../log";
import type { JevJob, StoredMessageInput } from "../queue/messages";
import { saveExplainTarget } from "../store/explain";
import { claimMessage, releaseMessage } from "../store/messages";
import { loadTypeSafeKey } from "../store/typesafe";
import { voiceReaderFor } from "../voice/reader";
import { FileCatalog } from "./attachments";
import { toConversation } from "./conversation";
import {
	fileSupport,
	historyFor,
	pinListerFor,
	type ReplyModel,
	withReplyModel,
} from "./handler";
import { annotationsFor, refreshImageUrls } from "./history";
import { allowedMentions } from "./members";
import { selectedCandidate } from "./model";
import { paidNote } from "./payer";
import { RATE_LIMITED_TEXT, REFUSAL_TEXT } from "./replies";
import { splitMessage } from "./split";
import { threadPreface } from "./thread";
import {
	channelHistoryTool,
	channelListTool,
	type FileReads,
	pinnedMessagesTool,
	readFileTool,
	replyChainTool,
	searchMessagesTool,
	startsWithReply,
	toolsAvailable,
} from "./tools";
import { usageNote } from "./usage";

/** AIの出力の長さの上限(トークン)。考える分(thinking)と、道具への入力もここに含まれる */
const MAX_OUTPUT_TOKENS = 16_000;

/**
 * 右クリックメニューの「Jevに聞く」の仕事(仕様: docs/spec/architecture.md「Jevに聞く」)。
 * 選んだ人のキーと設定のモデルに、Jevへの質問を作ってもらい、選んだ人のTypeSafeのキーでJevに聞く。
 * 保留にした応答(チャンネルに見える)を、Jevの回答に書き換えて投稿する。
 * 予期しない失敗は例外のままにして、Queueにやり直させる。
 */
export async function handleJevJob(job: JevJob, env: Env): Promise<void> {
	// 同じInteractionで2回投稿しないため(Queueのやり直しなど)
	const claimId = `jev:${job.interactionId}`;
	if (!(await claimMessage(env.DB, claimId))) {
		log("duplicate", { userId: job.userId });
		return;
	}
	try {
		await askAndPost(job, env);
	} catch (error) {
		await releaseMessage(env.DB, claimId);
		throw error;
	}
}

async function askAndPost(job: JevJob, env: Env): Promise<void> {
	const apiKey = await loadTypeSafeKey(env, job.userId);
	// 右クリックメニューで選んだ後に、/delete でキーを消した
	const text =
		apiKey === null
			? TYPESAFE_KEY_REQUIRED
			: await withReplyModel(
					env,
					{ userId: job.userId, guildId: job.guildId },
					(context) => askJevWith(context, env, job, apiKey),
					(guidance) => guidance,
				);
	const [first] = await postResult(env, job, text);
	if (first !== undefined) {
		await recordTarget(env, first, job.target.messageId);
	}
}

/**
 * 本人の設定のモデルに、Jevへの質問を作ってもらい、Jevに聞く。投稿する本文を返す。
 * AIには、対象のメッセージと、選んだ人からの依頼(AIにだけ見せる)を、選んだ時刻を付けて渡す。
 * AIは、過去のメッセージを読む道具で文脈を調べ、Jevに聞く道具を呼ぶ。Jevが答えたら、やり取りを終える
 */
async function askJevWith(
	context: ReplyModel,
	env: Env,
	job: JevJob,
	apiKey: string,
): Promise<string> {
	const { userId, settings, model } = context;
	// 文脈を調べる道具と、Jevに聞く道具が要る
	if (!(await toolsAvailable(settings, model))) {
		log("no_tools", { userId, provider: model.provider, model: model.modelId });
		return JEV_NO_TOOLS;
	}
	const botUserId = env.DISCORD_APPLICATION_ID;
	const history = historyFor(env, {
		guildId: job.guildId,
		channelId: job.channelId,
		knownNames: [{ id: job.userId, name: job.userName }],
	});
	const request: StoredMessageInput = {
		messageId: `jev:${job.interactionId}`,
		guildId: job.guildId,
		channelId: job.channelId,
		authorId: job.userId,
		authorName: job.userName,
		authorIsBot: false,
		content: JEV_REQUEST,
		replyToId: null,
		mentions: [],
		attachments: [],
		embeds: [],
		command: null,
		members: [],
		createdAt: job.requestedAt,
		editedAt: null,
	};
	// 対象のメッセージの画像は、モデルが読めれば最初から渡す。ほかの添付ファイルには番号を付け、ファイルを読む道具で読めるようにする
	// (仕様: docs/spec/architecture.md「添付ファイルの読み取り」)
	const support = await fileSupport(model, settings);
	const includeImages = job.target.attachments.length > 0 && support.images;
	const chain = includeImages
		? await refreshImageUrls([job.target, request], history, botUserId)
		: [job.target, request];
	// 対象のメッセージが音声メッセージなら、文字にして渡す(仕様: docs/spec/architecture.md「音声メッセージ」)
	const voice = voiceReaderFor(env, history);
	const voiceTexts = await voice.prepare(chain);
	const files = new FileCatalog(support);
	const preface = await threadPreface(history, chain, botUserId, files);
	const annotations = await annotationsFor(chain, history);
	const conversation = toConversation(chain, {
		botUserId,
		includeImages,
		...annotations,
		voice: new Map([...annotations.voice, ...voiceTexts]),
		summary: null,
		files,
		preface,
	});
	const outcome = emptyJevOutcome();
	const fileReads: FileReads = { calls: 0, kinds: [] };
	// 文脈を調べる道具(過去のメッセージを読む道具と、ファイルを読む道具)と、Jevに聞く道具を渡す。
	// 対象のメッセージが返信なら、返信先を読む道具も渡す。道具の定義は、毎回同じ並びにする(キャッシュのため)
	const tools = [
		channelHistoryTool(history, botUserId, files),
		searchMessagesTool(history, botUserId, files),
		channelListTool(history),
		pinnedMessagesTool(
			history,
			botUserId,
			pinListerFor(env.DISCORD_BOT_TOKEN),
			files,
		),
		readFileTool(files, history, fileReads, voice),
		...(startsWithReply(job.target)
			? [replyChainTool(job.target, history, botUserId, files)]
			: []),
		askJevTool(apiKey, job.target, outcome),
	];
	const startedAt = Date.now();
	const result = await context.callModel({
		model: model.modelId,
		system: [JEV_SYSTEM_PROMPT],
		messages: conversation.messages,
		effort: context.effort,
		webSearch: false,
		tools,
		maxTokens: MAX_OUTPUT_TOKENS,
	});
	log(outcome.answered !== null ? "answered" : "not_answered", {
		userId,
		provider: model.provider,
		model: model.modelId,
		payer: context.payer.kind,
		stopReason: result.stopReason,
		durationMs: Date.now() - startedAt,
		toolCalls: result.toolCalls,
		jevCalls: outcome.calls,
		jevError: outcome.error?.kind ?? null,
		jevModel: outcome.answered?.response.model ?? null,
		jevInputTokens: outcome.answered?.response.usage.inputTokens ?? null,
		// 読んだファイルは、種類だけを残す(名前と中身は残さない)
		fileReads: fileReads.calls,
		...result.usage,
	});
	// 利用量の表示と寄付の行は、AIの分だけ。Jevの費用は、本人のTypeSafeのアカウントにかかる
	const notes = [
		settings.featUsageDisplay
			? await usageNote(
					result.requestUsages,
					model,
					selectedCandidate(settings),
				)
			: null,
		await paidNote(env, context.payer),
	].filter((line) => line !== null);
	return [resultBody(outcome, result), ...notes].join("\n");
}

/** 投稿する本文。Jevが答えたら、その回答。答えなければ、その理由 */
function resultBody(outcome: JevOutcome, result: ChatResult): string {
	if (outcome.answered !== null) {
		return formatJevAnswers(
			outcome.answered.questions,
			outcome.answered.response,
		);
	}
	if (outcome.error !== null) {
		return describeJevError(outcome.error);
	}
	return result.stopReason === "refusal" ? REFUSAL_TEXT : JEV_NO_QUESTION;
}

/** Jevの呼び出しに失敗したときの、短い理由 */
function describeJevError(error: JevError): string {
	switch (error.kind) {
		case "invalid_key":
			return TYPESAFE_KEY_INVALID;
		case "rate_limited":
			return RATE_LIMITED_TEXT;
		default:
			return JEV_ERROR;
	}
}

/**
 * 結果を投稿する。最初のメッセージは、保留にした応答(チャンネルに見える)を書き換える。
 * 長ければ分けて、2通目からは前のメッセージへの返信にする(返信のつながりから、全体をたどれるように)。
 * AIが書いた文にメンションがあっても、誰にも通知しない
 */
async function postResult(
	env: Env,
	job: JevJob,
	text: string,
): Promise<string[]> {
	const posted: string[] = [];
	for (const content of splitMessage(text)) {
		const previous = posted.at(-1);
		const message =
			previous === undefined
				? await editOriginalInteractionResponse(
						env.DISCORD_APPLICATION_ID,
						job.interactionToken,
						{ content, allowed_mentions: allowedMentions([]) },
					)
				: await createMessage(env.DISCORD_BOT_TOKEN, job.channelId, {
						content,
						message_reference: {
							message_id: previous,
							fail_if_not_exists: false,
						},
						allowed_mentions: allowedMentions([], false),
					});
		posted.push(message.id);
	}
	return posted;
}

/**
 * 結果と、対象のメッセージの対応を保存する。結果に返信して会話を続けたときに、対象のメッセージも会話に入れるため。
 * 「Bobertに聞く」と同じ記録を使う。投稿した後なので、保存できなくても失敗にはしない
 * (やり直すと、同じ結果をもう一度投稿してしまうため)
 */
async function recordTarget(
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
	logEvent("jev", event, detail);
}
