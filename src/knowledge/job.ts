import { createMessage, DiscordApiError } from "../discord/api";
import { type OwnKeyModel, ownKeyModel } from "../llm/own-key";
import { LlmError, type LlmErrorKind } from "../llm/types";
import { logEvent } from "../log";
import type { KnowledgeJob, KnowledgeProgress } from "../queue/messages";
import { attachmentKey } from "../respond/attachments";
import { historyFor } from "../respond/handler";
import { freshAttachment, type HistoryDeps } from "../respond/history";
import {
	describeLlmError,
	LLM_ERROR_TEXT,
	REFUSAL_TEXT,
} from "../respond/replies";
import { type Embedder, workersAiEmbedder } from "../store/embedding";
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
	saveKnowledgeVectorCount,
} from "../store/knowledge";
import { loadMessagesByIds } from "../store/messages";
import {
	type ConversionDeps,
	convertKnowledgeFile,
	type Download,
	downloadKnowledgeFile,
} from "./convert";
import { powerPointToPdf } from "./converter";
import { MAX_KNOWLEDGE_FILE_BYTES } from "./format";
import { discordProgressApi, refreshKnowledgeProgress } from "./progress";
import {
	forgetKnowledgeFiles,
	type KnowledgeFilesBucket,
	type KnowledgeStorage,
	saveKnowledgePdf,
} from "./storage";
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
import {
	deleteKnowledgeVectors,
	embedKnowledgeFile,
	type KnowledgeVectorStore,
	MAX_KNOWLEDGE_CHUNKS,
} from "./vectors";

/**
 * 知識チャンネルに送られたファイルを、文字にして要約する仕事(仕様: docs/spec/architecture.md「知識チャンネル」)。
 * 送った人のキーを確かめ、大きさを確かめてから、文字にして保存し、送った人のキーで要約する。
 * 知識に入ったら、中を探せるよう、文字にした内容を区切ってベクトルにする。
 * 受け付けないときと、文字にできないとき、要約できないときは、知識に加えず、ファイルのメッセージへの返信で知らせる。
 * 受け付けたときに見せ始めた進み具合(👀と返信)は、中身を読み取ったときと、読み込みが終わったときに見せ直す
 * (src/knowledge/progress.ts)
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
export interface KnowledgeJobDeps extends ConversionDeps, KnowledgeStorage {
	db: D1Database;
	/** PowerPointをPDFにしたものを置くR2のバケット */
	knowledgeFiles: KnowledgeFilesBucket;
	/** 中を探すためのベクトルを入れるVectorize */
	vectors: KnowledgeVectorStore;
	/** 文をベクトルにする(Workers AI) */
	embed: Embedder;
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
	/**
	 * ファイルのメッセージに、読み込みの進み具合を見せ直す。中身を読み取ったときと、読み込みが終わったときに呼ぶ。
	 * うまくいかなくても、例外にはしない
	 */
	showProgress: () => Promise<void>;
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
	// 消されたか(メッセージの削除や、知識チャンネルの解除)、もう済んでいる(同じ仕事が二度届いたときなど)。
	// 知識に入っていても、まだベクトルにしていなければ、ベクトルにする(やり直しと、この仕組みの前に入ったもの)
	if (
		file === null ||
		file.state === "rejected" ||
		(file.state === "ready" && file.vectorCount !== null)
	) {
		log("job_skipped", {
			fileId: job.fileId,
			reason: file === null ? "deleted" : file.state,
		});
		// 進み具合を見せていたら、片付ける(ほかのファイルの仕事が、まとめて知識に加えないことにしたときや、
		// 読み込み中に、メッセージが消されたときなど)
		await showProgress(env, job.progress);
		return;
	}
	await processKnowledgeFile(
		file,
		knowledgeJobDeps(env, file, job.progress),
		attempts,
	);
}

/** 本物のD1、Workers AI、DiscordのAPI、送った人のキーを使う。progressは、進み具合を見せている、ファイルのメッセージと返信 */
export function knowledgeJobDeps(
	env: Env,
	file: Pick<KnowledgeFile, "guildId" | "channelId">,
	progress?: KnowledgeProgress,
): KnowledgeJobDeps {
	return {
		db: env.DB,
		ai: env.AI,
		powerPointToPdf: (bytes) => powerPointToPdf(env.KNOWLEDGE_CONVERTER, bytes),
		knowledgeFiles: env.KNOWLEDGE_FILES,
		vectors: env.VECTORIZE,
		embed: workersAiEmbedder(env.AI),
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
		showProgress: () => showProgress(env, progress),
	};
}

/** 本物のD1とDiscordのAPIで、進み具合を見せ直す */
function showProgress(
	env: Env,
	progress: KnowledgeProgress | undefined,
): Promise<void> {
	return refreshKnowledgeProgress(
		env.DB,
		discordProgressApi(env.DISCORD_BOT_TOKEN),
		progress,
	);
}

/**
 * 受け付けた(pending)か、文字にした(converted)ファイルを、知識に入れ(か、知識に加えないと決めて知らせ)、
 * 知識に入ったら、ベクトルにする。知識に入っているファイルは、ベクトルにするだけ。
 * 読み込みが終わったら(ベクトルにする前に)、進み具合を見せ直す。中を探せるようになるのは、少し後になる
 */
export async function processKnowledgeFile(
	file: KnowledgeFile,
	deps: KnowledgeJobDeps,
	attempts: number,
): Promise<void> {
	const added =
		file.state === "ready" || (await addToKnowledge(file, deps, attempts));
	await deps.showProgress();
	if (!added) {
		return;
	}
	await embedFile(file.id, deps, attempts);
}

/** ファイルを、知識に入れる(か、知識に加えないと決めて知らせる)。知識に入ったらtrue */
async function addToKnowledge(
	file: KnowledgeFile,
	deps: KnowledgeJobDeps,
	attempts: number,
): Promise<boolean> {
	const [message] = await loadMessagesByIds(deps.db, [file.messageId]);
	const attachment = message?.attachments.find(
		(candidate) => attachmentKey(candidate) === file.attachmentId,
	);
	if (message === undefined || attachment === undefined) {
		// メッセージが消されたか、編集でファイルが外された(消す処理が先に動いていなければ、ここで消す)
		await forget(deps, file);
		log("job_skipped", { fileId: file.id, reason: "gone" });
		return false;
	}
	// メッセージに複数のファイルがあれば、どのファイルのことか分かるよう、返信の書き出しをファイル名にする
	const label = message.attachments.length > 1 ? file.filename : null;
	const reject = async (
		reason: KnowledgeRejection,
		content: string,
		detail: Record<string, unknown> = {},
	): Promise<void> => {
		// 知らせるのは、知識に加えないと決めたときの1回だけ。PowerPointをPDFにしたものを置いていたら、消す
		if (await rejectKnowledgeFile(deps.db, file.id, reason)) {
			await forgetKnowledgeFiles(deps, [file]);
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
			if (rejected.length > 0) {
				await forgetKnowledgeFiles(deps, rejected);
				await deps.reply(file.channelId, file.messageId, KNOWLEDGE_NO_KEY);
			}
			log("rejected", {
				...fileDetail(file),
				reason: "no_key",
				files: rejected.length,
			});
			return false;
		}
		if (attachment.size > MAX_KNOWLEDGE_FILE_BYTES) {
			await reject("too_large", knowledgeTooLarge(label));
			return false;
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
				await forget(deps, file);
				log("job_skipped", { fileId: file.id, reason: "gone" });
				return false;
			}
			const download = await deps.download(fresh.url);
			if (download.kind === "too_large") {
				await reject("too_large", knowledgeTooLarge(label));
				return false;
			}
			if (download.kind === "failed") {
				// ファイルが消えていた(メッセージを消す処理が、まだ届いていない)
				if (download.status === 404) {
					await forget(deps, file);
					log("job_skipped", { fileId: file.id, reason: "gone" });
					return false;
				}
				throw new Error(`ファイルを読めませんでした(${download.status})`);
			}
			const conversion = await convertKnowledgeFile(
				deps,
				file.format,
				download.bytes,
				file.filename,
			);
			if (conversion.kind === "unreadable") {
				await reject("unreadable", knowledgeUnreadable(label), {
					detail: conversion.detail,
				});
				return false;
			}
			// PowerPointは、AIがPDFのまま読めるよう、PDFにしたものをR2に置く
			if (conversion.pdf !== undefined) {
				await saveKnowledgePdf(deps.knowledgeFiles, file.id, conversion.pdf);
			}
			if (!(await saveKnowledgeText(deps.db, file.id, conversion.text))) {
				// 文字にしている間に、消されたか、知識に加えないことになった
				await forgetKnowledgeFiles(deps, [file]);
				log("job_skipped", { fileId: file.id, reason: "changed" });
				return false;
			}
			textLength = conversion.text.length;
			convertMs = Date.now() - startedAt;
			// 次は要約なので、進み具合の返信を書き換える
			await deps.showProgress();
		}
		return await summarize(file, deps, model, {
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
		return false;
	}
}

/**
 * 知識に入ったファイルを、中を探せるよう、区切ってベクトルにする(埋め込みとVectorizeは、運営者の負担)。
 * 失敗したら、Queueでやり直す。最後の回でも失敗したら、知らせずに終える(知識には入っているので、一覧と読む道具では使える。
 * 管理用エンドポイントで、ベクトルにし直せる)
 */
async function embedFile(
	fileId: number,
	deps: KnowledgeJobDeps,
	attempts: number,
): Promise<void> {
	const file = await loadKnowledgeFile(deps.db, fileId);
	if (file === null || file.state !== "ready" || file.vectorCount !== null) {
		return;
	}
	const startedAt = Date.now();
	let count: number;
	try {
		count = await embedKnowledgeFile(deps, file);
	} catch (error) {
		if (attempts < KNOWLEDGE_MAX_ATTEMPTS) {
			throw error;
		}
		// 途中まで入れた分は、IDが分からなくならないよう、入れうる分をまとめて消しておく
		await deleteKnowledgeVectors(deps.vectors, [
			{ id: file.id, vectorCount: MAX_KNOWLEDGE_CHUNKS },
		]);
		log("embed_failed", {
			...fileDetail(file),
			error: error instanceof Error ? error.name : "unknown",
		});
		return;
	}
	if (!(await saveKnowledgeVectorCount(deps.db, file.id, count))) {
		// ベクトルにしている間に、消された
		await deleteKnowledgeVectors(deps.vectors, [
			{ id: file.id, vectorCount: count },
		]);
		log("job_skipped", { fileId: file.id, reason: "changed" });
		return;
	}
	log("embedded", {
		...fileDetail(file),
		vectors: count,
		embedMs: Date.now() - startedAt,
	});
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
): Promise<boolean> {
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
		return false;
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
		return false;
	}
	if (!(await saveKnowledgeSummary(deps.db, file.id, summary))) {
		// 要約している間に、消されたか、知識に加えないことになった
		log("job_skipped", { fileId: file.id, reason: "changed" });
		return false;
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
	return true;
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

/** 知識のファイルを消す。PowerPointをPDFにしたものと、ベクトルを入れていたら、それも消す */
async function forget(
	deps: KnowledgeJobDeps,
	file: KnowledgeFile,
): Promise<void> {
	await forgetKnowledgeFiles(
		deps,
		await deleteKnowledgeFiles(deps.db, [file.id]),
	);
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
