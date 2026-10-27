import {
	editChannelMessage,
	editOriginalInteractionResponse,
} from "../discord/api";
import { sumUsage } from "../llm/types";
import { logEvent } from "../log";
import type { CompactJob } from "../queue/messages";
import { historyFor, type ReplyModel, withReplyModel } from "./handler";
import { type HistoryDeps, namesFor, readConversation } from "./history";
import { selectedCandidate } from "./model";
import { paidNote } from "./payer";
import { LLM_ERROR_TEXT, REFUSAL_TEXT } from "./replies";
import { KEEP_RECENT_MESSAGES, summarizeOlderPart } from "./summary";
import { usageNote } from "./usage";

/** 要約を済ませた後に、押した人(選んだ人)にだけ見せる文 */
const SUMMARIZED =
	"要約しました。次の返答から、要約と新しい20件の発言をAIに渡します。";

/** 要約するほど長くない会話で、押した人(選んだ人)にだけ見せる文 */
const TOO_SHORT =
	"この会話は、まだ要約するほど長くありません(新しい20件より前の発言がありません)。";

/** 要約の結果。押した人(選んだ人)に見せる文と、要約できたか */
interface CompactResult {
	content: string;
	summarized: boolean;
}

/**
 * 会話の要約の仕事(仕様: docs/spec/architecture.md「長い会話の自動要約」)。
 * 押した人(選んだ人)のキーで、そのメッセージまでの会話を要約し、保留にした応答を結果に書き換える。
 * サーバーに寄付があれば、寄付した人のキーで要約する(仕様: docs/spec/llm-cost.md「クレジットの寄付」)。
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
function compact(job: CompactJob, env: Env): Promise<CompactResult> {
	const history = historyFor(env, {
		guildId: job.guildId,
		channelId: job.channelId,
		knownNames: [],
	});
	return withReplyModel(
		env,
		{ userId: job.userId, guildId: job.guildId },
		(context) => summarize(context, job, env, history),
		(content) => ({ content, summarized: false }),
	);
}

/** そのメッセージまでの会話を読み、新しい20件より前を要約する */
async function summarize(
	context: ReplyModel,
	job: CompactJob,
	env: Env,
	history: HistoryDeps,
): Promise<CompactResult> {
	const { messages, summary } = await readConversation(job.start, history);
	if (messages.length <= KEEP_RECENT_MESSAGES) {
		return { content: TOO_SHORT, summarized: false };
	}
	const result = await summarizeOlderPart({
		db: env.DB,
		callModel: context.callModel,
		modelId: context.model.modelId,
		effort: context.effort,
		userId: context.userId,
		botUserId: env.DISCORD_APPLICATION_ID,
		messages,
		previous: summary,
		names: await namesFor(messages.slice(0, -KEEP_RECENT_MESSAGES), history),
	});
	log("summarized", {
		userId: context.userId,
		provider: context.model.provider,
		model: context.model.modelId,
		payer: context.payer.kind,
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
	const usage = context.settings.featUsageDisplay
		? await usageNote(
				result.usages,
				context.model,
				selectedCandidate(context.settings),
			)
		: null;
	// 寄付で要約したら、利用量の行の下に書く
	const donation = await paidNote(env, context.payer);
	return {
		content: [SUMMARIZED, usage, donation]
			.filter((line) => line !== null)
			.join("\n"),
		summarized: true,
	};
}

function log(event: string, detail: Record<string, unknown> = {}): void {
	logEvent("compact", event, detail);
}
