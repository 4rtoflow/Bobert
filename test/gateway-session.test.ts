import { describe, expect, it } from "vitest";
import { GatewayOpcodes } from "../src/discord/constants";
import { BOBERT_INTENTS } from "../src/gateway/protocol";
import {
	type ConnectMode,
	GatewaySession,
	type SessionDriver,
	type SessionState,
} from "../src/gateway/session";

const EMPTY_STATE: SessionState = {
	sessionId: null,
	resumeGatewayUrl: null,
	sequence: null,
	botUserId: null,
};

const RESUMABLE_STATE: SessionState = {
	sessionId: "session-1",
	resumeGatewayUrl: "wss://resume.example",
	sequence: 42,
	botUserId: "bot-1",
};

/** セッションが頼んだ操作を記録するだけの接続側 */
function createDriver() {
	const calls = {
		sent: [] as Array<{ op: number; d: unknown }>,
		heartbeatIntervals: [] as number[],
		persisted: [] as Array<Partial<SessionState>>,
		dispatched: [] as Array<{ event: string; data: unknown }>,
		reconnects: [] as Array<{ mode: ConnectMode; delayMs: number }>,
		connected: [] as Array<"ready" | "resumed">,
	};
	const driver: SessionDriver = {
		send: (payload) => calls.sent.push(payload as { op: number; d: unknown }),
		startHeartbeat: (intervalMs) => calls.heartbeatIntervals.push(intervalMs),
		persist: (update) => calls.persisted.push(update),
		dispatch: (event, data) => calls.dispatched.push({ event, data }),
		reconnect: (mode, delayMs) => calls.reconnects.push({ mode, delayMs }),
		connected: (kind) => calls.connected.push(kind),
		log: () => {},
	};
	return { driver, calls };
}

function payload(op: number, d: unknown, s?: number, t?: string): string {
	return JSON.stringify({ op, d, s: s ?? null, t: t ?? null });
}

describe("GatewaySession", () => {
	it("Helloを受け取ると、ハートビートを始めてIdentifyを送る", () => {
		const { driver, calls } = createDriver();
		const session = new GatewaySession(
			"token",
			"identify",
			{ ...EMPTY_STATE },
			driver,
		);

		session.handleMessage(
			payload(GatewayOpcodes.Hello, { heartbeat_interval: 41250 }),
		);

		expect(calls.heartbeatIntervals).toEqual([41250]);
		expect(calls.sent).toEqual([
			{
				op: GatewayOpcodes.Identify,
				d: expect.objectContaining({ token: "token", intents: BOBERT_INTENTS }),
			},
		]);
	});

	it("再開できる情報があれば、IdentifyではなくResumeを送る", () => {
		const { driver, calls } = createDriver();
		const session = new GatewaySession(
			"token",
			"resume",
			{ ...RESUMABLE_STATE },
			driver,
		);

		session.handleMessage(
			payload(GatewayOpcodes.Hello, { heartbeat_interval: 41250 }),
		);

		expect(calls.sent).toEqual([
			{
				op: GatewayOpcodes.Resume,
				d: { token: "token", session_id: "session-1", seq: 42 },
			},
		]);
	});

	it("READYでセッション情報を保存し、それ以外のイベントは受け渡す", () => {
		const { driver, calls } = createDriver();
		const session = new GatewaySession(
			"token",
			"identify",
			{ ...EMPTY_STATE },
			driver,
		);

		session.handleMessage(
			payload(
				GatewayOpcodes.Dispatch,
				{
					session_id: "session-2",
					resume_gateway_url: "wss://resume-2.example",
					user: { id: "bot-2" },
				},
				1,
				"READY",
			),
		);
		session.handleMessage(
			payload(
				GatewayOpcodes.Dispatch,
				{ id: "message-1" },
				2,
				"MESSAGE_CREATE",
			),
		);

		expect(calls.connected).toEqual(["ready"]);
		expect(calls.persisted).toContainEqual({
			sessionId: "session-2",
			resumeGatewayUrl: "wss://resume-2.example",
			botUserId: "bot-2",
		});
		expect(calls.persisted).toContainEqual({ sequence: 2 });
		expect(session.botUserId).toBe("bot-2");
		expect(calls.dispatched).toEqual([
			{ event: "MESSAGE_CREATE", data: { id: "message-1" } },
		]);
	});

	it("ハートビートに最後の通し番号を付け、ACKが返らなければつなぎ直す", () => {
		const { driver, calls } = createDriver();
		const session = new GatewaySession(
			"token",
			"resume",
			{ ...RESUMABLE_STATE },
			driver,
		);

		session.heartbeatTick();
		expect(calls.sent).toEqual([{ op: GatewayOpcodes.Heartbeat, d: 42 }]);

		// ACKが返る前に次のハートビートの時刻が来た
		session.heartbeatTick();
		expect(calls.reconnects).toEqual([{ mode: "resume", delayMs: 0 }]);
	});

	it("ACKが返っていれば、次のハートビートを送る", () => {
		const { driver, calls } = createDriver();
		const session = new GatewaySession(
			"token",
			"resume",
			{ ...RESUMABLE_STATE },
			driver,
			Math.random,
			() => 1_000,
		);

		session.heartbeatTick();
		session.handleMessage(payload(GatewayOpcodes.HeartbeatAck, null));
		session.heartbeatTick();

		expect(calls.sent).toHaveLength(2);
		expect(calls.reconnects).toEqual([]);
		expect(session.lastHeartbeatAckAt).toBe(1_000);
	});

	it("Reconnect(op 7)を受け取ると、Resumeでつなぎ直す", () => {
		const { driver, calls } = createDriver();
		const session = new GatewaySession(
			"token",
			"resume",
			{ ...RESUMABLE_STATE },
			driver,
		);

		session.handleMessage(payload(GatewayOpcodes.Reconnect, null));

		expect(calls.reconnects).toEqual([{ mode: "resume", delayMs: 0 }]);
	});

	it("Invalid Session(op 9)で再開できなければ、セッション情報を消してIdentifyでつなぎ直す", () => {
		const { driver, calls } = createDriver();
		const session = new GatewaySession(
			"token",
			"resume",
			{ ...RESUMABLE_STATE },
			driver,
			() => 0.5,
		);

		session.handleMessage(payload(GatewayOpcodes.InvalidSession, false));

		expect(calls.persisted).toContainEqual({
			sessionId: null,
			resumeGatewayUrl: null,
			sequence: null,
		});
		expect(calls.reconnects).toEqual([{ mode: "identify", delayMs: 3000 }]);
	});

	it("Invalid Session(op 9)で再開できるなら、Resumeでつなぎ直す", () => {
		const { driver, calls } = createDriver();
		const session = new GatewaySession(
			"token",
			"resume",
			{ ...RESUMABLE_STATE },
			driver,
			() => 0,
		);

		session.handleMessage(payload(GatewayOpcodes.InvalidSession, true));

		expect(calls.reconnects).toEqual([{ mode: "resume", delayMs: 1000 }]);
	});
});
