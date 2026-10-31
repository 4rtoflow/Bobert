import type Anthropic from "@anthropic-ai/sdk";
import { toFile } from "@anthropic-ai/sdk";
import type {
	BetaManagedAgentsAgentCustomToolUseEvent,
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
import { DiscordApiError, type MessageFile } from "../discord/api";
import { ButtonStyle, ComponentType } from "../discord/constants";
import { logEvent } from "../log";
import { REFUSAL_TEXT } from "../respond/replies";
import { DISCORD_MESSAGE_LIMIT, splitMessage } from "../respond/split";
import {
	type AgentModel,
	describeAgentError,
	describeSessionError,
	isSessionGone,
	READ_SKILL_TOOL,
	SEND_FILES_TOOL,
} from "./managed";
import {
	ALLOW_BUTTON_LABEL,
	APPROVAL_INTRO,
	allowedMessage,
	attachmentTooLarge,
	DELETE_CHANNEL_BUTTON_LABEL,
	DENY_BUTTON_LABEL,
	deniedMessage,
	deniedToolLine,
	ENDED,
	formatMegabytes,
	HELD_NOTICE,
	KEY_CANNOT_OPERATE,
	NO_ATTACH_FILES,
	OUTPUT_FILES_LINE,
	othersNotice,
	outputTooLarge,
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

/** エージェントに渡す添付ファイルの、1つの大きさの上限(Workersで扱える大きさに収めるため) */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** 添付ファイルを置く場所と、エージェントがファイルを出すときに置く場所(Managed Agentsの決まり) */
const UPLOADS_DIR = "/mnt/session/uploads";
const OUTPUTS_DIR = "/mnt/session/outputs/";

/** Discordの1通に添付できるファイルの数 */
const MAX_FILES_PER_MESSAGE = 10;

/**
 * エージェントが置いたファイルが、一覧に出るまで待つ回数と間隔。
 * 置いてから一覧に出るまで、数秒かかることがあるため
 */
const OUTPUT_LOOKUP_ATTEMPTS = 5;
const OUTPUT_LOOKUP_INTERVAL_MS = 1500;

/** セッションが出したファイルの一覧を読むのに要る、ベータのヘッダー */
const MANAGED_AGENTS_BETA = "managed-agents-2026-04-01";

/** Discordのエラーコード: 権限が足りない、送るものが大きすぎる */
const MISSING_PERMISSIONS = 50013;
const REQUEST_TOO_LARGE = 40005;

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
	message: IncomingMessage;
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
	/**
	 * 答えた、Bobertが受け持つ道具の呼び出し。セッションが「答えを待っている」と止まっても、
	 * これだけを待っているなら、もう答えてあるので、流れを受け続ける
	 */
	answeredTools: string[];
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
		answeredTools: [],
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
	attachments: IncomingAttachment[];
}

/** 発言に付いた添付ファイル */
export interface IncomingAttachment {
	filename: string;
	/** 大きさ(バイト) */
	size: number;
	/** DiscordのCDNのURL。有効期限がある */
	url: string;
	contentType: string | null;
}

/** Discordへの書き込み(チャンネルは決まっている) */
export interface RelayDiscord {
	/** 投稿して、メッセージのIDを返す。filesを渡すと添付する */
	post(
		body: RESTPostAPIChannelMessageJSONBody,
		files?: MessageFile[],
	): Promise<string>;
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
	/** 添付ファイルを、DiscordのCDNから読む */
	fetchAttachment(url: string): Promise<Uint8Array>;
	/** このサーバーで、Discordに1つ上げられるファイルの大きさ(バイト) */
	uploadLimit(): Promise<number>;
	/** サーバーのスキルを、名前で読む。なければnull */
	readSkill(name: string): Promise<{ name: string; body: string } | null>;
	sleep(ms: number): Promise<void>;
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
		if (ownerText(message).trim() === "" && message.attachments.length === 0) {
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
			state.held.push({ noticeId, message });
			return false;
		}
		return this.sendMessages([message]);
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
			case "agent.custom_tool_use":
				await this.onCustomTool(event);
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
					const ids = event.stop_reason.event_ids ?? [];
					const answeredOnly =
						ids.length > 0 &&
						ids.every((id) => state.answeredTools.includes(id));
					state.answeredTools = state.answeredTools.filter(
						(id) => !ids.includes(id),
					);
					// 待っているのが、もう答えた(Bobertが受け持つ)道具だけなら、セッションは動き続ける
					if (answeredOnly) {
						return "continue";
					}
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
			await this.sendMessages(held.map((entry) => entry.message));
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
	/**
	 * 本人の発言をセッションに送る。添付ファイルは、先にサンドボックスに置き、置き場所を発言の終わりに書く。
	 * 送れなければ、チャンネルで知らせる
	 */
	private async sendMessages(
		messages: readonly IncomingMessage[],
	): Promise<boolean> {
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
			const texts: string[] = [];
			for (const message of messages) {
				const text = await this.prepare(client, sessionId, message);
				if (text !== null) {
					texts.push(text);
				}
			}
			if (texts.length === 0) {
				return false;
			}
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

	/**
	 * 発言を、エージェントに送る文にする。添付ファイルはサンドボックスに置き、置き場所を終わりに書く。
	 * 25MBを超えるファイルは渡さず、その発言への返信で知らせる。送るものがなければnull
	 */
	private async prepare(
		client: Anthropic,
		sessionId: string,
		message: IncomingMessage,
	): Promise<string | null> {
		const text = ownerText(message);
		const paths: string[] = [];
		for (const attachment of message.attachments) {
			if (attachment.size > MAX_ATTACHMENT_BYTES) {
				await this.deps.discord
					.post({
						content: attachmentTooLarge(attachment.filename),
						message_reference: { message_id: message.id },
						allowed_mentions: { parse: [], replied_user: false },
					})
					.catch((error: unknown) => {
						log("attachment_notice_failed", this.state, error);
					});
				continue;
			}
			paths.push(await this.mount(client, sessionId, message.id, attachment));
		}
		if (text.trim() === "" && paths.length === 0) {
			return null;
		}
		if (paths.length === 0) {
			return text;
		}
		const list = paths.map((path) => `- ${path}`).join("\n");
		return `${text}\n\n添付ファイル:\n${list}`.trim();
	}

	/**
	 * 添付ファイルを、本人のAnthropicのアカウントに上げて、サンドボックスに置く。置き場所を返す。
	 * 置いたファイルは、セッション用の写しになるので、上げた元のファイルは消す
	 */
	private async mount(
		client: Anthropic,
		sessionId: string,
		messageId: string,
		attachment: IncomingAttachment,
	): Promise<string> {
		const name = safeFileName(attachment.filename);
		const bytes = await this.deps.fetchAttachment(attachment.url);
		const uploaded = await client.files.upload({
			file: await toFile(
				bytes,
				name,
				attachment.contentType === null
					? undefined
					: { type: attachment.contentType },
			),
		});
		const resource = await client.beta.sessions.resources.add(sessionId, {
			type: "file",
			file_id: uploaded.id,
			mount_path: `/${messageId}/${name}`,
		});
		if (resource.file_id !== uploaded.id) {
			await client.files.delete(uploaded.id).catch((error: unknown) => {
				log("upload_cleanup_failed", this.state, error);
			});
		}
		return `${UPLOADS_DIR}/${messageId}/${name}`;
	}

	/** Bobertが受け持つ道具の呼び出しに答える */
	private async onCustomTool(
		event: BetaManagedAgentsAgentCustomToolUseEvent,
	): Promise<void> {
		const { state, deps } = this;
		const sessionId = state.sessionId;
		if (sessionId === null) {
			return;
		}
		const client = await deps.client();
		if (client === null) {
			await this.terminate(KEY_CANNOT_OPERATE);
			return;
		}
		const result =
			event.name === SEND_FILES_TOOL
				? await this.sendFiles(client, sessionId, event.input)
				: event.name === READ_SKILL_TOOL
					? await this.readSkill(event.name, event.input)
					: { text: `Unknown tool: ${event.name}`, error: true };
		try {
			await client.beta.sessions.events.send(sessionId, {
				events: [
					{
						type: "user.custom_tool_result",
						custom_tool_use_id: event.id,
						content: [{ type: "text", text: result.text }],
						is_error: result.error,
					},
				],
			});
			state.answeredTools.push(event.id);
		} catch (error) {
			if (isSessionGone(error)) {
				await this.terminate(KEY_CANNOT_OPERATE);
				return;
			}
			log("tool_result_failed", state, error);
		}
	}

	/**
	 * read_skillの道具: サーバーのスキルの本文を返す。作業の様子に「スキルを読む」の行を書く。
	 * 一覧を渡した後に、ほかの人が消したり名前を変えたりしていることがある
	 */
	private async readSkill(
		toolName: string,
		input: Record<string, unknown>,
	): Promise<{ text: string; error: boolean }> {
		const { label, value } = toolOperation(toolName, input);
		await this.appendProgress(`-# ${label}: ${value}`);
		const name = typeof input.name === "string" ? input.name.trim() : "";
		const skill = await this.deps.readSkill(name);
		if (skill === null) {
			return {
				text: `「${name}」というスキルはありません。一覧にある名前で指定してください。`,
				error: true,
			};
		}
		return {
			text: `スキル「${skill.name}」の本文です。この手順に従ってください。\n\n${skill.body}`,
			error: false,
		};
	}

	/**
	 * send_filesの道具: エージェントが /mnt/session/outputs/ に置いたファイルを、チャンネルに添付する。
	 * 結果は、エージェントに返す文にする(本人には、ファイルと、出せなかったときの知らせを見せる)
	 */
	private async sendFiles(
		client: Anthropic,
		sessionId: string,
		input: Record<string, unknown>,
	): Promise<{ text: string; error: boolean }> {
		const { deps } = this;
		const names = Array.isArray(input.names)
			? input.names
					.filter((name): name is string => typeof name === "string")
					.map(outputName)
					.filter((name) => name !== "")
			: [];
		if (names.length === 0) {
			return {
				text: "names に、/mnt/session/outputs/ に置いたファイルの名前を指定してください。",
				error: true,
			};
		}
		const found = await this.findOutputs(client, sessionId, names);
		const limit = await deps.uploadLimit();
		const missing = names.filter((name) => !found.has(name));
		const tooLarge: { name: string; size: number }[] = [];
		const ready: { name: string; file: MessageFile }[] = [];
		for (const name of names) {
			const output = found.get(name);
			if (output === undefined) {
				continue;
			}
			if (output.size_bytes > limit) {
				tooLarge.push({
					name: baseName(output.filename),
					size: output.size_bytes,
				});
				continue;
			}
			const response = await client.files.download(output.id);
			ready.push({
				name,
				file: {
					name: baseName(output.filename),
					content: new Uint8Array(await response.arrayBuffer()),
					contentType: output.mime_type,
				},
			});
		}
		const sent: string[] = [];
		let noPermission = false;
		for (let start = 0; start < ready.length; start += MAX_FILES_PER_MESSAGE) {
			const chunk = ready.slice(start, start + MAX_FILES_PER_MESSAGE);
			try {
				await deps.discord.post(
					{ content: OUTPUT_FILES_LINE, allowed_mentions: { parse: [] } },
					chunk.map((entry) => entry.file),
				);
				sent.push(...chunk.map((entry) => entry.name));
			} catch (error) {
				if (!(error instanceof DiscordApiError)) {
					throw error;
				}
				if (error.code === MISSING_PERMISSIONS) {
					noPermission = true;
					break;
				}
				if (error.status === 413 || error.code === REQUEST_TOO_LARGE) {
					tooLarge.push(
						...chunk.map((entry) => ({
							name: entry.file.name,
							size: entry.file.content.length,
						})),
					);
					continue;
				}
				throw error;
			}
		}
		if (noPermission) {
			await deps.discord.post({
				content: NO_ATTACH_FILES,
				allowed_mentions: { parse: [] },
			});
		}
		for (const file of tooLarge) {
			await deps.discord.post({
				content: outputTooLarge(file.name, formatMegabytes(file.size)),
				allowed_mentions: { parse: [] },
			});
		}
		const report: string[] = [];
		if (noPermission) {
			report.push(
				"Bobertに、Discordでファイルを添付する権限がないため、出せませんでした。",
			);
		} else if (sent.length > 0) {
			report.push(`チャンネルに出しました: ${sent.join(", ")}`);
		}
		if (tooLarge.length > 0) {
			report.push(
				`大きすぎて、Discordに上げられませんでした: ${tooLarge.map((file) => file.name).join(", ")}`,
			);
		}
		if (missing.length > 0) {
			report.push(
				`${OUTPUTS_DIR} に見つかりませんでした: ${missing.join(", ")}`,
			);
		}
		return { text: report.join("\n"), error: sent.length === 0 };
	}

	/**
	 * セッションが出したファイルの一覧から、名前で探す。置いてから一覧に出るまで時間がかかることがあるので、
	 * 見つからない名前があれば、少し待って読み直す
	 */
	private async findOutputs(
		client: Anthropic,
		sessionId: string,
		names: readonly string[],
	): Promise<Map<string, OutputFile>> {
		let found = new Map<string, OutputFile>();
		for (let attempt = 0; attempt < OUTPUT_LOOKUP_ATTEMPTS; attempt++) {
			if (attempt > 0) {
				await this.deps.sleep(OUTPUT_LOOKUP_INTERVAL_MS);
			}
			const byName = new Map<string, OutputFile>();
			for await (const file of client.beta.files.list({
				scope_id: sessionId,
				betas: [MANAGED_AGENTS_BETA],
			})) {
				// 同じ名前が何度も出ていれば、新しいものを使う
				for (const key of [
					outputName(file.filename),
					baseName(file.filename),
				]) {
					const current = byName.get(key);
					if (current === undefined || current.created_at < file.created_at) {
						byName.set(key, file);
					}
				}
			}
			found = new Map(
				names.flatMap((name) => {
					const file = byName.get(name);
					return file === undefined ? [] : [[name, file] as const];
				}),
			);
			if (found.size === names.length) {
				break;
			}
		}
		return found;
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
		state.answeredTools = [];
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

/** セッションが出したファイル */
interface OutputFile {
	id: string;
	filename: string;
	size_bytes: number;
	mime_type: string;
	created_at: string;
}

/**
 * Discordに1つ上げられるファイルの大きさ。サーバーのブーストの段階で決まる
 * (段階2は50MB、段階3は100MB、それ以外は10MB)
 */
export function discordUploadLimit(premiumTier: number): number {
	const megabytes = premiumTier >= 3 ? 100 : premiumTier === 2 ? 50 : 10;
	return megabytes * 1024 * 1024;
}

/** 出すファイルの名前。/mnt/session/outputs/ から後ろにする */
function outputName(path: string): string {
	const trimmed = path.trim();
	return trimmed.startsWith(OUTPUTS_DIR)
		? trimmed.slice(OUTPUTS_DIR.length)
		: trimmed.replace(/^\/+/, "");
}

function baseName(path: string): string {
	return path.split("/").at(-1) ?? path;
}

/** 置き場所に使うファイルの名前。区切りの文字(/と\)と制御文字を「_」にし、100文字までにする */
export function safeFileName(filename: string): string {
	const name = [...filename]
		.map((char) =>
			char.charCodeAt(0) < 32 || char === "/" || char === "\\" ? "_" : char,
		)
		.join("")
		.trim()
		.slice(0, 100);
	return name === "" || name === "." || name === ".." ? "file" : name;
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
		["command", "file_path", "pattern", "url", "query", "path", "name"]
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
