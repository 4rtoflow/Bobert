import type {
	GatewayHelloData,
	GatewayInvalidSessionData,
	GatewayReadyDispatchData,
} from "discord-api-types/v10";
import { GatewayOpcodes } from "../discord/constants";
import { BOBERT_INTENTS } from "./protocol";

/** Durable Objectのストレージに保存する、セッションの再開に必要な情報 */
export interface SessionState {
	sessionId: string | null;
	resumeGatewayUrl: string | null;
	sequence: number | null;
	botUserId: string | null;
}

export type ConnectMode = "identify" | "resume";

/** セッションが接続側(Durable Object)に頼む操作 */
export interface SessionDriver {
	send(payload: unknown): void;
	startHeartbeat(intervalMs: number): void;
	persist(update: Partial<SessionState>): void;
	/** READY / RESUMED 以外のイベントを渡す */
	dispatch(event: string, data: unknown): void;
	/** 今の接続を閉じて、指定の方法でつなぎ直す */
	reconnect(mode: ConnectMode, delayMs: number): void;
	/** セッションが使える状態になった(READY または RESUMED を受け取った) */
	connected(kind: "ready" | "resumed"): void;
	log(event: string, detail?: Record<string, unknown>): void;
}

interface GatewayPayload {
	op: number;
	d: unknown;
	s?: number | null;
	t?: string | null;
}

/**
 * Gatewayの1回の接続分のやり取りを受け持つ(仕様: docs/spec/architecture.md「接続の流れ」)。
 * ネットワークやタイマーには触らず、必要な操作はSessionDriverに頼む。
 */
export class GatewaySession {
	private awaitingAck = false;
	private lastAckAt: number | null = null;

	constructor(
		private readonly token: string,
		private readonly mode: ConnectMode,
		private state: SessionState,
		private readonly driver: SessionDriver,
		private readonly random: () => number = Math.random,
		private readonly now: () => number = Date.now,
	) {}

	get lastHeartbeatAckAt(): number | null {
		return this.lastAckAt;
	}

	get botUserId(): string | null {
		return this.state.botUserId;
	}

	handleMessage(raw: string): void {
		const payload = JSON.parse(raw) as GatewayPayload;
		if (typeof payload.s === "number") {
			this.state.sequence = payload.s;
			this.driver.persist({ sequence: payload.s });
		}

		switch (payload.op) {
			case GatewayOpcodes.Hello:
				this.onHello(payload.d as GatewayHelloData);
				return;
			case GatewayOpcodes.HeartbeatAck:
				this.awaitingAck = false;
				this.lastAckAt = this.now();
				return;
			case GatewayOpcodes.Heartbeat:
				this.sendHeartbeat();
				return;
			case GatewayOpcodes.Reconnect:
				this.driver.log("reconnect_requested");
				this.driver.reconnect("resume", 0);
				return;
			case GatewayOpcodes.InvalidSession:
				this.onInvalidSession(payload.d as GatewayInvalidSessionData);
				return;
			case GatewayOpcodes.Dispatch:
				this.onDispatch(payload.t ?? "", payload.d);
				return;
		}
	}

	/** ハートビートの時刻に呼ぶ。前回のACKが返っていなければ、接続が死んでいるとみなす */
	heartbeatTick(): void {
		if (this.awaitingAck) {
			this.driver.log("zombie_connection");
			this.driver.reconnect("resume", 0);
			return;
		}
		this.sendHeartbeat();
	}

	private sendHeartbeat(): void {
		this.awaitingAck = true;
		this.driver.send({ op: GatewayOpcodes.Heartbeat, d: this.state.sequence });
	}

	private onHello(data: GatewayHelloData): void {
		this.driver.startHeartbeat(data.heartbeat_interval);
		const { sessionId, sequence } = this.state;
		if (this.mode === "resume" && sessionId !== null && sequence !== null) {
			this.driver.send({
				op: GatewayOpcodes.Resume,
				d: { token: this.token, session_id: sessionId, seq: sequence },
			});
			return;
		}
		this.driver.send({
			op: GatewayOpcodes.Identify,
			d: {
				token: this.token,
				intents: BOBERT_INTENTS,
				properties: { os: "linux", browser: "bobert", device: "bobert" },
			},
		});
	}

	private onInvalidSession(resumable: boolean): void {
		// 決まった待ち時間はないが、すぐにつなぎ直さず数秒あける
		const delayMs = 1000 + Math.floor(this.random() * 4000);
		if (resumable) {
			this.driver.reconnect("resume", delayMs);
			return;
		}
		this.state = {
			...this.state,
			sessionId: null,
			resumeGatewayUrl: null,
			sequence: null,
		};
		this.driver.persist({
			sessionId: null,
			resumeGatewayUrl: null,
			sequence: null,
		});
		this.driver.log("resume_failed");
		this.driver.reconnect("identify", delayMs);
	}

	private onDispatch(event: string, data: unknown): void {
		if (event === "READY") {
			const ready = data as GatewayReadyDispatchData;
			this.state = {
				...this.state,
				sessionId: ready.session_id,
				resumeGatewayUrl: ready.resume_gateway_url,
				botUserId: ready.user.id,
			};
			this.driver.persist({
				sessionId: ready.session_id,
				resumeGatewayUrl: ready.resume_gateway_url,
				botUserId: ready.user.id,
			});
			this.driver.connected("ready");
			return;
		}
		if (event === "RESUMED") {
			this.driver.connected("resumed");
			return;
		}
		this.driver.dispatch(event, data);
	}
}
