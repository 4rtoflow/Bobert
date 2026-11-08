import { createMessage, DiscordApiError } from "../discord/api";
import { type OwnKeyModel, ownKeyModel } from "../llm/own-key";
import { LlmError, type LlmErrorKind } from "../llm/types";
import { logEvent } from "../log";
import type { KnowledgeJob } from "../queue/messages";
import { attachmentKey } from "../respond/attachments";
import { historyFor } from "../respond/handler";
import { freshAttachment, type HistoryDeps } from "../respond/history";
import {
	describeLlmError,
	LLM_ERROR_TEXT,
	REFUSAL_TEXT,
} from "../respond/replies";
import {
	deleteKnowledgeFiles,
	type KnowledgeFile,
	type KnowledgeRejection,
	loadKnowledgeFile,
	loadKnowledgeText,
	rejectKnowledgeFile,
	rejectPendingKnowledgeFiles,
	saveKnowledgeSummary,
	saveKnowledgeText,
} from "../store/knowledge";
import { loadMessagesByIds } from "../store/messages";
import {
	convertKnowledgeFile,
	type Download,
	downloadKnowledgeFile,
	type MarkdownConverter,
} from "./convert";
import { MAX_KNOWLEDGE_FILE_BYTES } from "./format";
import {
	KNOWLEDGE_SUMMARY_MODEL_KEY,
	MAX_SUMMARY_INPUT_CHARS,
	normalizeSummary,
	summaryHead,
	summaryRequest,
} from "./summarize";
import {
	KNOWLEDGE_NO_KEY,
	knowledgeRetryFailed,
	knowledgeSummaryFailed,
	knowledgeTooLarge,
	knowledgeUnreadable,
} from "./texts";

/**
 * 知識チャンネルに送られたファイルを、文字にして要約する仕事(仕様: docs/spec/architecture.md「知識チャンネル」)。
 * 送った人のキーを確かめ、大きさを確かめてから、文字にして保存し、送った人のキーで要約する。
 * 受け付けないときと、文字にできないとき、要約できないときは、知識に加えず、ファイルのメッセージへの返信で知らせる。
 * うまくいったときは、何も表示しない
 */

/** この仕事を運ぶQueue(RESPOND_QUEUE)で、1つの仕事を試す回数(wrangler.jsonc の max_retries は2) */
export const KNOWLEDGE_MAX_ATTEMPTS = 3;

/** やり直すまでの待ち時間(秒)。レート制限や混雑は、少し待てば通ることがあるため */
export const KNOWLEDGE_RETRY_DELAY_SECONDS = 60;

/** AIの呼び出しの失敗のうち、やり直せば通るかもしれないもの。ほかの失敗(キーが無効、残高不足など)は、やり直さずに知らせる */
const TRANSIENT_LLM_ERRORS: ReadonlySet<LlmErrorKind> = new Set([
	"rate_limited",
	"unavailable",
	"unknown",
]);

/** 仕事に使うもの。テストでは偽物に差し替える */
export interface KnowledgeJobDeps {
	db: D1Database;
	/** Workers AIの、文字(Markdown)への変換 */
	ai: MarkdownConverter;
	/** ファイルのメッセージを読み直して、添付ファイルのURLを取り直すのに使う */
	history: Pick<HistoryDeps, "fetchMessage" | "ingest" | "guildId">;
	/** ファイルを、DiscordのCDNから読む */
	download: (url: string) => Promise<Download>;
	/** 送った人のキーで呼ぶ、要約のモデル。呼べるキーがなければnull */
	summaryModel: (userId: string) => Promise<OwnKeyModel | null>;
	/** ファイルのメッセージに、返信で知らせる。送れなくても、例外にはしない */
	reply: (
		channelId: string,
		messageId: string,
		content: string,
	) => Promise<void>;
}

/**
 * 知識のファイルの仕事。attemptsは、この仕事を試した回数(1から)。
 * やり直せば通るかもしれない失敗は、例外のままにして、Queueにやり直させる。最後の回でも失敗したら、知らせて終える
 */
export async function handleKnowledgeJob(
	job: KnowledgeJob,
	env: Env,
	attempts = 1,
): Promise<void> {
	const file = await loadKnowledgeFile(env.DB, job.fileId);
	// 消されたか(メッセージの削除や、知識チャンネルの解除)、もう済んでいる(同じ仕事が二度届いたときなど)
	if (file === null || file.state === "ready" || file.state === "rejected") {
		log("job_skipped", {
			fileId: job.fileId,
			reason: file === null ? "deleted" : file.state,
		});
		return;
	}
	await processKnowledgeFile(file, knowledgeJobDeps(env, file), attempts);
}

/** 本物のD1、Workers AI、DiscordのAPI、送った人のキーを使う */
export function knowledgeJobDeps(
	env: Env,
	file: Pick<KnowledgeFile, "guildId" | "channelId">,
): KnowledgeJobDeps {
	return {
		db: env.DB,
		ai: env.AI,
		history: historyFor(env, {
			guildId: file.guildId,
			channelId: file.channelId,
			knownNames: [],
		}),
		download: downloadKnowledgeFile,
		summaryModel: (userId) =>
			ownKeyModel(env, userId, KNOWLEDGE_SUMMARY_MODEL_KEY),
		reply: (channelId, messageId, content) =>
			replyToFile(env.DISCORD_BOT_TOKEN, channelId, messageId, content),
	};
}

/** 受け付けた(pending)か、文字にした(converted)ファイルを、知識に入れる(か、知識に加えないと決めて知らせる) */
export async function processKnowledgeFile(
	file: KnowledgeFile,
	deps: KnowledgeJobDeps,
	attempts: number,
): Promise<void> {
	const [message] = await loadMessagesByIds(deps.db, [file.messageId]);
	const attachment = message?.attachments.find(
		(candidate) => attachmentKey(candidate) === file.attachmentId,
	);
	if (message === undefined || attachment === undefined) {
		// メッセージが消されたか、編集でファイルが外された(消す処理が先に動いていなければ、ここで消す)
		await deleteKnowledgeFiles(deps.db, [file.id]);
		log("job_skipped", { fileId: file.id, reason: "gone" });
		return;
	}
	// メッセージに複数のファイルがあれば、どのファイルのことか分かるよう、返信の書き出しをファイル名にする
	const label = message.attachments.length > 1 ? file.filename : null;
	const reject = async (
		reason: KnowledgeRejection,
		content: string,
		detail: Record<string, unknown> = {},
	): Promise<void> => {
		// 知らせるのは、知識に加えないと決めたときの1回だけ
		if (await rejectKnowledgeFile(deps.db, file.id, reason)) {
			await deps.reply(file.channelId, file.messageId, content);
		}
		log("rejected", { ...fileDetail(file), reason, attempts, ...detail });
	};
	try {
		// 要約の費用は送った人のキーにかけるので、キーがなければ受け付けない(寄付は使わない)。
		// 同じメッセージのほかのファイルも、まとめて受け付けないことにして、知らせるのは1回だけにする
		const model = await deps.summaryModel(file.authorId);
		if (model === null) {
			const rejected = await rejectPendingKnowledgeFiles(
				deps.db,
				file.messageId,
				"no_key",
			);
			if (rejected > 0) {
				await deps.reply(file.channelId, file.messageId, KNOWLEDGE_NO_KEY);
			}
			log("rejected", {
				...fileDetail(file),
				reason: "no_key",
				files: rejected,
			});
			return;
		}
		if (attachment.size > MAX_KNOWLEDGE_FILE_BYTES) {
			await reject("too_large", knowledgeTooLarge(label));
			return;
		}
		let textLength = file.textLength;
		let convertMs: number | null = null;
		if (file.state === "pending") {
			const startedAt = Date.now();
			// 保存したURLは約24時間で切れるので、期限が近ければ、メッセージを読み直して取り直す
			const fresh = await freshAttachment(
				{ channelId: file.channelId, messageId: file.messageId },
				attachment,
				deps.history,
			);
			if (fresh === null) {
				await deleteKnowledgeFiles(deps.db, [file.id]);
				log("job_skipped", { fileId: file.id, reason: "gone" });
				return;
			}
			const download = await deps.download(fresh.url);
			if (download.kind === "too_large") {
				await reject("too_large", knowledgeTooLarge(label));
				return;
			}
			if (download.kind === "failed") {
				// ファイルが消えていた(メッセージを消す処理が、まだ届いていない)
				if (download.status === 404) {
					await deleteKnowledgeFiles(deps.db, [file.id]);
					log("job_skipped", { fileId: file.id, reason: "gone" });
					return;
				}
				throw new Error(`ファイルを読めませんでした(${download.status})`);
			}
			const conversion = await convertKnowledgeFile(
				deps.ai,
				file.format,
				download.bytes,
				file.filename,
			);
			if (conversion.kind === "unreadable") {
				await reject("unreadable", knowledgeUnreadable(label), {
					detail: conversion.detail,
				});
				return;
			}
			if (!(await saveKnowledgeText(deps.db, file.id, conversion.text))) {
				// 文字にしている間に、消されたか、知識に加えないことになった
				log("job_skipped", { fileId: file.id, reason: "changed" });
				return;
			}
			textLength = conversion.text.length;
			convertMs = Date.now() - startedAt;
		}
		await summarize(file, deps, model, {
			label,
			textLength: textLength ?? 0,
			convertMs,
			reject,
		});
	} catch (error) {
		if (attempts < KNOWLEDGE_MAX_ATTEMPTS) {
			throw error;
		}
		// やり直しても失敗した(障害など)
		await reject("retry_failed", knowledgeRetryFailed(label), {
			error: error instanceof Error ? error.name : "unknown",
			...(error instanceof LlmError
				? { kind: error.kind, status: error.status }
				: {}),
		});
	}
}

/**
 * 文字にした内容の先頭を、送った人のキーで要約し、知識に入れる。
 * キーが無効、残高不足、AIに断られたなどで要約できなければ、知識に加えず、メンションへの返答のエラーと同じ文で知らせる。
 * レート制限などのやり直せば通るかもしれない失敗は、例外のままにする(Queueでやり直す)
 */
async function summarize(
	file: KnowledgeFile,
	deps: KnowledgeJobDeps,
	model: OwnKeyModel,
	context: {
		label: string | null;
		textLength: number;
		convertMs: number | null;
		reject: (
			reason: KnowledgeRejection,
			content: string,
			detail?: Record<string, unknown>,
		) => Promise<void>;
	},
): Promise<void> {
	const { label, textLength, reject } = context;
	const startedAt = Date.now();
	const loaded = await loadKnowledgeText(
		deps.db,
		file.id,
		0,
		MAX_SUMMARY_INPUT_CHARS,
	);
	const head = summaryHead(loaded.text);
	let result: Awaited<ReturnType<OwnKeyModel["call"]>>;
	try {
		result = await model.call(
			summaryRequest(model.resolved.modelId, file.filename, head, textLength),
		);
	} catch (error) {
		if (!(error instanceof LlmError) || TRANSIENT_LLM_ERRORS.has(error.kind)) {
			throw error;
		}
		await reject(
			"summary_failed",
			knowledgeSummaryFailed(label, describeLlmError(error, model.resolved)),
			{
				provider: model.resolved.provider,
				kind: error.kind,
				status: error.status,
			},
		);
		return;
	}
	const summary =
		result.stopReason === "refusal" ? "" : normalizeSummary(result.text);
	if (summary === "") {
		await reject(
			"summary_failed",
			knowledgeSummaryFailed(
				label,
				result.stopReason === "refusal" ? REFUSAL_TEXT : LLM_ERROR_TEXT,
			),
			{
				provider: model.resolved.provider,
				stopReason: result.stopReason,
				...result.usage,
			},
		);
		return;
	}
	if (!(await saveKnowledgeSummary(deps.db, file.id, summary))) {
		// 要約している間に、消されたか、知識に加えないことになった
		log("job_skipped", { fileId: file.id, reason: "changed" });
		return;
	}
	// ファイル名、中身、要約は残さない
	log("added", {
		...fileDetail(file),
		provider: model.resolved.provider,
		textLength,
		convertMs: context.convertMs,
		summaryMs: Date.now() - startedAt,
		...result.usage,
	});
}

/**
 * ファイルのメッセージに、返信で知らせる。送った人には通知する(送り直すなど、やることがあるため)。
 * 送れなくても(権限がない、メッセージが消えたなど)、知識に加えないことは変わらないので、記録だけ残す
 */
async function replyToFile(
	token: string,
	channelId: string,
	messageId: string,
	content: string,
): Promise<void> {
	try {
		await createMessage(token, channelId, {
			content,
			message_reference: { message_id: messageId, fail_if_not_exists: true },
			allowed_mentions: { parse: [], replied_user: true },
		});
	} catch (error) {
		log("reply_failed", {
			channelId,
			status: error instanceof DiscordApiError ? error.status : null,
		});
	}
}

/** ログに残す、ファイルの情報(ファイル名は残さない) */
function fileDetail(file: KnowledgeFile): Record<string, unknown> {
	return {
		fileId: file.id,
		guildId: file.guildId,
		userId: file.authorId,
		format: file.format,
		size: file.size,
	};
}

function log(event: string, detail: Record<string, unknown>): void {
	logEvent("knowledge", event, detail);
}
