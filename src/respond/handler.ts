import type { APIMessage } from "discord-api-types/v10";
import {
	createMessage,
	DiscordApiError,
	getChannelMessage,
	triggerTyping,
} from "../discord/api";
import { chatWithAnthropic } from "../llm/anthropic";
import { findOpenRouterModel } from "../llm/model-info";
import { chatWithOpenRouter } from "../llm/openrouter";
import { type ChatRequest, LlmError } from "../llm/types";
import { logEvent } from "../log";
import type { RespondJob } from "../queue/messages";
import { claimMessage, releaseMessage } from "../store/messages";
import {
	getRegisteredProviders,
	getUserSettings,
	loadCredential,
	type UserSettings,
} from "../store/users";
import {
	fetchReplyChain,
	type MessageFetcher,
	toConversation,
} from "./conversation";
import { replyEffort } from "./effort";
import {
	type ResolvedModel,
	resolveModel,
	selectedCandidate,
	usesCustomModel,
} from "./model";
import { buildSystemPrompt } from "./prompt";
import { describeLlmError, formatReply, setupGuidance } from "./replies";
import { splitMessage } from "./split";
import { replyChainTool, startsWithReply, toolsAvailable } from "./tools";
import { usageNote } from "./usage";
import { webSearchAvailable } from "./web-search";

/** 返答の長さの上限(トークン)。考える分(thinking)もここに含まれる */
const MAX_OUTPUT_TOKENS = 16_000;
/** 「入力中…」を送り直す間隔。表示は約10秒で消えるため */
const TYPING_INTERVAL_MS = 8_000;

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
	const token = env.DISCORD_BOT_TOKEN;
	const fetchMessage: MessageFetcher = (channelId, messageId) =>
		getMessageOrNull(token, channelId, messageId);

	const trigger = await fetchMessage(job.channelId, job.messageId);
	if (trigger === null) {
		// 返答する前に消されたか、読む権限がない
		log("trigger_unavailable", { userId: job.authorId });
		return;
	}

	const stopTyping = startTyping(token, job.channelId);
	try {
		const reply = await composeReply(job, env, trigger, fetchMessage);
		await postReply(token, trigger, reply);
	} finally {
		stopTyping();
	}
}

/** 投稿する返答を作る。AIの返答のほか、登録方法の案内やエラーの理由のこともある */
async function composeReply(
	job: RespondJob,
	env: Env,
	trigger: APIMessage,
	fetchMessage: MessageFetcher,
): Promise<string> {
	const userId = job.authorId;
	const [providers, settings] = await Promise.all([
		getRegisteredProviders(env.DB, userId),
		getUserSettings(env.DB, userId),
	]);
	const resolution = resolveModel(settings, providers);
	if (!resolution.ok) {
		log("setup_required", { userId, missing: resolution.missing });
		return setupGuidance(resolution);
	}
	const model = resolution.model;
	const credential = await loadCredential(env, userId, model.provider);
	if (credential === null) {
		// 直前に /delete された
		return setupGuidance({ ok: false, missing: "credentials", label: "" });
	}

	const chain = await fetchReplyChain(trigger, fetchMessage);
	// 添付がなければ、画像を読めるかは確かめない(「その他」のモデルでは、モデル情報の取得が要るため)
	const hasAttachments = chain.some(
		(message) => message.attachments.length > 0,
	);
	const conversation = toConversation(chain, {
		botUserId: env.DISCORD_APPLICATION_ID,
		includeImages:
			hasAttachments &&
			settings.featImageInput &&
			(await readsImages(model, settings)),
	});
	const webSearch = settings.featWebSearch
		? await webSearchAvailable(env, userId, settings, model)
		: false;
	// 会話の最初のメッセージが返信なら、返信先をAIが必要なときに読めるようにする
	const root = chain[0];
	const tools =
		startsWithReply(root) && (await toolsAvailable(settings, model))
			? [replyChainTool(root, fetchMessage, env.DISCORD_APPLICATION_ID)]
			: [];
	const request: ChatRequest = {
		model: model.modelId,
		system: buildSystemPrompt(settings.customPrompt),
		messages: conversation.messages,
		// 設定していなければ既定の段階を、モデルが選べなければいちばん近い段階を送る
		effort: await replyEffort(env, userId, settings, model),
		webSearch: webSearch === true,
		tools,
		maxTokens: MAX_OUTPUT_TOKENS,
	};

	const startedAt = Date.now();
	try {
		const result =
			model.provider === "anthropic"
				? await chatWithAnthropic(credential, request)
				: await chatWithOpenRouter(credential.apiKey, request);
		log("responded", {
			userId,
			provider: model.provider,
			model: model.modelId,
			messages: chain.length,
			stopReason: result.stopReason,
			durationMs: Date.now() - startedAt,
			toolCalls: result.toolCalls,
			...result.usage,
		});
		return formatReply(result, {
			// 本人が画像の読み取りをOFFにしているときは、注記しない
			imagesSkipped: conversation.imagesSkipped && settings.featImageInput,
			webSearchSkipped: settings.featWebSearch && webSearch === false,
			usage: settings.featUsageDisplay
				? await usageNote(result.usage, model, selectedCandidate(settings))
				: null,
		});
	} catch (error) {
		if (!(error instanceof LlmError)) {
			throw error;
		}
		log("llm_failed", {
			userId,
			provider: model.provider,
			model: model.modelId,
			kind: error.kind,
			status: error.status,
			detail: error.detail,
			durationMs: Date.now() - startedAt,
		});
		return describeLlmError(error, model);
	}
}

/**
 * モデルが画像を読めるか。「その他」で入力したOpenRouterのモデルは、モデル情報で確かめる。
 * モデル情報を取得できなければ、画像は渡さない。
 */
async function readsImages(
	model: ResolvedModel,
	settings: UserSettings,
): Promise<boolean> {
	if (!usesCustomModel(settings) || model.provider !== "openrouter") {
		return model.supportsImages;
	}
	try {
		return (await findOpenRouterModel(model.modelId))?.supportsImages ?? false;
	} catch (error) {
		log("model_info_unavailable", {
			error: error instanceof Error ? error.message : "unknown",
		});
		return false;
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
): Promise<void> {
	let replyTo = trigger.id;
	for (const [index, content] of splitMessage(text).entries()) {
		const posted = await createMessage(token, trigger.channel_id, {
			content,
			message_reference: { message_id: replyTo, fail_if_not_exists: false },
			// 返答に含まれるメンションでは通知しない。話しかけた人にだけ、最初の返信で通知する
			allowed_mentions: { parse: [], replied_user: index === 0 },
		});
		replyTo = posted.id;
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
