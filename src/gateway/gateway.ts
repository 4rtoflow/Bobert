import { DurableObject } from "cloudflare:workers";
import { WATCHDOG_INTERVAL_MS } from "./protocol";

/** 管理用エンドポイントに返す、接続の状態。 */
export interface GatewayStatus {
	started: boolean;
	sessionId: string | null;
	lastSequence: number | null;
	lastHeartbeatAckAt: number | null;
}

/**
 * Discord Gatewayへの常時接続を1本持つDurable Object(受信専用)。
 *
 * これから実装すること(仕様: docs/spec/architecture.md「Gateway接続処理(自作)の設計」):
 * - Hello、Identify、Resume、ハートビートとACKの監視
 * - 切断コードごとの対応(4004と4010〜4014は再接続せず、管理者に通知する)
 * - アラームによる監視と、退避やデプロイの後の再開
 * - MESSAGE_CREATE / MESSAGE_UPDATE / MESSAGE_DELETE を受け取り、Queueに渡す
 */
export class Gateway extends DurableObject<Env> {
	/** 最後にHeartbeat ACKを受け取った時刻。メモリだけに持つ。 */
	private lastHeartbeatAckAt: number | null = null;

	/** 接続を始める。以降はアラームで監視を続ける。 */
	async start(): Promise<void> {
		await this.ctx.storage.put("started", true);
		// TODO: Gatewayに接続する
		await this.ctx.storage.setAlarm(Date.now() + WATCHDOG_INTERVAL_MS);
	}

	/** 管理用エンドポイント向けに、接続の状態を返す。 */
	async status(): Promise<GatewayStatus> {
		const [started, sessionId, lastSequence] = await Promise.all([
			this.ctx.storage.get<boolean>("started"),
			this.ctx.storage.get<string>("sessionId"),
			this.ctx.storage.get<number>("lastSequence"),
		]);
		return {
			started: started ?? false,
			sessionId: sessionId ?? null,
			lastSequence: lastSequence ?? null,
			lastHeartbeatAckAt: this.lastHeartbeatAckAt,
		};
	}

	override async alarm(): Promise<void> {
		// TODO: 接続の有無と最後のACKの時刻を確かめ、必要ならResumeかIdentifyをする
		await this.ctx.storage.setAlarm(Date.now() + WATCHDOG_INTERVAL_MS);
	}
}
