import {
	editChannelMessage,
	editOriginalInteractionResponse,
} from "../discord/api";
import { chatWithAnthropic } from "../llm/anthropic";
import { chatWithOpenRouter } from "../llm/openrouter";
import { type ChatRequest, LlmError, sumUsage } from "../llm/types";
import { logEvent } from "../log";
import type { CompactJob } from "../queue/messages";
import {
	getRegisteredProviders,
	getUserSettings,
	loadCredential,
} from "../store/users";
import { replyEffort } from "./effort";
import { historyFor } from "./handler";
import { namesFor, readConversation } from "./history";
import { resolveModel, selectedCandidate } from "./model";
import {
	describeLlmError,
	LLM_ERROR_TEXT,
	REFUSAL_TEXT,
	setupGuidance,
} from "./replies";
import { KEEP_RECENT_MESSAGES, summarizeOlderPart } from "./summary";
import { usageNote } from "./usage";

/** 要約を済ませた後に、押した人(選んだ人)にだけ見せる文 */
const SUMMARIZED =
	"要約しました。次の返答から、要約と新しい20件の発言をAIに渡します。";

/** 要約するほど長くない会話で、押した人(選んだ人)にだけ見せる文 */
const TOO_SHORT =
	"この会話は、まだ要約するほど長くありません(新しい20件より前の発言がありません)。";

/**
 * 会話の要約の仕事(仕様: docs/spec/architecture.md「長い会話の自動要約」)。
 * 押した人(選んだ人)のキーで、そのメッセージまでの会話を要約し、保留にした応答を結果に書き換える。
 * 案内のボタンから要約したら、ボタンを消す(ほかの人が続けて押さないように)。
 * 要約した後は、失敗してもやり直さない(やり直すと、もう一度要約して費用がかかるため)
 */
export async function handleCompactJob(
	job: CompactJob,
	env: Env,
): Promise<void> {
	const { content, summarized } = await compact(job, env);
	try {
		await editOriginalInteractionResponse(
			env.DISCORD_APPLICATION_ID,
			job.interactionToken,
			{ content },
		);
		if (summarized && job.buttonMessageId !== null) {
			await editChannelMessage(
				env.DISCORD_BOT_TOKEN,
				job.channelId,
				job.buttonMessageId,
				{ components: [] },
			);
		}
	} catch (error) {
		log("compact_reply_failed", {
			userId: job.userId,
			error: error instanceof Error ? error.message : "unknown",
		});
	}
}

/** 要約して、押した人(選んだ人)に見せる文を作る */
async function compact(
	job: CompactJob,
	env: Env,
): Promise<{ content: string; summarized: boolean }> {
	const userId = job.userId;
	const [providers, settings] = await Promise.all([
		getRegisteredProviders(env.DB, userId),
		getUserSettings(env.DB, userId),
	]);
	const resolution = resolveModel(settings, providers);
	if (!resolution.ok) {
		return { content: setupGuidance(resolution), summarized: false };
	}
	const model = resolution.model;
	const credential = await loadCredential(env, userId, model.provider);
	if (credential === null) {
		return {
			content: setupGuidance({ ok: false, missing: "credentials", label: "" }),
			summarized: false,
		};
	}

	const history = historyFor(env, {
		guildId: job.guildId,
		channelId: job.channelId,
		knownNames: [],
	});
	const { messages, summary } = await readConversation(job.start, history);
	if (messages.length <= KEEP_RECENT_MESSAGES) {
		return { content: TOO_SHORT, summarized: false };
	}
	const callModel = (request: ChatRequest) =>
		model.provider === "anthropic"
			? chatWithAnthropic(credential, request)
			: chatWithOpenRouter(credential.apiKey, request);
	try {
		const result = await summarizeOlderPart({
			db: env.DB,
			callModel,
			modelId: model.modelId,
			effort: await replyEffort(env, userId, settings, model),
			userId,
			botUserId: env.DISCORD_APPLICATION_ID,
			messages,
			previous: summary,
			names: await namesFor(messages.slice(0, -KEEP_RECENT_MESSAGES), history),
		});
		log("summarized", {
			userId,
			provider: model.provider,
			model: model.modelId,
			trigger: job.buttonMessageId === null ? "menu" : "button",
			failure: result.failure,
			...sumUsage(result.usages),
		});
		if (result.summary === null) {
			return {
				content: result.failure === "refusal" ? REFUSAL_TEXT : LLM_ERROR_TEXT,
				summarized: false,
			};
		}
		const usage = settings.featUsageDisplay
			? await usageNote(result.usages, model, selectedCandidate(settings))
			: null;
		return {
			content: [SUMMARIZED, ...(usage === null ? [] : [usage])].join("\n"),
			summarized: true,
		};
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
		});
		return { content: describeLlmError(error, model), summarized: false };
	}
}

function log(event: string, detail: Record<string, unknown> = {}): void {
	logEvent("compact", event, detail);
}
