import { DurableObject } from "cloudflare:workers";
import type {
	GatewayMessageDeleteBulkDispatchData,
	GatewayMessageDeleteDispatchData,
} from "discord-api-types/v10";
import { notifyAdmin } from "../alert";
import { getGatewayBot } from "../discord/api";
import type { QueueMessage } from "../queue/messages";
import {
	type GatewayMessage,
	shouldRespond,
	shouldStore,
	toStoredMessage,
} from "./messages";
import { isFatalCloseCode, WATCHDOG_INTERVAL_MS } from "./protocol";
import {
	type ConnectMode,
	GatewaySession,
	type SessionDriver,
	type SessionState,
} from "./session";

/** 管理用エンドポイントに返す、接続の状態 */
export interface GatewayStatus {
	started: boolean;
	connected: boolean;
	sessionId: string | null;
	lastSequence: number | null;
	lastHeartbeatAckAt: number | null;
	stats: GatewayStats;
}

interface GatewayStats {
	identifies: number;
	resumes: number;
	reconnects: number;
	lastDisconnect: { at: number; code: number; reason: string } | null;
}

const EMPTY_STATS: GatewayStats = {
	identifies: 0,
	resumes: 0,
	reconnects: 0,
	lastDisconnect: null,
};

/** 再接続の待ち時間の上限 */
const MAX_BACKOFF_MS = 5 * 60_000;

/**
 * Discord Gatewayへの常時接続を1本持つDurable Object(受信専用)。
 * 仕様: docs/spec/architecture.md「Gateway接続処理(自作)の設計」
 *
 * - 接続の開始は管理用エンドポイント(start)から。以降は30秒ごとのアラームで監視する
 * - 退避やデプロイで切れても、ストレージに保存したセッション情報でResumeする
 * - 受け取ったメッセージはQueueに渡す(保存用と、応答が必要なら応答用)
 */
export class Gateway extends DurableObject<Env> {
	private socket: WebSocket | null = null;
	private session: GatewaySession | null = null;
	private connectedAt: number | null = null;
	private lastReceivedAt: number | null = null;
	private heartbeatIntervalMs: number | null = null;
	private heartbeatDelay: ReturnType<typeof setTimeout> | null = null;
	private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private connecting = false;
	private consecutiveFailures = 0;

	/** 接続を始める。以降はアラームで監視を続ける。すでに接続中なら何もしない */
	async start(): Promise<void> {
		await this.ctx.storage.put("started", true);
		if (!this.isHealthy()) {
			await this.connectToDiscord();
		}
		await this.scheduleWatchdog();
	}

	/** 接続を止める(開発やメンテナンス用) */
	async stop(): Promise<void> {
		await this.ctx.storage.put("started", false);
		this.clearReconnectTimer();
		// 1000で閉じるとセッションが無効になるので、次回はIdentifyから始まる
		this.teardown(1000);
		await this.clearSession();
		// 止めていた間は、取りこぼしとして記録しない
		await this.ctx.storage.delete("lastAliveAt");
		await this.ctx.storage.deleteAlarm();
	}

	/** 管理用エンドポイント向けに、接続の状態を返す */
	async status(): Promise<GatewayStatus> {
		const state = await this.loadSessionState();
		return {
			started: await this.isStarted(),
			connected: this.socket?.readyState === WebSocket.OPEN,
			sessionId: state.sessionId,
			lastSequence: state.sequence,
			lastHeartbeatAckAt: this.session?.lastHeartbeatAckAt ?? null,
			stats: await this.loadStats(),
		};
	}

	override async alarm(): Promise<void> {
		if (!(await this.isStarted())) {
			return;
		}
		if (this.isHealthy()) {
			// 退避では切断の処理が動かないので、生きていた時刻をここでも残しておく
			await this.saveLastAliveAt();
		} else if (!this.connecting && this.reconnectTimer === null) {
			this.log("watchdog_reconnect");
			await this.connectToDiscord();
		}
		await this.scheduleWatchdog();
	}

	// DurableObjectのconnect(TCPの受け口)と名前が重ならないようにする
	private async connectToDiscord(): Promise<void> {
		if (this.connecting) {
			return;
		}
		this.connecting = true;
		this.clearReconnectTimer();
		try {
			this.teardown(4000);
			const state = await this.loadSessionState();
			const mode: ConnectMode =
				state.sessionId !== null &&
				state.resumeGatewayUrl !== null &&
				state.sequence !== null
					? "resume"
					: "identify";

			let baseUrl: string;
			if (mode === "resume" && state.resumeGatewayUrl !== null) {
				baseUrl = state.resumeGatewayUrl;
			} else {
				const gateway = await getGatewayBot(this.env.DISCORD_BOT_TOKEN);
				const limit = gateway.session_start_limit;
				if (limit.remaining <= 0) {
					await notifyAdmin(
						this.env,
						`Gatewayの新規接続の上限に達しました。${Math.ceil(limit.reset_after / 60_000)}分後に再試行します。`,
					);
					this.scheduleReconnect(limit.reset_after);
					return;
				}
				baseUrl = gateway.url;
			}

			const socket = await openWebSocket(`${baseUrl}/?v=10&encoding=json`);
			this.socket = socket;
			this.connectedAt = Date.now();
			this.session = new GatewaySession(
				this.env.DISCORD_BOT_TOKEN,
				mode,
				state,
				this.createDriver(socket),
			);
			socket.addEventListener("message", (event) => {
				if (this.socket === socket && typeof event.data === "string") {
					this.lastReceivedAt = Date.now();
					this.session?.handleMessage(event.data);
				}
			});
			socket.addEventListener("close", (event) => {
				void this.onClose(socket, event.code, event.reason);
			});
			socket.addEventListener("error", () => {
				this.log("socket_error");
			});
			this.log("connecting", { mode });
		} catch (error) {
			this.log("connect_failed", { error: String(error) });
			this.scheduleReconnect(this.nextBackoffMs());
		} finally {
			this.connecting = false;
		}
	}

	private createDriver(socket: WebSocket): SessionDriver {
		return {
			send: (payload) => {
				if (this.socket === socket) {
					socket.send(JSON.stringify(payload));
				}
			},
			startHeartbeat: (intervalMs) => this.startHeartbeat(socket, intervalMs),
			persist: (update) => {
				void this.ctx.storage.put(update);
			},
			dispatch: (event, data) => {
				this.forward(event, data).catch((error: unknown) => {
					this.log("forward_failed", { event, error: String(error) });
				});
			},
			reconnect: (mode, delayMs) => {
				if (this.socket !== socket) {
					return;
				}
				this.log("reconnect", { mode, delayMs });
				void this.updateStats((stats) => ({
					...stats,
					reconnects: stats.reconnects + 1,
				}));
				// 1000と1001以外で閉じると、セッションを再開できる
				this.teardown(4000);
				this.scheduleReconnect(delayMs);
			},
			connected: (kind) => {
				this.consecutiveFailures = 0;
				this.onConnected(kind).catch((error: unknown) => {
					this.log("record_failed", { error: String(error) });
				});
			},
			log: (event, detail) => this.log(event, detail),
		};
	}

	private async onClose(
		socket: WebSocket,
		code: number,
		reason: string,
	): Promise<void> {
		if (this.socket !== socket) {
			// 自分で閉じた古い接続
			return;
		}
		const disconnectedAt = Date.now();
		this.log("disconnected", {
			code,
			reason,
			connectedForMs:
				this.connectedAt === null ? null : disconnectedAt - this.connectedAt,
		});
		this.teardown();
		await this.updateStats((stats) => ({
			...stats,
			lastDisconnect: { at: disconnectedAt, code, reason },
		}));

		if (isFatalCloseCode(code)) {
			await this.ctx.storage.put("started", false);
			await this.ctx.storage.deleteAlarm();
			await notifyAdmin(
				this.env,
				`Gatewayが切断コード${code}で切れたため、再接続を止めました(${reason || "理由なし"})。トークンやインテント、Message Contentの設定を確認してください。`,
			);
			return;
		}
		this.scheduleReconnect(this.nextBackoffMs());
	}

	/**
	 * つながったことを、切れていた時間と一緒に記録する。
	 * Resumeできずに新しいセッションで始めた場合は、その間のメッセージが届かないので、
	 * 取りこぼしの可能性がある時間帯も記録する。
	 */
	private async onConnected(kind: "ready" | "resumed"): Promise<void> {
		const now = Date.now();
		const lastAliveAt = await this.ctx.storage.get<number>("lastAliveAt");
		this.log(kind, {
			downtimeMs: lastAliveAt === undefined ? null : now - lastAliveAt,
		});
		if (kind === "ready" && lastAliveAt !== undefined) {
			this.log("possible_message_loss", {
				from: new Date(lastAliveAt).toISOString(),
				to: new Date(now).toISOString(),
			});
		}
		await this.ctx.storage.put("lastAliveAt", now);
		await this.updateStats((stats) =>
			kind === "ready"
				? { ...stats, identifies: stats.identifies + 1 }
				: { ...stats, resumes: stats.resumes + 1 },
		);
	}

	private async forward(event: string, data: unknown): Promise<void> {
		switch (event) {
			case "MESSAGE_CREATE": {
				const message = data as GatewayMessage;
				if (!message.guild_id) {
					return;
				}
				// 応答を先に入れる。保存の側で失敗しても、応答は止めないため
				const botUserId = this.session?.botUserId;
				if (botUserId && shouldRespond(message, botUserId)) {
					await this.env.RESPOND_QUEUE.send({
						kind: "respond",
						messageId: message.id,
						channelId: message.channel_id,
						guildId: message.guild_id,
						authorId: message.author.id,
					} satisfies QueueMessage);
				}
				if (shouldStore(message)) {
					await this.env.INGEST_QUEUE.send({
						kind: "ingest",
						message: toStoredMessage(message),
					} satisfies QueueMessage);
				}
				return;
			}
			case "MESSAGE_UPDATE": {
				const message = data as Partial<GatewayMessage>;
				// 本文を含まない更新(埋め込みの展開など)は保存内容に関係しない
				if (
					!shouldStore(message) ||
					typeof message.content !== "string" ||
					!message.author ||
					typeof message.timestamp !== "string"
				) {
					return;
				}
				await this.env.INGEST_QUEUE.send({
					kind: "ingest",
					message: toStoredMessage(message as GatewayMessage),
				} satisfies QueueMessage);
				return;
			}
			case "MESSAGE_DELETE": {
				const deleted = data as GatewayMessageDeleteDispatchData;
				await this.env.INGEST_QUEUE.send({
					kind: "delete",
					channelId: deleted.channel_id,
					messageIds: [deleted.id],
				} satisfies QueueMessage);
				return;
			}
			case "MESSAGE_DELETE_BULK": {
				const deleted = data as GatewayMessageDeleteBulkDispatchData;
				await this.env.INGEST_QUEUE.send({
					kind: "delete",
					channelId: deleted.channel_id,
					messageIds: deleted.ids,
				} satisfies QueueMessage);
				return;
			}
		}
	}

	private startHeartbeat(socket: WebSocket, intervalMs: number): void {
		this.stopHeartbeat();
		this.heartbeatIntervalMs = intervalMs;
		const tick = () => {
			if (this.socket === socket) {
				this.session?.heartbeatTick();
			}
		};
		// 最初のハートビートは「間隔×0〜1のランダム値」後に送る
		this.heartbeatDelay = setTimeout(
			() => {
				this.heartbeatDelay = null;
				tick();
				this.heartbeatInterval = setInterval(tick, intervalMs);
			},
			Math.floor(intervalMs * Math.random()),
		);
	}

	private stopHeartbeat(): void {
		if (this.heartbeatDelay !== null) {
			clearTimeout(this.heartbeatDelay);
			this.heartbeatDelay = null;
		}
		if (this.heartbeatInterval !== null) {
			clearInterval(this.heartbeatInterval);
			this.heartbeatInterval = null;
		}
	}

	/** 今の接続を手放す。closeCodeを指定したら、その切断コードで閉じる */
	private teardown(closeCode?: number): void {
		this.stopHeartbeat();
		const socket = this.socket;
		if (socket !== null) {
			void this.saveLastAliveAt();
		}
		this.socket = null;
		this.session = null;
		this.connectedAt = null;
		this.lastReceivedAt = null;
		if (socket !== null && closeCode !== undefined) {
			try {
				socket.close(closeCode, "Bobert is reconnecting");
			} catch {
				// すでに閉じている
			}
		}
	}

	private scheduleReconnect(delayMs: number): void {
		this.clearReconnectTimer();
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			void this.connectToDiscord();
		}, delayMs);
	}

	private clearReconnectTimer(): void {
		if (this.reconnectTimer !== null) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
	}

	/** 失敗が続くほど待ち時間を倍にする(上限5分)。同時の再接続が重ならないよう揺らぎも足す */
	private nextBackoffMs(): number {
		this.consecutiveFailures += 1;
		const base = Math.min(
			1000 * 2 ** (this.consecutiveFailures - 1),
			MAX_BACKOFF_MS,
		);
		return base + Math.floor(Math.random() * 1000);
	}

	/** 接続が開いていて、Discordからの受信(ハートビートのACKを含む)が途切れていないか */
	private isHealthy(): boolean {
		if (this.socket?.readyState !== WebSocket.OPEN) {
			return false;
		}
		const interval = this.heartbeatIntervalMs ?? WATCHDOG_INTERVAL_MS;
		const lastSignal = this.lastReceivedAt ?? this.connectedAt ?? 0;
		return Date.now() - lastSignal < interval * 2 + WATCHDOG_INTERVAL_MS;
	}

	/** 最後に受信した時刻を保存する。次につながったとき、切れていた時間の記録に使う */
	private async saveLastAliveAt(): Promise<void> {
		if (this.lastReceivedAt !== null) {
			await this.ctx.storage.put("lastAliveAt", this.lastReceivedAt);
		}
	}

	private async scheduleWatchdog(): Promise<void> {
		await this.ctx.storage.setAlarm(Date.now() + WATCHDOG_INTERVAL_MS);
	}

	private async isStarted(): Promise<boolean> {
		return (await this.ctx.storage.get<boolean>("started")) ?? false;
	}

	private async loadSessionState(): Promise<SessionState> {
		const values = await this.ctx.storage.get<string | number | null>([
			"sessionId",
			"resumeGatewayUrl",
			"sequence",
			"botUserId",
		]);
		const text = (key: string) => {
			const value = values.get(key);
			return typeof value === "string" ? value : null;
		};
		const sequence = values.get("sequence");
		return {
			sessionId: text("sessionId"),
			resumeGatewayUrl: text("resumeGatewayUrl"),
			sequence: typeof sequence === "number" ? sequence : null,
			botUserId: text("botUserId"),
		};
	}

	private async clearSession(): Promise<void> {
		await this.ctx.storage.delete([
			"sessionId",
			"resumeGatewayUrl",
			"sequence",
		]);
	}

	private async loadStats(): Promise<GatewayStats> {
		return (await this.ctx.storage.get<GatewayStats>("stats")) ?? EMPTY_STATS;
	}

	private async updateStats(
		update: (stats: GatewayStats) => GatewayStats,
	): Promise<void> {
		await this.ctx.storage.put("stats", update(await this.loadStats()));
	}

	private log(event: string, detail: Record<string, unknown> = {}): void {
		console.log(JSON.stringify({ component: "gateway", event, ...detail }));
	}
}

/** 外向きのWebSocketを開く。Workersでは、https:// にUpgradeヘッダー付きでfetchする */
async function openWebSocket(url: string): Promise<WebSocket> {
	const response = await fetch(url.replace(/^wss:\/\//, "https://"), {
		headers: { Upgrade: "websocket" },
	});
	const socket = response.webSocket;
	if (!socket) {
		throw new Error(`WebSocket upgrade failed with status ${response.status}`);
	}
	socket.accept();
	return socket;
}
