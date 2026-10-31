import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { insertAgentChannel } from "../src/agent/store";
import { agentSessionStub } from "../src/agent/stubs";
import { othersNotice } from "../src/agent/texts";
import { BOT, discordMessage } from "./fixtures";
import { type FetchCall, mockFetch, userFactory } from "./helpers";

const newUser = userFactory(62000);
const GUILD_ID = "900";
const MODEL = { id: "claude-haiku-5-5", label: "Claude Haiku 5.5" };

afterEach(() => {
	vi.restoreAllMocks();
});

/** イベントの流れ(SSE)の本文 */
function sse(events: Record<string, unknown>[]): Response {
	const body = events
		.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
		.join("");
	return new Response(body, {
		headers: { "Content-Type": "text/event-stream" },
	});
}

let sequence = 0;
function event(body: Record<string, unknown>): Record<string, unknown> {
	sequence++;
	return {
		id: `sevt_${sequence}`,
		processed_at: `2026-10-31T01:00:${String(sequence).padStart(2, "0")}.000Z`,
		...body,
	};
}

/** Managed AgentsとDiscordのAPIの偽物。セッションのイベントの流れは、渡したイベントを返す */
function mockApis(stream: Record<string, unknown>[]) {
	let messageId = 0;
	return mockFetch((call: FetchCall) => {
		const path = call.url.pathname;
		if (call.url.hostname === "api.anthropic.com") {
			if (path === "/v1/sessions/sesn_1/events/stream") {
				return sse(stream);
			}
			if (path === "/v1/sessions/sesn_1/events" && call.method === "GET") {
				return Response.json({ data: [], next_page: null });
			}
			if (path === "/v1/sessions/sesn_1/events" && call.method === "POST") {
				return Response.json({ data: [] });
			}
			return Response.json({ id: "sesn_1", type: "session", status: "idle" });
		}
		if (call.method === "POST" && path.endsWith("/messages")) {
			messageId++;
			return Response.json(discordMessage(`m${messageId}`, BOT, ""));
		}
		if (call.method === "PATCH") {
			return Response.json(discordMessage("m", BOT, ""));
		}
		return new Response(null, { status: 204 });
	});
}

async function startedChannel(channelId: string, ownerId: string) {
	await insertAgentChannel(env.DB, {
		channelId,
		guildId: GUILD_ID,
		ownerId,
		number: 1,
		sessionId: "sesn_1",
		createdAt: Date.now(),
	});
	const stub = agentSessionStub(env, channelId);
	await stub.setup({
		channelId,
		guildId: GUILD_ID,
		ownerId,
		sessionId: "sesn_1",
		model: MODEL,
	});
	return stub;
}

function posted(calls: FetchCall[], channelId: string) {
	return calls
		.filter(
			(call) =>
				call.method === "POST" &&
				call.url.pathname === `/api/v10/channels/${channelId}/messages`,
		)
		.map((call) => call.body as { content?: string; components?: unknown[] });
}

describe("エージェントのチャンネルのDurable Object", () => {
	it("本人の発言をセッションに送り、作業の様子とエージェントの返事をチャンネルに書き込む", async () => {
		const owner = await newUser("anthropic");
		const channelId = "62101";
		const stub = await startedChannel(channelId, owner.id);
		const calls = mockApis([
			event({ type: "session.status_running" }),
			event({
				type: "agent.tool_use",
				name: "bash",
				input: { command: "npm test" },
				evaluated_permission: "allow",
			}),
			event({
				type: "agent.message",
				content: [{ type: "text", text: "テストは通りました。" }],
			}),
			event({
				type: "session.status_idle",
				stop_reason: { type: "end_turn" },
				stop_details: null,
			}),
		]);

		await stub.receive({
			id: "1",
			authorId: owner.id,
			fromBot: false,
			content: "テストを動かして",
			mentions: [],
		});

		await vi.waitFor(() => {
			expect(posted(calls, channelId).map((body) => body.content)).toContain(
				"テストは通りました。",
			);
			// 作業が終わったら、作業の様子の知らせから「止める」ボタンを外す
			const lastEdit = calls.filter((call) => call.method === "PATCH").at(-1)
				?.body as { content?: string; components?: unknown[] } | undefined;
			expect(lastEdit).toMatchObject({
				content: "-# コマンド: `npm test`",
				components: [],
			});
		});
		const sent = calls.find(
			(call) =>
				call.method === "POST" &&
				call.url.pathname === "/v1/sessions/sesn_1/events",
		);
		expect(sent?.body).toEqual({
			events: [
				{
					type: "user.message",
					content: [{ type: "text", text: "テストを動かして" }],
				},
			],
		});
		// 動き始めたら、「止める」ボタンだけの知らせを出す
		expect(posted(calls, channelId)[0]).toMatchObject({
			components: [
				{ components: [{ custom_id: "agent:stop", label: "止める" }] },
			],
		});
	});

	it("本人以外の発言は消し、その人をメンションして知らせる", async () => {
		const owner = await newUser("anthropic");
		const channelId = "62102";
		const stub = await startedChannel(channelId, owner.id);
		const calls = mockApis([]);

		await stub.receive({
			id: "77",
			authorId: "200",
			fromBot: false,
			content: "のぞき見",
			mentions: [],
		});

		expect(
			calls.some(
				(call) =>
					call.method === "DELETE" &&
					call.url.pathname === `/api/v10/channels/${channelId}/messages/77`,
			),
		).toBe(true);
		expect(posted(calls, channelId)).toEqual([
			{ content: othersNotice("200"), allowed_mentions: { users: ["200"] } },
		]);
		expect(
			calls.some((call) => call.url.hostname === "api.anthropic.com"),
		).toBe(false);
	});
});
