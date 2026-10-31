import type { APIMessage } from "discord-api-types/v10";
import { getAgentChannel } from "../agent/store";
import {
	createMessage,
	DiscordApiError,
	getChannelMessage,
	getChannelMessages,
	getChannelPins,
	triggerTyping,
} from "../discord/api";
import { chatWithAnthropic } from "../llm/anthropic";
import { findOpenRouterModel } from "../llm/model-info";
import { chatWithOpenRouter } from "../llm/openrouter";
import {
	type ChatRequest,
	type ChatResult,
	LlmError,
	sumUsage,
	type TokenUsage,
} from "../llm/types";
import { logEvent } from "../log";
import type {
	QueueMessage,
	RespondJob,
	StoredMessageInput,
} from "../queue/messages";
import { workersAiEmbedder } from "../store/embedding";
import { claimMessage, releaseMessage } from "../store/messages";
import { searchSimilarMessages } from "../store/search";
import { listSkills } from "../store/skills";
import {
	type ConversationSummary,
	claimCompactionNotice,
	recordReplyUsage,
} from "../store/summaries";
import {
	type Credential,
	getUserSettings,
	type UserSettings,
} from "../store/users";
import { FileCatalog, type FileSupport } from "./attachments";
import { compactButtonRow } from "./compact-button";
import { toConversation } from "./conversation";
import { replyEffort } from "./effort";
import {
	fromDiscord,
	type HistoryDeps,
	type MessageFetcher,
	namesFor,
	type PinLister,
	readConversation,
	refreshImageUrls,
} from "./history";
import {
	allowedMentions,
	findMembersTool,
	memberDirectoryLoader,
	notifiedUsersByPart,
} from "./members";
import {
	type ResolvedModel,
	selectedCandidate,
	usesCustomModel,
} from "./model";
import {
	chargeDonationFor,
	type PaidModel,
	type Payer,
	paidNote,
	pauseIfDonorKeyFailed,
	resolvePaidModel,
} from "./payer";
import { buildSystemPrompt } from "./prompt";
import { describeLlmError, formatReply } from "./replies";
import { splitMessage } from "./split";
import {
	conversationSize,
	inputLimit,
	KEEP_RECENT_MESSAGES,
	priceIncreaseThreshold,
	SUMMARY_THRESHOLD,
	summarizeOlderPart,
} from "./summary";
import {
	channelHistoryTool,
	channelListTool,
	type FileReads,
	pinnedMessagesTool,
	readFileTool,
	readSkillTool,
	replyChainTool,
	type SkillReads,
	searchMessagesTool,
	startsWithReply,
	toolsAvailable,
} from "./tools";
import { usageNote } from "./usage";
import { webSearchAvailable } from "./web-search";

/** 返答の長さの上限(トークン)。考える分(thinking)もここに含まれる */
const MAX_OUTPUT_TOKENS = 16_000;
/** 「入力中…」を送り直す間隔。表示は約10秒で消えるため */
const TYPING_INTERVAL_MS = 8_000;
/** 保存用のQueueに1回で入れる仕事の数。1回で送れる大きさ(256KB)に収めるため */
const INGEST_BATCH_SIZE = 10;

/**
 * メンションや返信に、AIの返答を投稿する(Queueの応答用の仕事)。
 * 予期しない失敗は例外のままにして、Queueにやり直させる。
 */
export async function handleRespondJob(
	job: RespondJob,
	env: Env,
): Promise<void> {
	if (!(await claimMessage(env.DB, job.messageId))) {
		log("duplicate", { userId: job.authorId });
		return;
	}
	try {
		await respond(job, env);
	} catch (error) {
		await releaseMessage(env.DB, job.messageId);
		throw error;
	}
}

async function respond(job: RespondJob, env: Env): Promise<void> {
	// エージェントのチャンネルでは、普通のBobertは返答しない。
	// Gatewayは記録を覚えて振り分けるが、作った直後などに、ここまで届くことがあるため
	if ((await getAgentChannel(env.DB, job.channelId)) !== null) {
		log("agent_channel", { userId: job.authorId });
		return;
	}
	const token = env.DISCORD_BOT_TOKEN;
	// 話しかけたメッセージは、保存より先に応答の処理が動くことがあり、消されていないかも確かめたいので、Discordから読む
	const trigger = await getMessageOrNull(token, job.channelId, job.messageId);
	if (trigger === null) {
		// 返答する前に消されたか、読む権限がない
		log("trigger_unavailable", { userId: job.authorId });
		return;
	}
	const history = historyFor(env, {
		guildId: job.guildId,
		channelId: job.channelId,
		knownNames: job.members ?? [],
	});

	const stopTyping = startTyping(token, job.channelId);
	try {
		const reply = await composeReply(
			job,
			env,
			fromDiscord(trigger, job.guildId),
			history,
		);
		const posted = await postReply(
			token,
			trigger,
			reply.text,
			reply.offerCompaction,
		);
		if (reply.inputTokens !== null) {
			await recordConversationSize(env, posted, reply.inputTokens);
		}
	} finally {
		stopTyping();
	}
}

/**
 * 過去のメッセージの読み先(保存したもの、Discord、検索)。
 * knownNamesは、Gatewayで届いたメッセージで分かった、サーバーで見えている名前
 */
export function historyFor(
	env: Env,
	location: {
		guildId: string | null;
		channelId: string;
		knownNames: HistoryDeps["knownNames"];
	},
): HistoryDeps {
	const token = env.DISCORD_BOT_TOKEN;
	const fetchMessage: MessageFetcher = (channelId, messageId) =>
		getMessageOrNull(token, channelId, messageId);
	return {
		db: env.DB,
		guildId: location.guildId,
		channelId: location.channelId,
		fetchMessage,
		listMessages: (channelId, options) =>
			getChannelMessages(token, channelId, options),
		searchMessages: (query, { scope, ...options }) =>
			searchSimilarMessages(
				query,
				{
					...options,
					scope:
						scope === "server" && location.guildId !== null
							? { kind: "server", guildId: location.guildId }
							: { kind: "channel", channelId: location.channelId },
				},
				{ embed: workersAiEmbedder(env.AI), vectors: env.VECTORIZE },
			),
		ingest: (messages) => enqueueIngest(env, messages),
		knownNames: location.knownNames,
	};
}

/** Discordから、チャンネルのピン留めされたメッセージを読む(ピン留めを読む道具で使う) */
function pinListerFor(token: string): PinLister {
	return async (channelId) => {
		const pins = await getChannelPins(token, channelId);
		return {
			messages: pins.items.map((item) => item.message),
			hasMore: pins.has_more,
		};
	};
}

/**
 * 投稿する返答。AIの返答なら、会話全体を渡した入力のトークン数も(会話の量の記録に使う)。
 * offerCompactionなら、要約を勧める案内を添えたので、「今すぐ要約」ボタンを付ける
 */
export interface ComposedReply {
	text: string;
	inputTokens: number | null;
	offerCompaction: boolean;
}

/** 返答を作るのに使う、本人の設定とモデル */
export interface ReplyModel {
	userId: string;
	settings: UserSettings;
	model: ResolvedModel;
	/** 費用を払う人のキー(寄付で答えるときは、寄付した人のキー) */
	credential: Credential;
	/** 費用を払う人(本人か、サーバーに寄付した人) */
	payer: Payer;
	/** 設定していなければ既定の段階、モデルが選べなければいちばん近い段階 */
	effort: string | null;
	/** AIを呼ぶ。寄付で答えるときは、呼んだ分の費用を寄付から差し引く */
	callModel: (request: ChatRequest) => Promise<ChatResult>;
}

/**
 * 本人の設定とモデルで、返答を作る(メンションへの返答、「Bobertに聞く」、要約で共通)。
 * サーバーに寄付があれば、寄付した人のキーで答える(仕様: docs/spec/llm-cost.md「クレジットの寄付」)。
 * キーを登録していなければ登録方法の案内を、AIの呼び出しに失敗したら理由を、notAnswerで返す。
 * 寄付した人のキーが無効か残高不足なら、その寄付を止めて、次の寄付か本人のキーで答え直す
 */
export async function withReplyModel<T>(
	env: Env,
	requester: { userId: string; guildId: string | null },
	compose: (context: ReplyModel) => Promise<T>,
	notAnswer: (text: string) => T,
): Promise<T> {
	const { userId, guildId } = requester;
	const settings = await getUserSettings(env.DB, userId);
	// キーが使えなかった寄付は、止めたうえで、この返答ではもう使わない(答え直しが必ず終わるように)
	const failedDonors = new Set<string>();
	for (;;) {
		const paid = await resolvePaidModel(env, {
			userId,
			guildId,
			settings,
			checkMembership: true,
			skipDonors: failedDonors,
		});
		if (!paid.ok) {
			log("setup_required", { userId, missing: paid.missing });
			return notAnswer(paid.guidance);
		}
		const { model, payer } = paid;
		const context: ReplyModel = {
			userId,
			settings,
			model,
			credential: paid.credential,
			payer,
			effort: await replyEffort(env, userId, settings, model),
			callModel: paidCall(env, paid, settings),
		};
		const startedAt = Date.now();
		try {
			return await compose(context);
		} catch (error) {
			if (!(error instanceof LlmError)) {
				throw error;
			}
			log("llm_failed", {
				userId,
				provider: model.provider,
				model: model.modelId,
				payer: payer.kind,
				kind: error.kind,
				status: error.status,
				detail: error.detail,
				durationMs: Date.now() - startedAt,
			});
			const pausedDonor = await pauseIfDonorKeyFailed(env, payer, error);
			if (pausedDonor !== null) {
				failedDonors.add(pausedDonor);
				continue;
			}
			return notAnswer(describeLlmError(error, model));
		}
	}
}

/** 費用を払う人のキーでAIを呼ぶ関数。寄付で答えるときは、呼ぶたびに、その分の費用を寄付から差し引く */
function paidCall(
	env: Env,
	{ payer, model, credential }: PaidModel,
	settings: UserSettings,
): (request: ChatRequest) => Promise<ChatResult> {
	return async (request) => {
		const result =
			model.provider === "anthropic"
				? await chatWithAnthropic(credential, request)
				: await chatWithOpenRouter(credential.apiKey, request);
		if (payer.kind === "donation") {
			await chargeDonationFor(
				env,
				payer,
				result.requestUsages,
				model,
				settings,
			);
		}
		return result;
	};
}

/** AIの答えではない返答(登録方法の案内や、エラーの理由) */
export function notAnswer(text: string): ComposedReply {
	return { text, inputTokens: null, offerCompaction: false };
}

/** 話しかけたメッセージへの返答を作る。会話を読み、長ければ古い部分を要約してから答えてもらう */
async function composeReply(
	job: RespondJob,
	env: Env,
	trigger: StoredMessageInput,
	history: HistoryDeps,
): Promise<ComposedReply> {
	return withReplyModel(
		env,
		{ userId: job.authorId, guildId: job.guildId },
		(context) => composeAnswer(context, env, trigger, history),
		notAnswer,
	);
}

/** 会話を読み、長ければ古い部分を要約してから、AIに答えてもらう */
async function composeAnswer(
	context: ReplyModel,
	env: Env,
	trigger: StoredMessageInput,
	history: HistoryDeps,
): Promise<ComposedReply> {
	const botUserId = env.DISCORD_APPLICATION_ID;
	const read = await readConversation(trigger, history);
	let summary = read.summary;
	let messages = read.messages;
	let parentDeleted = read.parentDeleted;
	// 会話が入力の上限の8割を超えていたら、新しい20件を残して、それより前を要約する
	const summaryUsages: TokenUsage[] = [];
	const size = await conversationSize(env.DB, messages, botUserId);
	if (
		size !== null &&
		messages.length > KEEP_RECENT_MESSAGES &&
		size >=
			(await inputLimit(context.settings, context.model, context.credential)) *
				SUMMARY_THRESHOLD
	) {
		const result = await summarizeOlderPart({
			db: env.DB,
			callModel: context.callModel,
			modelId: context.model.modelId,
			effort: context.effort,
			userId: context.userId,
			botUserId,
			messages,
			previous: summary,
			names: await namesFor(messages.slice(0, -KEEP_RECENT_MESSAGES), history),
		});
		summaryUsages.push(...result.usages);
		if (result.summary !== null) {
			summary = result.summary;
			messages = messages.slice(-KEEP_RECENT_MESSAGES);
			// 返信先が削除されていた、いちばん古い発言は、要約の中に入った
			parentDeleted = false;
		}
		log("summarized", {
			userId: context.userId,
			provider: context.model.provider,
			model: context.model.modelId,
			payer: context.payer.kind,
			trigger: "auto",
			conversationTokens: size,
			failure: result.failure,
			...sumUsage(result.usages),
		});
	}
	return answer(context, env, history, {
		messages,
		summary,
		summaryUsages,
		parentDeleted,
	});
}

/**
 * 会話(要約と、それより後の発言)を渡して、AIに答えてもらう。messagesは古い順で、最後がAIに答えてほしい発言
 */
export async function answer(
	context: ReplyModel,
	env: Env,
	history: HistoryDeps,
	conversation: {
		messages: StoredMessageInput[];
		summary: ConversationSummary | null;
		/** 要約を作ったときの使用量(費用の表示に含める) */
		summaryUsages: TokenUsage[];
		/** いちばん古い発言の返信先が削除されていた */
		parentDeleted?: boolean;
	},
): Promise<ComposedReply> {
	const { userId, settings, model } = context;
	const { summary, summaryUsages } = conversation;
	const botUserId = env.DISCORD_APPLICATION_ID;
	const startedAt = Date.now();
	const usesTools = await toolsAvailable(settings, model);
	// 道具を使わず、添付もなければ、読めるファイルは確かめない(「その他」のモデルでは、モデル情報の取得が要るため)
	const hasAttachments = conversation.messages.some(
		(message) => message.attachments.length > 0,
	);
	const support =
		usesTools || hasAttachments
			? await fileSupport(model, settings)
			: { images: false, pdfs: false };
	const includeImages = hasAttachments && support.images;
	// 保存した添付のURLは期限付きなので、AIに渡す画像は、期限が近ければ取り直す
	const chain = includeImages
		? await refreshImageUrls(conversation.messages, history, botUserId)
		: conversation.messages;
	// 道具を使えるモデルでは、AIに見せる添付ファイルに番号を付け、ファイルを読む道具で読めるようにする
	// (仕様: docs/spec/architecture.md「添付ファイルの読み取り」)。会話を先に書くので、会話の番号は毎回同じになる
	const files = usesTools ? new FileCatalog(support) : undefined;
	const messages = toConversation(chain, {
		botUserId,
		includeImages,
		names: await namesFor(chain, history),
		summary: summary?.summary ?? null,
		files,
		// 画像のURLを取り直すときに、いちばん古い発言が消えていて外れたら、書き添える先がない
		parentDeleted:
			conversation.parentDeleted === true &&
			chain[0]?.messageId === conversation.messages[0]?.messageId,
	});
	const webSearch = settings.featWebSearch
		? await webSearchAvailable(env, userId, settings, model)
		: false;
	// AIが必要なときに、このチャンネルと、サーバーの共有チャンネルの履歴やピン留めを読んだり探したりできるようにする。
	// メンションを書けるよう、メンバーを名前で探せるようにする(仕様: docs/spec/architecture.md「メンバーとメンション」)。
	// このサーバーにスキルがあれば、その一覧を指示に入れ、本文を読めるようにする(仕様: docs/spec/behavior.md「スキル」)。
	// 会話の最初のメッセージが返信なら、その返信先も読めるようにする(要約があるときは、要約した部分の続きなので渡さない)。
	// 道具の定義は、毎回同じ並びにする(キャッシュのため)
	const root = chain[0];
	const guildId = history.guildId;
	const skills =
		usesTools && guildId !== null ? await listSkills(env.DB, guildId) : [];
	const skillReads: SkillReads = { calls: 0, names: [] };
	const fileReads: FileReads = { calls: 0, kinds: [] };
	const tools = files
		? [
				channelHistoryTool(history, botUserId, files),
				searchMessagesTool(history, botUserId, files),
				channelListTool(history),
				pinnedMessagesTool(
					history,
					botUserId,
					pinListerFor(env.DISCORD_BOT_TOKEN),
					files,
				),
				...(guildId !== null
					? [
							findMembersTool(
								memberDirectoryLoader(env.DISCORD_BOT_TOKEN, env.DB, guildId),
							),
						]
					: []),
				readFileTool(files, history, fileReads),
				...(guildId !== null && skills.length > 0
					? [readSkillTool(env.DB, guildId, skills, skillReads)]
					: []),
				...(summary === null && startsWithReply(root)
					? [replyChainTool(root, history, botUserId, files)]
					: []),
			]
		: [];
	const result = await context.callModel({
		model: model.modelId,
		system: buildSystemPrompt(settings.customPrompt, skills),
		messages: messages.messages,
		effort: context.effort,
		webSearch: webSearch === true,
		tools,
		maxTokens: MAX_OUTPUT_TOKENS,
	});
	log("responded", {
		userId,
		provider: model.provider,
		model: model.modelId,
		payer: context.payer.kind,
		messages: chain.length,
		summarized: summary !== null,
		stopReason: result.stopReason,
		durationMs: Date.now() - startedAt,
		toolCalls: result.toolCalls,
		skills: skillReads.names,
		// 読んだファイルは、種類だけを残す(名前と中身は残さない)
		fileReads: fileReads.calls,
		fileKinds: fileReads.kinds,
		...result.usage,
	});
	// 料金が上がる境目を超えたら(1回の呼び出しごとの入力で見る)、その会話・その人・そのモデルで1回だけ、要約を勧める
	const threshold = await priceIncreaseThreshold(settings, model);
	const rootMessageId = summary?.rootMessageId ?? root?.messageId;
	const offerCompaction =
		threshold !== null &&
		rootMessageId !== undefined &&
		result.requestUsages.some((usage) => usage.inputTokens >= threshold) &&
		(await claimCompactionNotice(env.DB, {
			rootMessageId,
			userId,
			modelKey: model.modelId,
		}));
	return {
		text: formatReply(result, {
			imagesSkipped: messages.imagesSkipped,
			webSearchSkipped: settings.featWebSearch && webSearch === false,
			skills: skillReads.names,
			// 要約を作ったときは、その費用も含める
			usage: settings.featUsageDisplay
				? await usageNote(
						[...summaryUsages, ...result.requestUsages],
						model,
						selectedCandidate(settings),
					)
				: null,
			// 寄付で答えたら、毎回書く(費用は、呼んだときに寄付から差し引いてある)
			donation: await paidNote(env, context.payer),
			compaction: offerCompaction ? threshold : null,
		}),
		// 道具で何回かに分けて呼んだときは、最初の1回の分(後の回には、道具の結果が入るため)
		inputTokens: result.requestUsages[0]?.inputTokens ?? null,
		offerCompaction,
	};
}

/**
 * モデルが読めるファイル(画像とPDF)。「その他」で入力したOpenRouterのモデルは、モデル情報で確かめる。
 * モデル情報を取得できなければ、どちらも渡さない。
 */
async function fileSupport(
	model: ResolvedModel,
	settings: UserSettings,
): Promise<FileSupport> {
	if (!usesCustomModel(settings) || model.provider !== "openrouter") {
		return { images: model.supportsImages, pdfs: model.supportsPdf };
	}
	try {
		const info = await findOpenRouterModel(model.modelId);
		return {
			images: info?.supportsImages ?? false,
			pdfs: info?.supportsFiles ?? false,
		};
	} catch (error) {
		log("model_info_unavailable", {
			error: error instanceof Error ? error.message : "unknown",
		});
		return { images: false, pdfs: false };
	}
}

/**
 * 返答を、話しかけたメッセージへの返信として投稿する。
 * 長ければ分けて、2通目からは前のメッセージへの返信にする。返信のつながりから会話全体をたどれるようにするため。
 */
async function postReply(
	token: string,
	trigger: APIMessage,
	text: string,
	offerCompaction: boolean,
): Promise<string[]> {
	const posted: string[] = [];
	let replyTo = trigger.id;
	const parts = splitMessage(text);
	const notified = notifiedUsersByPart(parts);
	for (const [index, content] of parts.entries()) {
		const last = index === parts.length - 1;
		const message = await createMessage(token, trigger.channel_id, {
			content,
			message_reference: { message_id: replyTo, fail_if_not_exists: false },
			// 話しかけた人には、最初の返信で通知する。AIが書いた人へのメンションでも、その人に通知する(上限の人数まで)
			allowed_mentions: allowedMentions(notified[index] ?? [], index === 0),
			// 要約を勧める案内は最後のメッセージの末尾にあるので、ボタンもそこに付ける
			...(offerCompaction && last ? { components: [compactButtonRow()] } : {}),
		});
		posted.push(message.id);
		replyTo = message.id;
	}
	return posted;
}

/**
 * 返答のときに会話全体を渡した入力のトークン数を、投稿したメッセージごとに記録する(会話の量の記録)。
 * 投稿した後なので、記録できなくても失敗にはしない(やり直すと、同じ返答をもう一度投稿してしまうため)
 */
export async function recordConversationSize(
	env: Env,
	messageIds: readonly string[],
	inputTokens: number,
): Promise<void> {
	try {
		await recordReplyUsage(env.DB, messageIds, inputTokens);
	} catch (error) {
		log("record_usage_failed", {
			error: error instanceof Error ? error.message : "unknown",
		});
	}
}

/**
 * Discordから読んだメッセージを、保存用のQueueに入れる(読んだ分だけ取り込む。
 * 仕様: docs/spec/architecture.md「過去ログの取り込み」)。入れられなくても、返答は続ける。
 */
async function enqueueIngest(
	env: Env,
	messages: readonly StoredMessageInput[],
): Promise<void> {
	try {
		for (let i = 0; i < messages.length; i += INGEST_BATCH_SIZE) {
			await env.INGEST_QUEUE.sendBatch(
				messages.slice(i, i + INGEST_BATCH_SIZE).map((message) => ({
					body: { kind: "ingest", message } satisfies QueueMessage,
				})),
			);
		}
	} catch (error) {
		log("ingest_enqueue_failed", {
			messages: messages.length,
			error: error instanceof Error ? error.message : "unknown",
		});
	}
}

async function getMessageOrNull(
	token: string,
	channelId: string,
	messageId: string,
): Promise<APIMessage | null> {
	try {
		return await getChannelMessage(token, channelId, messageId);
	} catch (error) {
		if (!(error instanceof DiscordApiError)) {
			throw error;
		}
		// 消えている
		if (error.status === 404) {
			return null;
		}
		// 読む権限(メッセージ履歴を読む)がない。チャンネルの権限の設定を見直す必要がある
		if (error.status === 403) {
			log("missing_permission", { channelId });
			return null;
		}
		throw error;
	}
}

/** 「入力中…」を表示し、止めるまで送り直し続ける */
function startTyping(token: string, channelId: string): () => void {
	const send = () => {
		triggerTyping(token, channelId).catch(() => {
			// 表示できなくても返答はできるので、無視する
		});
	};
	send();
	const timer = setInterval(send, TYPING_INTERVAL_MS);
	return () => clearInterval(timer);
}

function log(event: string, detail: Record<string, unknown> = {}): void {
	logEvent("respond", event, detail);
}
