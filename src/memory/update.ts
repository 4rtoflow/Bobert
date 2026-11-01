import { editOriginalInteractionResponse } from "../discord/api";
import { chatWithAnthropic } from "../llm/anthropic";
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
	MemoryJob,
	QueueMessage,
	StoredMessageInput,
} from "../queue/messages";
import { type ResolvedModel, resolveModel } from "../respond/model";
import { describeLlmError } from "../respond/replies";
import {
	claimMemoryUpdate,
	forgetMemorySources,
	loadMemory,
	type MemoryItem,
	recordMemoryFailure,
	recordMemoryUpdated,
	saveMemoryItems,
} from "../store/memory";
import {
	existingMessageIds,
	loadAuthorMessages,
	loadRepliesFrom,
} from "../store/messages";
import {
	DEFAULT_USER_SETTINGS,
	getRegisteredProviders,
	loadCredential,
} from "../store/users";
import {
	applyOperations,
	messageText,
	parseOperations,
	type SynthesisMessage,
	synthesisInput,
	synthesisPrompt,
} from "./prompts";
import { memoryScreen } from "./screen";
import { MEMORY_KEY_REQUIRED } from "./texts";

/**
 * 記憶の更新(仕様: docs/spec/architecture.md「記憶」)。
 * 本人の発言から、覚えておくことの一覧を、本人のキーとClaude Haiku 5.5でまとめ直す。寄付は使わない
 */

/** まとめるのに使うモデル(候補の一覧のキー) */
const MEMORY_MODEL_KEY = "claude-haiku-5.5";
/** 最初の一覧で読む発言の数(新しい方から) */
const MAX_FIRST_MESSAGES = 5_000;
/** 更新で1回に読む発言の数(古い方から)。長く使わなかった後でも、費用を抑える */
const MAX_UPDATE_MESSAGES = 5_000;
/** 1回の依頼に入れる発言の文字数の目安。Haiku 5.5の単価が上がる、入力の10万トークンを超えないようにする */
const MAX_BATCH_CHARS = 60_000;
/** Bobertの答えを読む長さ(先頭から) */
const BOT_REPLY_PREVIEW = 500;
/** まとめの答えの長さの上限(トークン) */
const MAX_OUTPUT_TOKENS = 4_000;

/**
 * 返答の後に、記憶の更新を予約する。記憶を使っていて、前回の更新から1日以上たっていれば(失敗の後は1時間)、
 * 更新の仕事をQueueに入れる。予約できなくても、返答には関係しないので、記録だけ残す
 */
export async function scheduleMemoryUpdate(
	env: Env,
	userId: string,
	guildId: string | null,
): Promise<void> {
	if (guildId === null) {
		return;
	}
	try {
		if (await claimMemoryUpdate(env.DB, userId, guildId)) {
			await env.RESPOND_QUEUE.send({
				kind: "memory",
				userId,
				guildId,
				interactionToken: null,
			} satisfies QueueMessage);
		}
	} catch (error) {
		log("schedule_failed", {
			userId,
			error: error instanceof Error ? error.message : "unknown",
		});
	}
}

/**
 * 記憶の更新の仕事。最初は新しい方から5,000件まで、その後は前回より後の発言を読み、AIに一覧の変更を出させて当てる。
 * /memory でONにしたときは、終わったら、その画面を一覧に書き換える
 */
export async function handleMemoryJob(job: MemoryJob, env: Env): Promise<void> {
	const { userId, guildId } = job;
	const state = await loadMemory(env.DB, userId, guildId);
	if (state === null || !state.enabled) {
		log("skipped", { userId, reason: "disabled" });
		await showScreen(env, job);
		return;
	}
	const model = await memoryModel(env, userId);
	if (model === null) {
		await recordMemoryFailure(env.DB, userId, guildId, MEMORY_KEY_REQUIRED);
		log("skipped", { userId, reason: "no_key" });
		await showScreen(env, job);
		return;
	}
	const first = state.readUntil === null;
	const messages = await loadAuthorMessages(
		env.DB,
		guildId,
		userId,
		state.readUntil,
		first ? MAX_FIRST_MESSAGES : MAX_UPDATE_MESSAGES,
	);
	const last = messages.at(-1);
	if (last === undefined) {
		await recordMemoryUpdated(
			env.DB,
			userId,
			guildId,
			state.readUntil ?? Date.now(),
		);
		log("updated", { userId, first, messages: 0, items: state.items.length });
		await showScreen(env, job);
		return;
	}
	const replies = await loadRepliesFrom(
		env.DB,
		env.DISCORD_APPLICATION_ID,
		messages.map((message) => message.messageId),
	);
	const name = last.authorName;
	let items: MemoryItem[] = state.items;
	const usages: TokenUsage[] = [];
	let skipped = 0;
	try {
		for (const batch of synthesisBatches(messages, replies)) {
			const result = await model.call(
				synthesisRequest(model.resolved.modelId, name, items, batch),
			);
			usages.push(...result.requestUsages);
			// 断られたときと、読めない答えのときは、その分を飛ばす(ほかの分は当てる)
			const operations =
				result.stopReason === "refusal" ? null : parseOperations(result.text);
			if (operations === null) {
				skipped++;
				continue;
			}
			items = applyOperations(
				items,
				operations,
				new Map(batch.map((entry) => [entry.ref, entry.message.messageId])),
			);
		}
	} catch (error) {
		if (!(error instanceof LlmError)) {
			throw error;
		}
		await recordMemoryFailure(
			env.DB,
			userId,
			guildId,
			describeLlmError(error, model.resolved),
		);
		log("failed", {
			userId,
			provider: model.resolved.provider,
			kind: error.kind,
			status: error.status,
			...sumUsage(usages),
		});
		await showScreen(env, job);
		return;
	}
	// まとめている間に、一覧が変わったら(本人が直した、全部消した、/delete で消したなど)、本人の操作を優先する。
	// まとめた結果は捨て、読み込んだ時刻も進めない(1時間たった後に、次に使ったときに試し直す)
	const current = await loadMemory(env.DB, userId, guildId);
	if (current === null || !sameItems(current.items, state.items)) {
		log("discarded", { userId, reason: "changed", ...sumUsage(usages) });
		await showScreen(env, job);
		return;
	}
	await saveMemoryItems(env.DB, userId, guildId, items);
	await recordMemoryUpdated(env.DB, userId, guildId, last.createdAt);
	// まとめている間に消された発言は、消したときに項目から外せていないので、ここで外す
	const read = new Set(messages.map((message) => message.messageId));
	const sources = [...new Set(items.flatMap((item) => item.sources))].filter(
		(id) => read.has(id),
	);
	const existing = await existingMessageIds(env.DB, sources);
	await forgetMemorySources(
		env.DB,
		sources.filter((id) => !existing.has(id)),
	);
	log("updated", {
		userId,
		provider: model.resolved.provider,
		first,
		messages: messages.length,
		items: items.length,
		skipped,
		...sumUsage(usages),
	});
	await showScreen(env, job);
}

/** まとめるのに使う、本人のキーとモデル。Anthropicのキーがあれば直接、なければOpenRouter経由で呼ぶ */
async function memoryModel(
	env: Env,
	userId: string,
): Promise<{
	resolved: ResolvedModel;
	call: (request: ChatRequest) => Promise<ChatResult>;
} | null> {
	const providers = await getRegisteredProviders(env.DB, userId);
	const resolution = resolveModel(
		{ ...DEFAULT_USER_SETTINGS, modelKey: MEMORY_MODEL_KEY },
		providers,
	);
	if (!resolution.ok) {
		return null;
	}
	const resolved = resolution.model;
	const credential = await loadCredential(env, userId, resolved.provider);
	if (credential === null) {
		return null;
	}
	return {
		resolved,
		call: (request) =>
			resolved.provider === "anthropic"
				? chatWithAnthropic(credential, request)
				: chatWithOpenRouter(credential.apiKey, request),
	};
}

/**
 * 発言を、1回の依頼に入れる分ずつに分ける。発言には、1回の依頼の中での番号を付け、Bobertの答えを添える。
 * 本文のない発言(添付だけなど)は、覚えることがないので入れない
 */
function synthesisBatches(
	messages: readonly StoredMessageInput[],
	replies: readonly StoredMessageInput[],
): SynthesisMessage[][] {
	const repliesTo = new Map<string, string[]>();
	for (const reply of replies) {
		if (reply.replyToId === null) {
			continue;
		}
		const text = [...messageText(reply)].slice(0, BOT_REPLY_PREVIEW).join("");
		repliesTo.set(reply.replyToId, [
			...(repliesTo.get(reply.replyToId) ?? []),
			text,
		]);
	}
	const batches: SynthesisMessage[][] = [];
	let batch: SynthesisMessage[] = [];
	let size = 0;
	for (const message of messages) {
		if (messageText(message) === "") {
			continue;
		}
		const answers = repliesTo.get(message.messageId) ?? [];
		const length =
			message.content.length +
			answers.reduce((sum, answer) => sum + answer.length, 0);
		if (batch.length > 0 && size + length > MAX_BATCH_CHARS) {
			batches.push(batch);
			batch = [];
			size = 0;
		}
		batch.push({ ref: batch.length + 1, message, replies: answers });
		size += length;
	}
	if (batch.length > 0) {
		batches.push(batch);
	}
	return batches;
}

function synthesisRequest(
	modelId: string,
	name: string,
	items: readonly MemoryItem[],
	batch: readonly SynthesisMessage[],
): ChatRequest {
	return {
		model: modelId,
		system: [synthesisPrompt(name)],
		messages: [
			{
				role: "user",
				parts: [{ type: "text", text: synthesisInput(name, items, batch) }],
			},
		],
		effort: "low",
		webSearch: false,
		tools: [],
		maxTokens: MAX_OUTPUT_TOKENS,
	};
}

/** 2つの一覧が同じか(項目の文、本人が書いたか、もとの発言) */
function sameItems(
	a: readonly MemoryItem[],
	b: readonly MemoryItem[],
): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/** /memory でONにしたときは、その画面を、今の記憶に書き換える。書き換えられなくても、記憶はできているので、記録だけ残す */
async function showScreen(env: Env, job: MemoryJob): Promise<void> {
	if (job.interactionToken === null) {
		return;
	}
	try {
		await editOriginalInteractionResponse(
			env.DISCORD_APPLICATION_ID,
			job.interactionToken,
			memoryScreen(await loadMemory(env.DB, job.userId, job.guildId)),
		);
	} catch (error) {
		log("screen_update_failed", {
			userId: job.userId,
			error: error instanceof Error ? error.message : "unknown",
		});
	}
}

function log(event: string, detail: Record<string, unknown>): void {
	logEvent("memory", event, detail);
}
