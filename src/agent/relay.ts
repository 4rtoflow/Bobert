import type Anthropic from "@anthropic-ai/sdk";
import type {
	BetaManagedAgentsAgentToolUseEvent,
	BetaManagedAgentsSessionErrorEvent,
	BetaManagedAgentsSessionEvent,
	BetaManagedAgentsStreamSessionEvents,
} from "@anthropic-ai/sdk/resources/beta/sessions/events";
import type {
	APIActionRowComponent,
	APIButtonComponentWithCustomId,
	APIComponentInMessageActionRow,
	RESTPatchAPIChannelMessageJSONBody,
	RESTPostAPIChannelMessageJSONBody,
} from "discord-api-types/v10";
import { ButtonStyle, ComponentType } from "../discord/constants";
import { logEvent } from "../log";
import { REFUSAL_TEXT } from "../respond/replies";
import { DISCORD_MESSAGE_LIMIT, splitMessage } from "../respond/split";
import {
	type AgentModel,
	describeAgentError,
	describeSessionError,
	isSessionGone,
} from "./managed";
import {
	ALLOW_BUTTON_LABEL,
	APPROVAL_INTRO,
	allowedMessage,
	DELETE_CHANNEL_BUTTON_LABEL,
	DENY_BUTTON_LABEL,
	deniedMessage,
	deniedToolLine,
	ENDED,
	HELD_NOTICE,
	KEY_CANNOT_OPERATE,
	othersNotice,
	STOP_BUTTON_LABEL,
	STOPPED_LINE,
	sessionFailed,
	TOOL_LABELS,
	workStopped,
} from "./texts";

/**
 * エージェントのチャンネルでのやり取り(仕様: docs/spec/behavior.md「エージェント」)。
 * 本人の発言をセッションに送り、セッションの出来事をチャンネルに書き込む。
 * 状態の保存と、イベントの流れの受け取りは、呼び出し元(AgentSessionのDurable Object)が受け持つ
 */

/** ボタンのID */
export const AGENT_END_ID = "agent:end";
export const AGENT_END_CONFIRM_ID = "agent:end_confirm";
export const AGENT_DELETE_ID = "agent:delete";
export const AGENT_DELETE_CONFIRM_ID = "agent:delete_confirm";
export const AGENT_STOP_ID = "agent:stop";
export const AGENT_ALLOW_PREFIX = "agent:allow:";
export const AGENT_DENY_PREFIX = "agent:deny:";

/** 本人以外の発言を消したときの知らせを、消すまでの時間 */
export const OTHERS_NOTICE_MS = 10_000;

/** 道具の値を作業の様子に書くときの、長さの上限 */
const OPERATION_MAX_LENGTH = 100;

/** 値をコードとして見せる道具(コマンドやファイルのパス) */
const CODE_TOOLS: ReadonlySet<string> = new Set([
	"bash",
	"read",
	"write",
	"edit",
	"glob",
	"grep",
]);

/** セッションの出来事。流れ(SSE)と一覧の、どちらで受け取ったものも同じに扱う */
export type AgentEvent =
	| BetaManagedAgentsStreamSessionEvents
	| BetaManagedAgentsSessionEvent;

/** 許可を待っている道具の呼び出し */
export interface PendingApproval {
	eventId: string;
	messageId: string;
	label: string;
	value: string;
}

/** 許可を待つ間に預かった、本人の発言 */
export interface HeldMessage {
	/** 預かったことの知らせ。送ったら消す */
	noticeId: string | null;
	text: string;
}

/** 作業の様子の知らせ */
export interface Progress {
	messageId: string;
	lines: string[];
	/** エージェントが発言した後か。後なら、次の道具の行は新しい知らせに書く */
	closed: boolean;
}

/** チャンネルごとの状態(Durable Objectのストレージに保存する) */
export interface SessionState {
	channelId: string;
	guildId: string;
	ownerId: string;
	/** Managed Agentsのセッション。終えたらnull */
	sessionId: string | null;
	model: AgentModel;
	/** エージェントが動いているかもしれない(イベントの流れを受け続ける)か */
	working: boolean;
	/**
	 * 待っていたセッションに発言を送り、動き始めた知らせをまだ受け取っていない。
	 * この間に届いた「止まった」知らせは、前の作業のものなので、作業の区切りとして扱わない
	 */
	awaitingRun: boolean;
	/** 最後に扱ったイベントの時刻と、その時刻のイベントのID。つなぎ直したときに、同じイベントを二度扱わないため */
	lastProcessedAt: string | null;
	recentIds: string[];
	progress: Progress | null;
	approvals: PendingApproval[];
	held: HeldMessage[];
	/** 「止める」を押した。作業が止まったら、知らせに「止めました」と書き足す */
	stopRequested: boolean;
	/** 最後に受け取ったエラーの知らせ。作業が止まったときの理由に使う */
	lastError: BetaManagedAgentsSessionErrorEvent["error"] | null;
	/** 消す予定の、本人以外への知らせ */
	notices: { messageId: string; dueAt: number }[];
}

/** セッションを始めたときの情報 */
export interface SessionSetup {
	channelId: string;
	guildId: string;
	ownerId: string;
	sessionId: string;
	model: AgentModel;
}

export function initialState(setup: SessionSetup): SessionState {
	return {
		...setup,
		working: false,
		awaitingRun: false,
		lastProcessedAt: null,
		recentIds: [],
		progress: null,
		approvals: [],
		held: [],
		stopRequested: false,
		lastError: null,
		notices: [],
	};
}

/** エージェントのチャンネルに投稿された、Gatewayからのメッセージ */
export interface IncomingMessage {
	id: string;
	authorId: string;
	/** BotかWebhookの発言 */
	fromBot: boolean;
	content: string;
	/** メンションされた人。本文の<@ID>を名前にするのに使う */
	mentions: { id: string; name: string }[];
}

/** Discordへの書き込み(チャンネルは決まっている) */
export interface RelayDiscord {
	/** 投稿して、メッセージのIDを返す */
	post(body: RESTPostAPIChannelMessageJSONBody): Promise<string>;
	edit(
		messageId: string,
		body: RESTPatchAPIChannelMessageJSONBody,
	): Promise<void>;
	remove(messageId: string): Promise<void>;
}

export interface RelayDeps {
	discord: RelayDiscord;
	/** 本人のキーで作ったクライアント。キーが消えていればnull */
	client(): Promise<Anthropic | null>;
	/** セッションを終えた印を、D1に付ける */
	markEnded(): Promise<void>;
	now(): number;
}

/** イベントを扱ったあと、流れをどうするか */
export type StreamDecision =
	/** 流れを受け続ける */
	| "continue"
	/** 作業が終わったか、本人の許可を待っている。流れを閉じる */
	| "close";

/** 許可のボタンの結果 */
export type ApprovalResult = "ok" | "stale" | "failed";

export class SessionRelay {
	constructor(
		private readonly state: SessionState,
		private readonly deps: RelayDeps,
	) {}

	/** 本人の発言をセッションに送る。許可を待っている間は預かる。送ったらtrue(イベントの流れを受ける) */
	async receiveOwner(message: IncomingMessage): Promise<boolean> {
		const { state } = this;
		if (state.sessionId === null) {
			return false;
		}
		const text = ownerText(message);
		if (text.trim() === "") {
			return false;
		}
		if (state.approvals.length > 0) {
			const noticeId = await this.deps.discord
				.post({
					content: HELD_NOTICE,
					message_reference: { message_id: message.id },
					allowed_mentions: { parse: [], replied_user: false },
				})
				.catch((error: unknown) => {
					log("held_notice_failed", state, error);
					return null;
				});
			state.held.push({ noticeId, text });
			return false;
		}
		return this.sendMessages([text]);
	}

	/** 本人以外の発言を消し、人の発言なら、その人に知らせる(知らせは10秒後に消す) */
	async receiveOther(message: IncomingMessage): Promise<void> {
		const { state, deps } = this;
		// メッセージの管理の権限がなければ消せない。そのときは、知らせだけを送る
		await deps.discord.remove(message.id).catch((error: unknown) => {
			log("others_delete_failed", state, error);
		});
		if (message.fromBot) {
			return;
		}
		const noticeId = await deps.discord.post({
			content: othersNotice(message.authorId),
			allowed_mentions: { users: [message.authorId] },
		});
		state.notices.push({
			messageId: noticeId,
			dueAt: deps.now() + OTHERS_NOTICE_MS,
		});
	}

	/** セッションのイベントを1つ扱う。同じイベントを二度扱わない */
	async handle(event: AgentEvent): Promise<StreamDecision> {
		const { state } = this;
		if (!this.markProcessed(event)) {
			return "continue";
		}
		switch (event.type) {
			case "session.status_running":
				state.awaitingRun = false;
				await this.ensureProgress();
				return "continue";
			case "agent.tool_use":
				await this.onToolUse(event);
				return "continue";
			case "agent.message": {
				const text = event.content
					.flatMap((block) => (block.type === "text" ? [block.text] : []))
					.join("");
				if (state.progress !== null) {
					state.progress.closed = true;
				}
				await this.postText(text);
				return "continue";
			}
			case "session.error":
				state.lastError = event.error;
				return "continue";
			case "session.status_idle": {
				if (state.awaitingRun) {
					return "continue";
				}
				if (event.stop_reason.type === "requires_action") {
					state.working = false;
					return "close";
				}
				await this.finishTurn();
				if (event.stop_reason.type === "retries_exhausted") {
					await this.deps.discord.post({
						content: workStopped(
							describeSessionError(state.lastError, state.model),
						),
						allowed_mentions: { parse: [] },
					});
				} else if (event.stop_reason.type === "refusal") {
					await this.deps.discord.post({
						content: REFUSAL_TEXT,
						allowed_mentions: { parse: [] },
					});
				}
				state.lastError = null;
				return "close";
			}
			case "session.status_terminated": {
				if (state.sessionId !== null) {
					await this.terminate(
						sessionFailed(describeSessionError(state.lastError, state.model)),
					);
				}
				return "close";
			}
			default:
				return "continue";
		}
	}

	/**
	 * 作業の区切り(止まったか、終わった)の後始末。作業の様子の知らせから「止める」ボタンを外し、
	 * 止めたなら「止めました」と書き足す。道具の行がない知らせは消す
	 */
	async finishTurn(): Promise<void> {
		const { state, deps } = this;
		const progress = state.progress;
		state.progress = null;
		state.working = false;
		const stopped = state.stopRequested;
		state.stopRequested = false;
		if (progress === null) {
			if (stopped) {
				await deps.discord.post({
					content: STOPPED_LINE,
					allowed_mentions: { parse: [] },
				});
			}
			return;
		}
		const lines = stopped ? [...progress.lines, STOPPED_LINE] : progress.lines;
		if (lines.length === 0) {
			await deps.discord.remove(progress.messageId).catch((error: unknown) => {
				log("progress_delete_failed", state, error);
			});
			return;
		}
		await deps.discord.edit(progress.messageId, {
			content: lines.join("\n"),
			components: [],
			allowed_mentions: { parse: [] },
		});
	}

	/** 許可のボタン。答えたら、許可を待つ間に預かった発言を送る。trueなら、イベントの流れを受ける */
	async answer(
		eventId: string,
		allow: boolean,
	): Promise<{ result: ApprovalResult; stream: boolean }> {
		const { state, deps } = this;
		const pending = state.approvals.find(
			(approval) => approval.eventId === eventId,
		);
		if (pending === undefined || state.sessionId === null) {
			return { result: "stale", stream: false };
		}
		const client = await deps.client();
		if (client === null) {
			await this.terminate(KEY_CANNOT_OPERATE);
			return { result: "ok", stream: false };
		}
		try {
			await client.beta.sessions.events.send(state.sessionId, {
				events: [
					{
						type: "user.tool_confirmation",
						tool_use_id: eventId,
						result: allow ? "allow" : "deny",
					},
				],
			});
		} catch (error) {
			if (isSessionGone(error)) {
				await this.terminate(KEY_CANNOT_OPERATE);
				return { result: "ok", stream: false };
			}
			log("approval_send_failed", state, error);
			return { result: "failed", stream: false };
		}
		state.approvals = state.approvals.filter(
			(approval) => approval.eventId !== eventId,
		);
		await deps.discord
			.edit(pending.messageId, {
				content: allow
					? allowedMessage(pending.label, pending.value)
					: deniedMessage(pending.label, pending.value),
				components: [],
				allowed_mentions: { parse: [] },
			})
			.catch((error: unknown) => {
				log("approval_edit_failed", state, error);
			});
		if (state.approvals.length > 0) {
			// ほかの呼び出しの許可も待っている。全部に答えるまで、セッションは動かない
			return { result: "ok", stream: false };
		}
		// 許可を待って止まっていたので、動き始めるまでの「止まった」知らせは前のもの
		state.awaitingRun = true;
		state.working = true;
		if (state.held.length > 0) {
			const held = state.held;
			state.held = [];
			await this.sendMessages(held.map((message) => message.text));
			for (const message of held) {
				if (message.noticeId !== null) {
					await deps.discord.remove(message.noticeId).catch(() => {});
				}
			}
		}
		return { result: "ok", stream: true };
	}

	/** 「止める」ボタン。trueなら、止まるまでイベントの流れを受ける */
	async stop(): Promise<{ result: ApprovalResult; stream: boolean }> {
		const { state, deps } = this;
		if (state.sessionId === null) {
			return { result: "stale", stream: false };
		}
		const client = await deps.client();
		if (client === null) {
			await this.terminate(KEY_CANNOT_OPERATE);
			return { result: "ok", stream: false };
		}
		try {
			await client.beta.sessions.events.send(state.sessionId, {
				events: [{ type: "user.interrupt" }],
			});
		} catch (error) {
			if (isSessionGone(error)) {
				await this.terminate(KEY_CANNOT_OPERATE);
				return { result: "ok", stream: false };
			}
			log("interrupt_failed", state, error);
			return { result: "failed", stream: false };
		}
		state.stopRequested = true;
		state.working = true;
		return { result: "ok", stream: true };
	}

	/**
	 * セッションを終えたあとの、チャンネルの後始末と知らせ。
	 * 許可のボタンと「止める」ボタンを外し、預かった発言の知らせを消して、「セッションを終えました。」を出す
	 */
	async closeAfterEnd(): Promise<void> {
		await this.clearInteractive();
		await this.deps.discord.post({
			content: ENDED,
			components: [deleteChannelRow()],
			allowed_mentions: { parse: [] },
		});
	}

	/** 本人の発言をセッションに送る。送れなければ、チャンネルで知らせる */
	private async sendMessages(texts: readonly string[]): Promise<boolean> {
		const { state, deps } = this;
		const sessionId = state.sessionId;
		if (sessionId === null) {
			return false;
		}
		const client = await deps.client();
		if (client === null) {
			await this.terminate(KEY_CANNOT_OPERATE);
			return false;
		}
		try {
			await client.beta.sessions.events.send(sessionId, {
				events: texts.map((text) => ({
					type: "user.message" as const,
					content: [{ type: "text" as const, text }],
				})),
			});
		} catch (error) {
			if (isSessionGone(error)) {
				await this.terminate(KEY_CANNOT_OPERATE);
				return false;
			}
			log("message_send_failed", state, error);
			await deps.discord.post({
				content: workStopped(describeAgentError(error, state.model)),
				allowed_mentions: { parse: [] },
			});
			return false;
		}
		// 動いている間に送った発言は、今の作業の続きとして順番に扱われる
		if (!state.working) {
			state.awaitingRun = true;
		}
		state.working = true;
		return true;
	}

	private async onToolUse(
		event: BetaManagedAgentsAgentToolUseEvent,
	): Promise<void> {
		const { state, deps } = this;
		const { label, value } = toolOperation(event.name, event.input);
		if (event.evaluated_permission === "ask") {
			const messageId = await deps.discord.post({
				content: `${APPROVAL_INTRO}\n${label}: ${value}`,
				components: [approvalRow(event.id)],
				allowed_mentions: { parse: [] },
			});
			state.approvals.push({ eventId: event.id, messageId, label, value });
			return;
		}
		await this.appendProgress(
			event.evaluated_permission === "deny"
				? deniedToolLine(value)
				: `-# ${label}: ${value}`,
		);
	}

	/** 作業の様子の知らせがなければ、「止める」ボタンだけの知らせを出す */
	private async ensureProgress(): Promise<void> {
		const { state, deps } = this;
		if (state.progress !== null) {
			return;
		}
		const messageId = await deps.discord.post({
			components: [stopRow()],
			allowed_mentions: { parse: [] },
		});
		state.progress = { messageId, lines: [], closed: false };
	}

	/**
	 * 作業の様子に1行書き足す。エージェントが発言した後か、1通に収まらないときは、新しい知らせに書き、
	 * 前の知らせから「止める」ボタンを外す(行のない知らせは消す)
	 */
	private async appendProgress(line: string): Promise<void> {
		const { state, deps } = this;
		const current = state.progress;
		if (
			current !== null &&
			!current.closed &&
			[...current.lines, line].join("\n").length <= DISCORD_MESSAGE_LIMIT
		) {
			current.lines.push(line);
			await deps.discord.edit(current.messageId, {
				content: current.lines.join("\n"),
				components: [stopRow()],
				allowed_mentions: { parse: [] },
			});
			return;
		}
		const messageId = await deps.discord.post({
			content: line,
			components: [stopRow()],
			allowed_mentions: { parse: [] },
		});
		state.progress = { messageId, lines: [line], closed: false };
		if (current !== null) {
			await this.retireProgress(current);
		}
	}

	/** 古い知らせから「止める」ボタンを外す。行がなければ消す */
	private async retireProgress(progress: Progress): Promise<void> {
		const { discord } = this.deps;
		const done =
			progress.lines.length === 0
				? discord.remove(progress.messageId)
				: discord.edit(progress.messageId, {
						content: progress.lines.join("\n"),
						components: [],
						allowed_mentions: { parse: [] },
					});
		await done.catch((error: unknown) => {
			log("progress_retire_failed", this.state, error);
		});
	}

	private async postText(text: string): Promise<void> {
		if (text.trim() === "") {
			return;
		}
		for (const part of splitMessage(text, DISCORD_MESSAGE_LIMIT)) {
			await this.deps.discord.post({
				content: part,
				allowed_mentions: { parse: [] },
			});
		}
	}

	/** セッションが使えなくなった。終えたことにして、削除ボタン付きで知らせる */
	private async terminate(message: string): Promise<void> {
		const { state, deps } = this;
		state.sessionId = null;
		await this.clearInteractive();
		await deps.markEnded();
		await deps.discord.post({
			content: message,
			components: [deleteChannelRow()],
			allowed_mentions: { parse: [] },
		});
	}

	/** 許可のボタン、「止める」ボタン、預かった発言の知らせを片付ける */
	private async clearInteractive(): Promise<void> {
		const { state, deps } = this;
		const progress = state.progress;
		const approvals = state.approvals;
		const held = state.held;
		state.progress = null;
		state.approvals = [];
		state.held = [];
		state.working = false;
		state.stopRequested = false;
		if (progress !== null) {
			await this.retireProgress(progress);
		}
		for (const approval of approvals) {
			await deps.discord
				.edit(approval.messageId, { components: [] })
				.catch(() => {});
		}
		for (const message of held) {
			if (message.noticeId !== null) {
				await deps.discord.remove(message.noticeId).catch(() => {});
			}
		}
	}

	/**
	 * まだ扱っていないイベントなら、扱った印を付けてtrueを返す。
	 * 本人が送ったイベント(user.*)と、処理の時刻のないイベントは扱わない
	 */
	private markProcessed(event: AgentEvent): boolean {
		const { state } = this;
		if (event.type.startsWith("user.")) {
			return false;
		}
		const processedAt = "processed_at" in event ? event.processed_at : null;
		if (typeof processedAt !== "string" || !("id" in event)) {
			return false;
		}
		const id = event.id;
		if (state.lastProcessedAt !== null) {
			if (processedAt < state.lastProcessedAt) {
				return false;
			}
			if (processedAt === state.lastProcessedAt) {
				if (state.recentIds.includes(id)) {
					return false;
				}
				state.recentIds.push(id);
				return true;
			}
		}
		state.lastProcessedAt = processedAt;
		state.recentIds = [id];
		return true;
	}
}

/** 本人の発言の本文。メンション(<@ID>)は、@名前にする */
export function ownerText(message: IncomingMessage): string {
	const names = new Map(message.mentions.map((user) => [user.id, user.name]));
	return message.content.replace(/<@!?(\d+)>/g, (whole, id: string) => {
		const name = names.get(id);
		return name === undefined ? whole : `@${name}`;
	});
}

/** 道具の呼び出しを、作業の様子に書く形(種類と値)にする */
export function toolOperation(
	name: string,
	input: Record<string, unknown>,
): { label: string; value: string } {
	const label = TOOL_LABELS[name] ?? name;
	const raw =
		["command", "file_path", "pattern", "url", "query", "path"]
			.map((key) => input[key])
			.find((value): value is string => typeof value === "string") ?? "";
	const flat = truncate(raw.replace(/\s+/g, " ").trim());
	return { label, value: CODE_TOOLS.has(name) ? codeSpan(flat) : flat };
}

function truncate(text: string): string {
	return text.length <= OPERATION_MAX_LENGTH
		? text
		: `${text.slice(0, OPERATION_MAX_LENGTH)}…`;
}

/** インラインのコードにする。バッククォートを含むときは、二重のバッククォートで囲む */
function codeSpan(text: string): string {
	if (text === "") {
		return "``";
	}
	return text.includes("`") ? `\`\` ${text} \`\`` : `\`${text}\``;
}

function button(
	label: string,
	customId: string,
	style: APIButtonComponentWithCustomId["style"],
): APIButtonComponentWithCustomId {
	return { type: ComponentType.Button, style, label, custom_id: customId };
}

function row(
	...components: APIComponentInMessageActionRow[]
): APIActionRowComponent<APIComponentInMessageActionRow> {
	return { type: ComponentType.ActionRow, components };
}

export function stopRow(): APIActionRowComponent<APIComponentInMessageActionRow> {
	return row(button(STOP_BUTTON_LABEL, AGENT_STOP_ID, ButtonStyle.Secondary));
}

export function approvalRow(
	eventId: string,
): APIActionRowComponent<APIComponentInMessageActionRow> {
	return row(
		button(
			ALLOW_BUTTON_LABEL,
			`${AGENT_ALLOW_PREFIX}${eventId}`,
			ButtonStyle.Primary,
		),
		button(
			DENY_BUTTON_LABEL,
			`${AGENT_DENY_PREFIX}${eventId}`,
			ButtonStyle.Secondary,
		),
	);
}

export function deleteChannelRow(): APIActionRowComponent<APIComponentInMessageActionRow> {
	return row(
		button(DELETE_CHANNEL_BUTTON_LABEL, AGENT_DELETE_ID, ButtonStyle.Secondary),
	);
}

function log(event: string, state: SessionState, error: unknown): void {
	logEvent("agent", event, {
		channelId: state.channelId,
		userId: state.ownerId,
		error: error instanceof Error ? error.message : String(error),
	});
}
