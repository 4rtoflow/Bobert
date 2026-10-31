import { DurableObject } from "cloudflare:workers";
import type Anthropic from "@anthropic-ai/sdk";
import {
	createMessage,
	deleteChannel,
	deleteMessage,
	editChannelMessage,
	getGuild,
	triggerTyping,
} from "../discord/api";
import {
	findAllowedRepository,
	gitHubAccessToken,
	hasBranch,
	openPullRequest,
} from "../github/account";
import type { AnthropicCredential } from "../llm/anthropic";
import { logEvent } from "../log";
import { findSkillByName } from "../store/skills";
import { loadCredential } from "../store/users";
import { agentClient, deleteSession } from "./managed";
import {
	type AgentEvent,
	type ApprovalResult,
	discordUploadLimit,
	type IncomingMessage,
	initialState,
	MAX_ATTACHMENT_BYTES,
	REPOSITORY_TOKEN_WATCH_VALIDITY_MS,
	type RelayDeps,
	SessionRelay,
	type SessionSetup,
	type SessionState,
	withDefaults,
} from "./relay";
import { deleteAgentChannel, markAgentChannelEnded } from "./store";

/** 動いている間、つながっているかを確かめる間隔 */
const WATCHDOG_MS = 60_000;
/** 「入力中…」を出し直す間隔(約10秒で消えるため) */
const TYPING_INTERVAL_MS = 8_000;
/** 流れが切れたときに、つなぎ直す回数の上限。超えたら、次の見回りでつなぎ直す */
const MAX_RECONNECTS = 3;
/** 流れから何も届かないまま、この時間が過ぎたら、セッションの状態を確かめる */
const QUIET_MS = 60_000;

/** セッションを終えた結果 */
export type EndResult = "ended" | "already" | "failed";

/**
 * エージェントのチャンネルごとのDurable Object(仕様: docs/spec/architecture.md「エージェント」)。
 * - Gatewayから、そのチャンネルの発言を順番どおりに受け取る
 * - エージェントが動いている間だけ、セッションのイベントの流れ(SSE)を受け、チャンネルに書き込む。
 *   待っている間もつなぎ続けると、Durable Objectが止まらず、運営者の費用がセッションの数だけ増えるため
 * - 退避やデプロイで流れが切れたら、見回りのアラームでつなぎ直す(届かなかったイベントは、一覧から読み直す)
 */
export class AgentSession extends DurableObject<Env> {
	private chain: Promise<unknown> = Promise.resolve();
	private abort: AbortController | null = null;
	private typing: ReturnType<typeof setInterval> | null = null;
	private lastEventAt = 0;
	/** このサーバーで出せるファイルの大きさ(読んだら覚えておく) */
	private uploadLimitBytes: number | null = null;

	/** セッションを始めたときに、チャンネルの情報を記録する */
	async setup(setup: SessionSetup): Promise<void> {
		await this.serial(async () => {
			await this.ctx.storage.put("state", initialState(setup));
		});
	}

	/** チャンネルの発言を受け取る。本人の発言はセッションに送り、ほかの人の発言は消す */
	async receive(message: IncomingMessage): Promise<void> {
		await this.serial(async () => {
			const state = await this.loadState();
			if (state === null) {
				return;
			}
			const relay = this.relay(state);
			let stream = false;
			if (message.authorId === state.ownerId && !message.fromBot) {
				stream = await relay.receiveOwner(message);
			} else {
				await relay.receiveOther(message);
			}
			// 流れの側は、保存した状態を読んで始めるので、保存してから始める
			await this.saveState(state);
			if (stream) {
				this.startStreaming();
			}
			await this.scheduleAlarm(state);
		});
	}

	/** 許可のボタン */
	async answer(eventId: string, allow: boolean): Promise<ApprovalResult> {
		return this.serial(async () => {
			const state = await this.loadState();
			if (state === null) {
				return "stale";
			}
			const { result, stream } = await this.relay(state).answer(eventId, allow);
			await this.saveState(state);
			if (stream) {
				this.startStreaming();
			}
			await this.scheduleAlarm(state);
			return result;
		});
	}

	/** PRの確認のボタン(「作る」か「作らない」) */
	async answerPullRequest(
		toolUseId: string,
		create: boolean,
	): Promise<ApprovalResult> {
		return this.serial(async () => {
			const state = await this.loadState();
			if (state === null) {
				return "stale";
			}
			const { result, stream } = await this.relay(state).answerPullRequest(
				toolUseId,
				create,
			);
			await this.saveState(state);
			if (stream) {
				this.startStreaming();
			}
			await this.scheduleAlarm(state);
			return result;
		});
	}

	/** 「止める」ボタン */
	async stop(): Promise<ApprovalResult> {
		return this.serial(async () => {
			const state = await this.loadState();
			if (state === null) {
				return "stale";
			}
			const { result, stream } = await this.relay(state).stop();
			await this.saveState(state);
			if (stream) {
				this.startStreaming();
			}
			await this.scheduleAlarm(state);
			return result;
		});
	}

	/** セッションを終える。チャンネルは残し、「チャンネルを削除」ボタン付きで知らせる */
	async end(): Promise<EndResult> {
		return this.serial(async () => {
			const state = await this.loadState();
			if (state === null || state.sessionId === null) {
				return "already";
			}
			this.stopStreaming();
			const credential = await this.credential(state);
			if (credential !== null) {
				try {
					await deleteSession(agentClient(credential), state.sessionId);
				} catch (error) {
					this.log("end_failed", state, error);
					return "failed";
				}
			}
			const relay = this.relay(state);
			state.sessionId = null;
			await markAgentChannelEnded(this.env.DB, state.channelId);
			await relay.closeAfterEnd();
			await this.saveState(state);
			await this.scheduleAlarm(state);
			return "ended";
		});
	}

	/** チャンネルが消された(手で消されたか、削除ボタン)。セッションも消し、記録を消す */
	async channelDeleted(): Promise<void> {
		await this.discard(null);
	}

	/** Bobertがサーバーから外された。セッションを消し、記録を消す(チャンネルは残る) */
	async guildRemoved(): Promise<void> {
		await this.discard(null);
	}

	/**
	 * /delete。セッションとチャンネルを消し、記録を消す。
	 * 本人のキーはD1から先に消すので、キーは呼び出し元から受け取る
	 */
	async purge(credential: AnthropicCredential | null): Promise<void> {
		const channelId = await this.discard(credential);
		if (channelId !== null) {
			await deleteChannel(this.env.DISCORD_BOT_TOKEN, channelId).catch(
				(error: unknown) => {
					logEvent("agent", "purge_channel_delete_failed", {
						channelId,
						error: error instanceof Error ? error.message : String(error),
					});
				},
			);
		}
	}

	override async alarm(): Promise<void> {
		await this.serial(async () => {
			const state = await this.loadState();
			if (state === null) {
				return;
			}
			const now = Date.now();
			const due = state.notices.filter((notice) => notice.dueAt <= now);
			state.notices = state.notices.filter((notice) => notice.dueAt > now);
			for (const notice of due) {
				await deleteMessage(
					this.env.DISCORD_BOT_TOKEN,
					state.channelId,
					notice.messageId,
				).catch(() => {});
			}
			if (state.working && state.sessionId !== null) {
				// 長い作業の途中で、つないだリポジトリのトークンが切れないようにする
				await this.relay(state).ensureRepositoryTokens(
					REPOSITORY_TOKEN_WATCH_VALIDITY_MS,
				);
				if (this.abort === null) {
					this.startStreaming();
				} else if (now - this.lastEventAt > QUIET_MS) {
					await this.settleIfIdle(state);
				}
			}
			await this.saveState(state);
			await this.scheduleAlarm(state);
		});
	}

	/**
	 * 流れから長く何も届かないとき、セッションが止まっていれば、作業の区切りとして片付ける
	 * (止まった知らせを受け取り損ねたときに、流れを閉じるため)
	 */
	private async settleIfIdle(state: SessionState): Promise<void> {
		const credential = await this.credential(state);
		if (credential === null || state.sessionId === null) {
			return;
		}
		try {
			const session = await agentClient(credential).beta.sessions.retrieve(
				state.sessionId,
			);
			if (session.status === "idle" || session.status === "terminated") {
				this.stopStreaming();
				await this.relay(state).finishTurn();
			}
		} catch (error) {
			this.log("settle_check_failed", state, error);
		}
	}

	/** セッションを消し(キーがあれば)、記録を消す。チャンネルのIDを返す(記録がなければnull) */
	private async discard(
		credential: AnthropicCredential | null,
	): Promise<string | null> {
		return this.serial(async () => {
			const state = await this.loadState();
			if (state === null) {
				return null;
			}
			this.stopStreaming();
			if (state.sessionId !== null) {
				const key = credential ?? (await this.credential(state));
				if (key !== null) {
					await deleteSession(agentClient(key), state.sessionId).catch(
						(error: unknown) => {
							this.log("discard_session_failed", state, error);
						},
					);
				}
			}
			await deleteAgentChannel(this.env.DB, state.channelId);
			await this.ctx.storage.deleteAlarm();
			await this.ctx.storage.deleteAll();
			return state.channelId;
		});
	}

	/** イベントの流れを受け始める(受けていれば何もしない) */
	private startStreaming(): void {
		if (this.abort !== null) {
			return;
		}
		const controller = new AbortController();
		this.abort = controller;
		this.lastEventAt = Date.now();
		this.startTyping();
		this.streamEvents(controller.signal)
			.catch((error: unknown) => {
				if (!controller.signal.aborted) {
					logEvent("agent", "stream_failed", {
						error: error instanceof Error ? error.message : String(error),
					});
				}
			})
			.finally(() => {
				if (this.abort === controller) {
					this.abort = null;
					this.stopTyping();
				}
			});
	}

	private stopStreaming(): void {
		this.abort?.abort();
		this.abort = null;
		this.stopTyping();
	}

	/**
	 * イベントの流れを受ける。つないだら、届かなかったイベントを一覧から読み直してから、流れを読む。
	 * 作業が終わるか、許可を待つことになったら閉じる
	 */
	private async streamEvents(signal: AbortSignal): Promise<void> {
		for (let attempt = 0; attempt < MAX_RECONNECTS; attempt++) {
			const state = await this.loadState();
			if (state === null || state.sessionId === null || !state.working) {
				return;
			}
			const credential = await this.credential(state);
			if (credential === null) {
				return;
			}
			const client = agentClient(credential);
			const stream = await client.beta.sessions.events.stream(
				state.sessionId,
				{},
				{ signal },
			);
			if (await this.catchUp(client, state.sessionId, state.lastProcessedAt)) {
				stream.controller.abort();
				return;
			}
			for await (const event of stream) {
				if (await this.apply(event)) {
					stream.controller.abort();
					return;
				}
			}
			if (signal.aborted) {
				return;
			}
		}
	}

	/** 一覧から、まだ扱っていないイベントを読み直す。流れを閉じるならtrue */
	private async catchUp(
		client: Anthropic,
		sessionId: string,
		since: string | null,
	): Promise<boolean> {
		const events = client.beta.sessions.events.list(
			sessionId,
			since === null ? {} : { "created_at[gte]": since },
		);
		for await (const event of events) {
			if (await this.apply(event)) {
				return true;
			}
		}
		return false;
	}

	/** イベントを1つ扱い、状態を保存する。流れを閉じるならtrue */
	private async apply(event: AgentEvent): Promise<boolean> {
		this.lastEventAt = Date.now();
		return this.serial(async () => {
			const state = await this.loadState();
			if (state === null || state.sessionId === null) {
				return true;
			}
			const decision = await this.relay(state).handle(event);
			await this.saveState(state);
			if (decision === "close") {
				this.stopTyping();
				await this.scheduleAlarm(state);
				return true;
			}
			return false;
		});
	}

	private relay(state: SessionState): SessionRelay {
		const token = this.env.DISCORD_BOT_TOKEN;
		const { channelId } = state;
		const deps: RelayDeps = {
			discord: {
				post: async (body, files) =>
					(await createMessage(token, channelId, body, files)).id,
				edit: (messageId, body) =>
					editChannelMessage(token, channelId, messageId, body),
				remove: (messageId) => deleteMessage(token, channelId, messageId),
			},
			client: async () => {
				const credential = await this.credential(state);
				return credential === null ? null : agentClient(credential);
			},
			markEnded: () => markAgentChannelEnded(this.env.DB, channelId),
			fetchAttachment: async (url) => {
				const response = await fetch(url);
				if (!response.ok) {
					throw new Error(`Attachment fetch failed: ${response.status}`);
				}
				return new Uint8Array(await response.arrayBuffer());
			},
			uploadLimit: () => this.uploadLimit(state.guildId),
			readSkill: async (name) => {
				const skill = await findSkillByName(this.env.DB, state.guildId, name);
				if (skill !== null) {
					// スキルは誰でも編集できるので、何が読まれたかを後から分かるようにする
					logEvent("agent", "skill_read", {
						userId: state.ownerId,
						guildId: state.guildId,
						skill: skill.name,
					});
				}
				return skill;
			},
			github: {
				findRepository: (fullName, minValidityMs) =>
					findAllowedRepository(
						this.env,
						state.ownerId,
						fullName,
						minValidityMs,
					),
				hasBranch: (token, fullName, branch) =>
					hasBranch(token, fullName, branch),
				createPullRequest: (request) =>
					openPullRequest(this.env, state.ownerId, request),
				accessToken: (minValidityMs) =>
					gitHubAccessToken(this.env, state.ownerId, minValidityMs),
			},
			sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
			now: () => Date.now(),
		};
		return new SessionRelay(state, deps);
	}

	/**
	 * このサーバーで、エージェントが作ったファイルを1つ出せる大きさ。
	 * Discordに上げられる大きさ(サーバーのブーストの段階で決まる)と、Workersで扱える大きさ(25MB)の、小さい方
	 */
	private async uploadLimit(guildId: string): Promise<number> {
		if (this.uploadLimitBytes === null) {
			const tier = await getGuild(this.env.DISCORD_BOT_TOKEN, guildId)
				.then((guild) => guild.premium_tier)
				.catch(() => 0);
			this.uploadLimitBytes = Math.min(
				discordUploadLimit(tier),
				MAX_ATTACHMENT_BYTES,
			);
		}
		return this.uploadLimitBytes;
	}

	private credential(state: SessionState): Promise<AnthropicCredential | null> {
		return loadCredential(this.env, state.ownerId, "anthropic");
	}

	private startTyping(): void {
		if (this.typing !== null) {
			return;
		}
		const send = () => {
			void this.loadState()
				.then((state) => {
					if (state !== null) {
						return triggerTyping(this.env.DISCORD_BOT_TOKEN, state.channelId);
					}
				})
				.catch(() => {});
		};
		send();
		this.typing = setInterval(send, TYPING_INTERVAL_MS);
	}

	private stopTyping(): void {
		if (this.typing !== null) {
			clearInterval(this.typing);
			this.typing = null;
		}
	}

	/** 次のアラーム。動いている間の見回りと、本人以外への知らせを消す時刻の、早い方 */
	private async scheduleAlarm(state: SessionState): Promise<void> {
		const times = state.notices.map((notice) => notice.dueAt);
		if (state.working && state.sessionId !== null) {
			times.push(Date.now() + WATCHDOG_MS);
		}
		if (times.length === 0) {
			await this.ctx.storage.deleteAlarm();
			return;
		}
		await this.ctx.storage.setAlarm(Math.min(...times));
	}

	private loadState(): Promise<SessionState | null> {
		return this.ctx.storage
			.get<SessionState>("state")
			.then((state) => (state === undefined ? null : withDefaults(state)));
	}

	private async saveState(state: SessionState): Promise<void> {
		await this.ctx.storage.put("state", state);
	}

	/** 状態を読み書きする処理を、1つずつ順番に動かす(流れのイベントと、ボタンや発言が混ざらないように) */
	private serial<T>(work: () => Promise<T>): Promise<T> {
		const next = this.chain.then(work, work);
		this.chain = next.catch(() => {});
		return next;
	}

	private log(event: string, state: SessionState, error: unknown): void {
		logEvent("agent", event, {
			channelId: state.channelId,
			userId: state.ownerId,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}
