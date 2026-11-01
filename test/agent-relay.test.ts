import Anthropic from "@anthropic-ai/sdk";
import type {
	RESTPatchAPIChannelMessageJSONBody,
	RESTPostAPIChannelMessageJSONBody,
} from "discord-api-types/v10";
import { describe, expect, it, vi } from "vitest";
import {
	type AgentEvent,
	discordUploadLimit,
	type IncomingMessage,
	initialState,
	ownerText,
	pullRequestConfirmation,
	type RelayDeps,
	type RelayGitHub,
	repositoryName,
	SessionRelay,
	type SessionState,
	safeFileName,
	toolOperation,
	withDefaults,
} from "../src/agent/relay";
import {
	APPROVAL_INTRO,
	attachmentTooLarge,
	GITHUB_NOT_LINKED,
	HELD_NOTICE,
	KEY_CANNOT_OPERATE,
	NO_ATTACH_FILES,
	OUTPUT_FILES_LINE,
	othersNotice,
	outputTooLarge,
	PR_CREATE_FAILED,
	PR_NOT_CREATED,
	STOPPED_LINE,
} from "../src/agent/texts";
import { DiscordApiError, type MessageFile } from "../src/discord/api";

const MODEL = { id: "claude-haiku-5-5", label: "Claude Haiku 5.5" };

function newState(): SessionState {
	return initialState({
		channelId: "7001",
		guildId: "900",
		ownerId: "61001",
		sessionId: "sesn_1",
		model: MODEL,
	});
}

/** 投稿・書き換え・削除を記録する、Discordの偽物 */
function fakeDiscord() {
	const posts: RESTPostAPIChannelMessageJSONBody[] = [];
	const edits: { id: string; body: RESTPatchAPIChannelMessageJSONBody }[] = [];
	const removed: string[] = [];
	const files: MessageFile[][] = [];
	let next = 1;
	return {
		posts,
		edits,
		removed,
		files,
		discord: {
			post: async (
				body: RESTPostAPIChannelMessageJSONBody,
				attached?: MessageFile[],
			) => {
				posts.push(body);
				files.push(attached ?? []);
				return `m${next++}`;
			},
			edit: async (id: string, body: RESTPatchAPIChannelMessageJSONBody) => {
				edits.push({ id, body });
			},
			remove: async (id: string) => {
				removed.push(id);
			},
		},
	};
}

/** セッションにイベントを送る、Anthropicのクライアントの偽物 */
function fakeClient(send = vi.fn(async () => ({}))) {
	return {
		send,
		client: {
			beta: { sessions: { events: { send } } },
		} as unknown as Anthropic,
	};
}

/** 本人のGitHubの偽物。既定は、連携していない */
function fakeGitHub(overrides: Partial<RelayGitHub> = {}): RelayGitHub {
	return {
		findRepository: async () => ({ status: "unlinked" }),
		hasBranch: async () => true,
		createPullRequest: async () => ({ status: "unlinked" }),
		accessToken: async () => null,
		...overrides,
	};
}

function relayOf(
	state: SessionState,
	discord: ReturnType<typeof fakeDiscord>["discord"],
	client: Anthropic | null,
	overrides: Partial<RelayDeps> = {},
) {
	const markEnded = vi.fn(async () => {});
	const deps: RelayDeps = {
		discord,
		client: async () => client,
		markEnded,
		fetchAttachment: async () => new Uint8Array([1, 2, 3]),
		uploadLimit: async () => 10 * 1024 * 1024,
		readSkill: async () => null,
		github: fakeGitHub(),
		sleep: async () => {},
		now: () => 1_000,
		...overrides,
	};
	return { relay: new SessionRelay(state, deps), markEnded };
}

let sequence = 0;
/** 処理の時刻が進む、セッションのイベント */
function event(body: Record<string, unknown>): AgentEvent {
	sequence++;
	return {
		id: `sevt_${sequence}`,
		processed_at: `2026-10-31T00:00:${String(sequence).padStart(2, "0")}.000Z`,
		...body,
	} as unknown as AgentEvent;
}

function toolUse(
	name: string,
	input: Record<string, unknown>,
	evaluated_permission: "allow" | "ask" | "deny" = "allow",
): AgentEvent {
	return event({ type: "agent.tool_use", name, input, evaluated_permission });
}

function idle(type: string, eventIds: string[] = []): AgentEvent {
	return event({
		type: "session.status_idle",
		stop_reason:
			type === "requires_action" ? { type, event_ids: eventIds } : { type },
		stop_details: null,
	});
}

/** 本人の発言 */
function ownerMessage(
	content: string,
	attachments: IncomingMessage["attachments"] = [],
): IncomingMessage {
	return {
		id: "1",
		authorId: "61001",
		fromBot: false,
		content,
		mentions: [],
		attachments,
	};
}

const notFound = () =>
	Anthropic.APIError.generate(
		404,
		{ type: "error", error: { type: "not_found_error", message: "x" } },
		"not found",
		new Headers(),
	);

describe("本人の発言", () => {
	it("セッションにメッセージとして送り、動き始めるのを待つ", async () => {
		const state = newState();
		const { discord } = fakeDiscord();
		const { client, send } = fakeClient();
		const { relay } = relayOf(state, discord, client);

		const stream = await relay.receiveOwner({
			id: "1",
			authorId: "61001",
			fromBot: false,
			content: "テストを直して <@200>",
			mentions: [{ id: "200", name: "bob" }],
			attachments: [],
		});

		expect(stream).toBe(true);
		expect(send).toHaveBeenCalledWith("sesn_1", {
			events: [
				{
					type: "user.message",
					content: [{ type: "text", text: "テストを直して @bob" }],
				},
			],
		});
		expect(state.working).toBe(true);
		expect(state.awaitingRun).toBe(true);
	});

	it("許可を待っている間は、送らずに預かり、預かったことを返信で知らせる", async () => {
		const state = newState();
		state.approvals.push({
			eventId: "sevt_x",
			messageId: "m0",
			label: "コマンド",
			value: "`ls`",
		});
		const { discord, posts } = fakeDiscord();
		const { client, send } = fakeClient();
		const { relay } = relayOf(state, discord, client);

		const stream = await relay.receiveOwner({
			id: "1",
			authorId: "61001",
			fromBot: false,
			content: "ついでにREADMEも",
			mentions: [],
			attachments: [],
		});

		expect(stream).toBe(false);
		expect(send).not.toHaveBeenCalled();
		expect(posts).toEqual([
			{
				content: HELD_NOTICE,
				message_reference: { message_id: "1" },
				allowed_mentions: { parse: [], replied_user: false },
			},
		]);
		expect(state.held).toEqual([
			{
				noticeId: "m1",
				message: expect.objectContaining({ content: "ついでにREADMEも" }),
			},
		]);
	});

	it("セッションが見つからなければ(別のワークスペースのキー)、終えたことにして知らせる", async () => {
		const state = newState();
		const { discord, posts } = fakeDiscord();
		const { client } = fakeClient(
			vi.fn(async () => {
				throw notFound();
			}),
		);
		const { relay, markEnded } = relayOf(state, discord, client);

		await relay.receiveOwner({
			id: "1",
			authorId: "61001",
			fromBot: false,
			content: "続けて",
			mentions: [],
			attachments: [],
		});

		expect(state.sessionId).toBeNull();
		expect(markEnded).toHaveBeenCalled();
		expect(posts.at(-1)?.content).toBe(KEY_CANNOT_OPERATE);
	});
});

describe("本人以外の発言", () => {
	it("消して、その人をメンションして知らせ、10秒後に消す予定を残す", async () => {
		const state = newState();
		const { discord, posts, removed } = fakeDiscord();
		const { relay } = relayOf(state, discord, null);

		await relay.receiveOther({
			id: "5",
			authorId: "200",
			fromBot: false,
			content: "こんにちは",
			mentions: [],
			attachments: [],
		});

		expect(removed).toEqual(["5"]);
		expect(posts).toEqual([
			{ content: othersNotice("200"), allowed_mentions: { users: ["200"] } },
		]);
		expect(state.notices).toEqual([{ messageId: "m1", dueAt: 11_000 }]);
	});

	it("BotやWebhookの発言は、消すだけで知らせない", async () => {
		const state = newState();
		const { discord, posts, removed } = fakeDiscord();
		const { relay } = relayOf(state, discord, null);

		await relay.receiveOther({
			id: "6",
			authorId: "300",
			fromBot: true,
			content: "通知",
			mentions: [],
			attachments: [],
		});

		expect(removed).toEqual(["6"]);
		expect(posts).toEqual([]);
	});
});

describe("セッションのイベント", () => {
	it("動き始めたら知らせを出し、道具を使うたびに書き足し、終わったら「止める」ボタンを外す", async () => {
		const state = newState();
		state.working = true;
		const { discord, posts, edits } = fakeDiscord();
		const { relay } = relayOf(state, discord, null);

		await relay.handle(event({ type: "session.status_running" }));
		await relay.handle(toolUse("bash", { command: "npm test" }));
		await relay.handle(toolUse("read", { file_path: "src/index.ts" }));
		await relay.handle(
			event({
				type: "agent.message",
				content: [{ type: "text", text: "テストは通りました。" }],
			}),
		);
		const decision = await relay.handle(idle("end_turn"));

		expect(decision).toBe("close");
		expect(posts[0]?.components?.length).toBe(1);
		expect(edits.map((edit) => edit.body.content)).toEqual([
			"-# コマンド: `npm test`",
			"-# コマンド: `npm test`\n-# 読む: `src/index.ts`",
			"-# コマンド: `npm test`\n-# 読む: `src/index.ts`",
		]);
		expect(posts[1]).toEqual({
			content: "テストは通りました。",
			allowed_mentions: { parse: [] },
		});
		// 最後の書き換えで、ボタンを外す
		expect(edits.at(-1)?.body.components).toEqual([]);
		expect(state.working).toBe(false);
		expect(state.progress).toBeNull();
	});

	it("エージェントが発言した後の道具は、新しい知らせに書き、前の知らせからボタンを外す", async () => {
		const state = newState();
		const { discord, posts, edits } = fakeDiscord();
		const { relay } = relayOf(state, discord, null);

		await relay.handle(event({ type: "session.status_running" }));
		await relay.handle(toolUse("glob", { pattern: "**/*.ts" }));
		await relay.handle(
			event({
				type: "agent.message",
				content: [{ type: "text", text: "見つけました。" }],
			}),
		);
		await relay.handle(toolUse("edit", { file_path: "a.ts" }));

		expect(posts.at(-1)).toMatchObject({ content: "-# 直す: `a.ts`" });
		expect(edits.at(-1)).toEqual({
			id: "m1",
			body: {
				content: "-# ファイルを探す: `**/*.ts`",
				components: [],
				allowed_mentions: { parse: [] },
			},
		});
	});

	it("Anthropic側で断られた道具は、実行しなかったと書く", async () => {
		const state = newState();
		const { discord, posts } = fakeDiscord();
		const { relay } = relayOf(state, discord, null);

		await relay.handle(toolUse("bash", { command: "rm -rf /" }, "deny"));

		expect(posts[0]?.content).toBe(
			"-# 実行しませんでした(危険だと判断されたため): `rm -rf /`",
		);
	});

	it("発言を送ってから動き始めるまでに届いた「止まった」知らせは、前の作業のものとして扱わない", async () => {
		const state = newState();
		state.working = true;
		state.awaitingRun = true;
		const { discord } = fakeDiscord();
		const { relay } = relayOf(state, discord, null);

		expect(await relay.handle(idle("end_turn"))).toBe("continue");
		expect(state.working).toBe(true);
	});

	it("同じイベントは二度扱わない", async () => {
		const state = newState();
		const { discord, posts } = fakeDiscord();
		const { relay } = relayOf(state, discord, null);
		const message = event({
			type: "agent.message",
			content: [{ type: "text", text: "一度だけ" }],
		});

		await relay.handle(message);
		await relay.handle(message);

		expect(posts).toHaveLength(1);
	});

	it("やり直しても失敗したら、理由を添えて作業が止まったと知らせる", async () => {
		const state = newState();
		const { discord, posts } = fakeDiscord();
		const { relay } = relayOf(state, discord, null);

		await relay.handle(
			event({
				type: "session.error",
				error: { type: "billing_error", message: "x", retry_status: {} },
			}),
		);
		await relay.handle(idle("retries_exhausted"));

		expect(posts.at(-1)?.content).toBe(
			"エラーで作業が止まりました。Anthropicの残高が不足しています。Claude Consoleでクレジットを追加してください。",
		);
	});

	it("セッションがエラーで終わったら、終えたことにして、削除ボタン付きで知らせる", async () => {
		const state = newState();
		const { discord, posts } = fakeDiscord();
		const { relay, markEnded } = relayOf(state, discord, null);

		await relay.handle(event({ type: "session.status_terminated" }));

		expect(state.sessionId).toBeNull();
		expect(markEnded).toHaveBeenCalled();
		expect(posts.at(-1)?.content).toBe(
			"セッションがエラーで終わりました。AIの呼び出しでエラーが起きました。少し待ってから、もう一度試してください。",
		);
		expect(posts.at(-1)?.components?.length).toBe(1);
	});

	it("止めたら、知らせに「止めました」と書き足す", async () => {
		const state = newState();
		const { discord, edits } = fakeDiscord();
		const { client } = fakeClient();
		const { relay } = relayOf(state, discord, client);

		await relay.handle(event({ type: "session.status_running" }));
		await relay.handle(toolUse("bash", { command: "sleep 100" }));
		await relay.stop();
		await relay.handle(idle("end_turn"));

		expect(edits.at(-1)?.body.content).toBe(
			`-# コマンド: \`sleep 100\`\n${STOPPED_LINE}`,
		);
	});
});

describe("実行の許可", () => {
	it("判断できなかった道具は、ボタンで本人に許可を求める", async () => {
		const state = newState();
		const { discord, posts } = fakeDiscord();
		const { relay } = relayOf(state, discord, null);
		const ask = toolUse("bash", { command: "git push" }, "ask");

		await relay.handle(ask);
		const decision = await relay.handle(
			idle("requires_action", [(ask as { id: string }).id]),
		);

		expect(posts[0]?.content).toBe(`${APPROVAL_INTRO}\nコマンド: \`git push\``);
		expect(decision).toBe("close");
		expect(state.approvals).toHaveLength(1);
	});

	it("許可したら、セッションに伝えて知らせを書き換え、預かった発言を送る", async () => {
		const state = newState();
		const { discord, edits, removed } = fakeDiscord();
		const { client, send } = fakeClient();
		const { relay } = relayOf(state, discord, client);
		const ask = toolUse("bash", { command: "git push" }, "ask");
		await relay.handle(ask);
		state.held.push({
			noticeId: "m9",
			message: ownerMessage("そのあとテストも"),
		});

		const answered = await relay.answer((ask as { id: string }).id, true);

		expect(answered).toEqual({ result: "ok", stream: true });
		expect(send).toHaveBeenNthCalledWith(1, "sesn_1", {
			events: [
				{
					type: "user.tool_confirmation",
					tool_use_id: (ask as { id: string }).id,
					result: "allow",
				},
			],
		});
		expect(send).toHaveBeenNthCalledWith(2, "sesn_1", {
			events: [
				{
					type: "user.message",
					content: [{ type: "text", text: "そのあとテストも" }],
				},
			],
		});
		expect(edits[0]?.body.content).toBe("許可しました: コマンド `git push`");
		expect(removed).toEqual(["m9"]);
		expect(state.held).toEqual([]);
		expect(state.awaitingRun).toBe(true);
	});

	it("ほかの呼び出しの許可も待っているうちは、流れを受けない", async () => {
		const state = newState();
		const { discord } = fakeDiscord();
		const { client } = fakeClient();
		const { relay } = relayOf(state, discord, client);
		const first = toolUse("bash", { command: "a" }, "ask");
		const second = toolUse("bash", { command: "b" }, "ask");
		await relay.handle(first);
		await relay.handle(second);

		const answered = await relay.answer((first as { id: string }).id, false);

		expect(answered).toEqual({ result: "ok", stream: false });
		expect(state.approvals).toHaveLength(1);
	});

	it("答え終わった許可のボタンは、古いものとして扱う", async () => {
		const state = newState();
		const { discord } = fakeDiscord();
		const { relay } = relayOf(state, discord, null);

		expect(await relay.answer("sevt_none", true)).toEqual({
			result: "stale",
			stream: false,
		});
	});
});

describe("書き方", () => {
	it("道具ごとの名前と、値を作業の様子の形にする", () => {
		expect(
			toolOperation("bash", { command: "npm  test\nnpm run lint" }),
		).toEqual({ label: "コマンド", value: "`npm test npm run lint`" });
		expect(toolOperation("web_search", { query: "Durable Objects" })).toEqual({
			label: "Webで検索",
			value: "Durable Objects",
		});
		expect(toolOperation("bash", { command: "echo `date`" }).value).toBe(
			"`` echo `date` ``",
		);
		expect(toolOperation("bash", { command: "x".repeat(150) }).value).toBe(
			`\`${"x".repeat(100)}…\``,
		);
	});

	it("本人の発言のメンションを、名前にする", () => {
		expect(
			ownerText({
				id: "1",
				authorId: "1",
				fromBot: false,
				content: "<@200> と <@!300> と <@400>",
				mentions: [
					{ id: "200", name: "bob" },
					{ id: "300", name: "carol" },
				],
				attachments: [],
			}),
		).toBe("@bob と @carol と <@400>");
	});
});

/** ファイルを扱う、Anthropicのクライアントの偽物 */
function fakeFileClient(outputs: Record<string, unknown>[] = []) {
	const send = vi.fn(async () => ({}));
	const upload = vi.fn(async () => ({ id: "file_up" }));
	const remove = vi.fn(async () => ({}));
	const add = vi.fn(async () => ({ id: "res_1", file_id: "file_copy" }));
	const download = vi.fn(async () => new Response("hello"));
	const list = vi.fn(async function* () {
		yield* outputs;
	});
	const client = {
		files: { upload, delete: remove, download },
		beta: {
			files: { list },
			sessions: { events: { send }, resources: { add } },
		},
	} as unknown as Anthropic;
	return { client, send, upload, remove, add, download, list };
}

function customToolUse(names: unknown): AgentEvent {
	return event({
		type: "agent.custom_tool_use",
		name: "send_files",
		input: { names },
	});
}

describe("ファイルの受け渡し", () => {
	it("添付ファイルをサンドボックスに置き、置き場所を発言の終わりに書いて送る", async () => {
		const state = newState();
		const { discord } = fakeDiscord();
		const { client, send, upload, add, remove } = fakeFileClient();
		const { relay } = relayOf(state, discord, client);

		await relay.receiveOwner(
			ownerMessage("このCSVを集計して", [
				{
					filename: "data.csv",
					size: 3,
					url: "https://cdn.discordapp.com/data.csv",
					contentType: "text/csv",
				},
			]),
		);

		expect(upload).toHaveBeenCalledTimes(1);
		expect(add).toHaveBeenCalledWith("sesn_1", {
			type: "file",
			file_id: "file_up",
			mount_path: "/1/data.csv",
		});
		// 置いたファイルはセッション用の写しなので、上げた元のファイルは消す
		expect(remove).toHaveBeenCalledWith("file_up");
		expect(send).toHaveBeenCalledWith("sesn_1", {
			events: [
				{
					type: "user.message",
					content: [
						{
							type: "text",
							text: "このCSVを集計して\n\n添付ファイル:\n- /mnt/session/uploads/1/data.csv",
						},
					],
				},
			],
		});
	});

	it("25MBを超える添付ファイルは渡さず、その発言への返信で知らせる", async () => {
		const state = newState();
		const { discord, posts } = fakeDiscord();
		const { client, send, upload } = fakeFileClient();
		const { relay } = relayOf(state, discord, client);

		await relay.receiveOwner(
			ownerMessage("見て", [
				{
					filename: "big.zip",
					size: 26 * 1024 * 1024,
					url: "https://cdn.discordapp.com/big.zip",
					contentType: null,
				},
			]),
		);

		expect(upload).not.toHaveBeenCalled();
		expect(posts).toEqual([
			{
				content: attachmentTooLarge("big.zip"),
				message_reference: { message_id: "1" },
				allowed_mentions: { parse: [], replied_user: false },
			},
		]);
		expect(send).toHaveBeenCalledWith("sesn_1", {
			events: [
				{ type: "user.message", content: [{ type: "text", text: "見て" }] },
			],
		});
	});

	it("send_filesの道具で、置いたファイルをチャンネルに添付し、結果をエージェントに返す", async () => {
		const state = newState();
		const { discord, posts, files } = fakeDiscord();
		const { client, send } = fakeFileClient([
			{
				id: "file_1",
				filename: "report.txt",
				size_bytes: 5,
				mime_type: "text/plain",
				created_at: "2026-10-31T00:00:00Z",
			},
		]);
		const { relay } = relayOf(state, discord, client);
		const call = customToolUse(["/mnt/session/outputs/report.txt"]);

		await relay.handle(call);
		const decision = await relay.handle(
			idle("requires_action", [(call as { id: string }).id]),
		);

		expect(posts).toEqual([
			{ content: OUTPUT_FILES_LINE, allowed_mentions: { parse: [] } },
		]);
		expect(files[0]?.map((file) => file.name)).toEqual(["report.txt"]);
		expect(send).toHaveBeenCalledWith("sesn_1", {
			events: [
				{
					type: "user.custom_tool_result",
					custom_tool_use_id: (call as { id: string }).id,
					content: [
						{ type: "text", text: "チャンネルに出しました: report.txt" },
					],
					is_error: false,
				},
			],
		});
		// 答えた道具だけを待っているので、流れを閉じない
		expect(decision).toBe("continue");
	});

	it("Discordに上げられない大きさのファイルは出さず、名前と大きさを知らせる", async () => {
		const state = newState();
		const { discord, posts } = fakeDiscord();
		const { client, send, download } = fakeFileClient([
			{
				id: "file_2",
				filename: "video.mp4",
				size_bytes: 120 * 1024 * 1024,
				mime_type: "video/mp4",
				created_at: "2026-10-31T00:00:00Z",
			},
		]);
		const { relay } = relayOf(state, discord, client);

		await relay.handle(customToolUse(["video.mp4"]));

		expect(download).not.toHaveBeenCalled();
		expect(posts.map((post) => post.content)).toEqual([
			outputTooLarge("video.mp4", "120MB"),
		]);
		expect(send).toHaveBeenCalledWith(
			"sesn_1",
			expect.objectContaining({
				events: [expect.objectContaining({ is_error: true })],
			}),
		);
	});

	it("ファイルを添付する権限がなければ、権限がないことを知らせる", async () => {
		const state = newState();
		const { discord, posts } = fakeDiscord();
		const post = discord.post;
		discord.post = async (body, attached) => {
			if (attached !== undefined && attached.length > 0) {
				throw new DiscordApiError(403, 50013, "missing permissions");
			}
			return post(body, attached);
		};
		const { client } = fakeFileClient([
			{
				id: "file_1",
				filename: "report.txt",
				size_bytes: 5,
				mime_type: "text/plain",
				created_at: "2026-10-31T00:00:00Z",
			},
		]);
		const { relay } = relayOf(state, discord, client);

		await relay.handle(customToolUse(["report.txt"]));

		expect(posts.map((body) => body.content)).toEqual([NO_ATTACH_FILES]);
	});

	it("置いたファイルが見つからなければ、読み直してから、見つからないとエージェントに返す", async () => {
		const state = newState();
		const { discord, posts } = fakeDiscord();
		const { client, send, list } = fakeFileClient([]);
		const { relay } = relayOf(state, discord, client);

		await relay.handle(customToolUse(["missing.txt"]));

		expect(list).toHaveBeenCalledTimes(5);
		expect(posts).toEqual([]);
		expect(send).toHaveBeenCalledWith("sesn_1", {
			events: [
				expect.objectContaining({
					type: "user.custom_tool_result",
					content: [
						{
							type: "text",
							text: "/mnt/session/outputs/ に見つかりませんでした: missing.txt",
						},
					],
					is_error: true,
				}),
			],
		});
	});

	it("Discordに上げられる大きさは、サーバーのブーストの段階で決まる", () => {
		expect(discordUploadLimit(0)).toBe(10 * 1024 * 1024);
		expect(discordUploadLimit(1)).toBe(10 * 1024 * 1024);
		expect(discordUploadLimit(2)).toBe(50 * 1024 * 1024);
		expect(discordUploadLimit(3)).toBe(100 * 1024 * 1024);
	});

	it("置き場所に使うファイルの名前から、区切りの文字を除く", () => {
		expect(safeFileName(String.raw`a/b\c.txt`)).toBe("a_b_c.txt");
		expect(safeFileName("..")).toBe("file");
		expect(safeFileName("レポート.pdf")).toBe("レポート.pdf");
	});
});

describe("スキル", () => {
	it("read_skillの道具で、スキルの本文を返し、作業の様子に読んだことを書く", async () => {
		const state = newState();
		const { discord, posts } = fakeDiscord();
		const { client, send } = fakeClient();
		const { relay } = relayOf(state, discord, client, {
			readSkill: async (name) =>
				name === "meeting-notes"
					? { name, body: "決まったことと宿題に分けて書く" }
					: null,
		});
		const call = event({
			type: "agent.custom_tool_use",
			name: "read_skill",
			input: { name: "meeting-notes" },
		});

		await relay.handle(call);

		expect(posts[0]?.content).toBe("-# スキルを読む: meeting-notes");
		expect(send).toHaveBeenCalledWith("sesn_1", {
			events: [
				{
					type: "user.custom_tool_result",
					custom_tool_use_id: (call as { id: string }).id,
					content: [
						{
							type: "text",
							text: "スキル「meeting-notes」の本文です。この手順に従ってください。\n\n決まったことと宿題に分けて書く",
						},
					],
					is_error: false,
				},
			],
		});
	});

	it("スキルが消されていたら、ないことをエージェントに返す", async () => {
		const state = newState();
		const { discord } = fakeDiscord();
		const { client, send } = fakeClient();
		const { relay } = relayOf(state, discord, client);

		await relay.handle(
			event({
				type: "agent.custom_tool_use",
				name: "read_skill",
				input: { name: "gone" },
			}),
		);

		expect(send).toHaveBeenCalledWith("sesn_1", {
			events: [
				expect.objectContaining({
					content: [
						{
							type: "text",
							text: "「gone」というスキルはありません。一覧にある名前で指定してください。",
						},
					],
					is_error: true,
				}),
			],
		});
	});
});

/** GitHubのリポジトリを扱う、Anthropicのクライアントの偽物 */
function fakeRepositoryClient() {
	const send = vi.fn(async () => ({}));
	const add = vi.fn(async () => ({
		id: "sesrsc_1",
		type: "github_repository",
		mount_path: "/workspace/hello",
	}));
	const update = vi.fn(async () => ({}));
	const client = {
		beta: { sessions: { events: { send }, resources: { add, update } } },
	} as unknown as Anthropic;
	return { client, send, add, update };
}

/** 本人が許可したリポジトリ */
const HELLO = {
	fullName: "octocat/hello",
	defaultBranch: "main",
	pushedAt: null,
};
const TOKEN = { value: "ghu_token", expiresAt: null, version: 1 };

function githubTool(name: string, input: Record<string, unknown>): AgentEvent {
	return event({ type: "agent.custom_tool_use", name, input });
}

/** セッションに返した、Bobertが受け持つ道具の結果 */
function toolResults(send: ReturnType<typeof vi.fn>) {
	return send.mock.calls.flatMap((call) =>
		(
			call[1] as {
				events: {
					type: string;
					content?: { text: string }[];
					is_error?: boolean;
				}[];
			}
		).events.filter((sent) => sent.type === "user.custom_tool_result"),
	);
}

/** 本人が許可したリポジトリを、いつも見つけるGitHubの偽物 */
function foundGitHub(overrides: Partial<RelayGitHub> = {}): RelayGitHub {
	return fakeGitHub({
		findRepository: async () => ({
			status: "found",
			repository: HELLO,
			token: TOKEN,
		}),
		...overrides,
	});
}

/** /agent で octocat/hello を選んで始めたセッションの状態 */
function connectedState(): SessionState {
	return initialState({
		channelId: "7001",
		guildId: "900",
		ownerId: "61001",
		sessionId: "sesn_1",
		model: MODEL,
		repositories: [
			{
				fullName: "octocat/hello",
				resourceId: "sesrsc_1",
				mountPath: "/workspace/hello",
			},
		],
		repositoryTokenVersion: 1,
	});
}

describe("GitHub", () => {
	it("/agent で選んだリポジトリを、つないだものとして状態に入れて始める", () => {
		const state = connectedState();

		expect(state.repositories).toEqual([
			{
				fullName: "octocat/hello",
				resourceId: "sesrsc_1",
				mountPath: "/workspace/hello",
			},
		]);
		expect(state.repositoryTokenVersion).toBe(1);
		// リポジトリを選ばなければ、何もつないでいない
		expect(newState().repositories).toEqual([]);
		expect(newState().repositoryTokenVersion).toBeNull();
	});

	it("create_pull_requestで、このセッションに取り込んでいないリポジトリには、PRを作らない", async () => {
		const state = connectedState();
		const { discord, posts } = fakeDiscord();
		const { client, send } = fakeRepositoryClient();
		const findRepository = vi.fn(async () => ({
			status: "found" as const,
			repository: HELLO,
			token: TOKEN,
		}));
		const { relay } = relayOf(state, discord, client, {
			github: fakeGitHub({ findRepository }),
		});

		await relay.handle(
			githubTool("create_pull_request", {
				repository: "octocat/other",
				head: "fix",
				title: "直す",
			}),
		);

		expect(findRepository).not.toHaveBeenCalled();
		expect(posts).toEqual([]);
		expect(toolResults(send)).toEqual([
			expect.objectContaining({
				content: [
					{
						type: "text",
						text: "このセッションでPRを作れるのは、取り込んだリポジトリ(octocat/hello)だけです。",
					},
				],
				is_error: true,
			}),
		]);
	});

	it("連携していなければ(GitHubで外されていたら)、連携のボタンを付けて知らせ、PRを作らない", async () => {
		const state = connectedState();
		const { discord, posts } = fakeDiscord();
		const { client, send } = fakeRepositoryClient();
		const { relay } = relayOf(state, discord, client);

		await relay.handle(
			githubTool("create_pull_request", {
				repository: "octocat/hello",
				head: "fix",
				title: "直す",
			}),
		);

		expect(posts.at(-1)).toEqual({
			content: GITHUB_NOT_LINKED,
			components: [
				{
					type: 1,
					components: [
						{
							type: 2,
							style: 1,
							label: "GitHubと連携",
							custom_id: "agent:github",
						},
					],
				},
			],
			allowed_mentions: { parse: [] },
		});
		expect(toolResults(send)[0]?.is_error).toBe(true);
	});

	it("create_pull_requestで、PRの中身を見せて本人に確認を求め、答えるまでセッションには返さない", async () => {
		const state = connectedState();
		const { discord, posts } = fakeDiscord();
		const { client, send } = fakeRepositoryClient();
		const { relay } = relayOf(state, discord, client, {
			github: foundGitHub(),
		});
		const call = githubTool("create_pull_request", {
			repository: "octocat/hello",
			head: "fix/login-error",
			title: "ログインのエラーを直す",
			body: "原因は、トークンの期限切れでした。\n期限が近ければ更新します。",
		});
		const id = (call as { id: string }).id;

		await relay.handle(call);
		const decision = await relay.handle(idle("requires_action", [id]));

		expect(posts[0]).toEqual({
			content: [
				"エージェントが、PRを作ろうとしています。",
				"リポジトリ: octocat/hello",
				"ブランチ: fix/login-error → main",
				"タイトル: ログインのエラーを直す",
				"> 原因は、トークンの期限切れでした。",
				"> 期限が近ければ更新します。",
			].join("\n"),
			components: [
				{
					type: 1,
					components: [
						expect.objectContaining({
							label: "作る",
							custom_id: `agent:pr_create:${id}`,
						}),
						expect.objectContaining({
							label: "作らない",
							custom_id: `agent:pr_cancel:${id}`,
						}),
					],
				},
			],
			allowed_mentions: { parse: [] },
		});
		expect(toolResults(send)).toEqual([]);
		// 確認を待っている間は止まっているので、流れを閉じる
		expect(decision).toBe("close");

		// 確認を待つ間の本人の発言は、預かる
		expect(await relay.receiveOwner(ownerMessage("ついでにREADMEも"))).toBe(
			false,
		);
		expect(posts.at(-1)?.content).toBe(HELD_NOTICE);
	});

	it("「作る」で、本人のトークンでPRを作り、結果をエージェントに返して、確認を書き換え、預かった発言を送る", async () => {
		const state = connectedState();
		const { discord, edits, removed } = fakeDiscord();
		const { client, send } = fakeRepositoryClient();
		const createPullRequest = vi.fn(async () => ({
			status: "created" as const,
			url: "https://github.com/octocat/hello/pull/7",
		}));
		const { relay } = relayOf(state, discord, client, {
			github: foundGitHub({ createPullRequest }),
		});
		const call = githubTool("create_pull_request", {
			repository: "octocat/hello",
			head: "fix",
			base: "develop",
			title: "直す",
		});
		await relay.handle(call);
		state.held.push({ noticeId: "m9", message: ownerMessage("次はテスト") });
		const id = (call as { id: string }).id;

		const answered = await relay.answerPullRequest(id, true);

		expect(answered).toEqual({ result: "ok", stream: true });
		expect(createPullRequest).toHaveBeenCalledWith({
			repository: "octocat/hello",
			head: "fix",
			base: "develop",
			title: "直す",
			body: "",
		});
		expect(toolResults(send)).toEqual([
			{
				type: "user.custom_tool_result",
				custom_tool_use_id: id,
				content: [
					{
						type: "text",
						text: "PRを作りました: https://github.com/octocat/hello/pull/7",
					},
				],
				is_error: false,
			},
		]);
		expect(edits.at(-1)).toEqual({
			id: "m1",
			body: {
				content: "PRを作りました: <https://github.com/octocat/hello/pull/7>",
				components: [],
				allowed_mentions: { parse: [] },
			},
		});
		expect(send).toHaveBeenLastCalledWith("sesn_1", {
			events: [
				{
					type: "user.message",
					content: [{ type: "text", text: "次はテスト" }],
				},
			],
		});
		expect(removed).toEqual(["m9"]);
		expect(state.pullRequests).toEqual([]);
		expect(state.awaitingRun).toBe(true);
	});

	it("「作らない」で、PRを作らず、作らなかったことをエージェントに返す", async () => {
		const state = connectedState();
		const { discord, edits } = fakeDiscord();
		const { client, send } = fakeRepositoryClient();
		const createPullRequest = vi.fn();
		const { relay } = relayOf(state, discord, client, {
			github: foundGitHub({ createPullRequest }),
		});
		const call = githubTool("create_pull_request", {
			repository: "octocat/hello",
			head: "fix",
			title: "直す",
		});
		await relay.handle(call);

		const answered = await relay.answerPullRequest(
			(call as { id: string }).id,
			false,
		);

		expect(answered).toEqual({ result: "ok", stream: true });
		expect(createPullRequest).not.toHaveBeenCalled();
		expect(toolResults(send)).toEqual([
			expect.objectContaining({
				content: [
					{ type: "text", text: "利用者が、PRを作らないことを選びました。" },
				],
				is_error: true,
			}),
		]);
		expect(edits.at(-1)?.body.content).toBe(PR_NOT_CREATED);
	});

	it("GitHubに断られたら、理由をエージェントに返し、確認を書き換える", async () => {
		const state = connectedState();
		const { discord, edits } = fakeDiscord();
		const { client, send } = fakeRepositoryClient();
		const { relay } = relayOf(state, discord, client, {
			github: foundGitHub({
				createPullRequest: async () => ({
					status: "failed",
					reason:
						"Validation Failed: A pull request already exists for octocat:fix.",
				}),
			}),
		});
		const call = githubTool("create_pull_request", {
			repository: "octocat/hello",
			head: "fix",
			title: "直す",
		});
		await relay.handle(call);

		await relay.answerPullRequest((call as { id: string }).id, true);

		expect(toolResults(send)[0]).toMatchObject({
			content: [
				{
					type: "text",
					text: "GitHubに断られて、PRを作れませんでした: Validation Failed: A pull request already exists for octocat:fix.",
				},
			],
			is_error: true,
		});
		expect(edits.at(-1)?.body.content).toBe(PR_CREATE_FAILED);
	});

	it("結果をエージェントに伝えられなかったら、押し直しても、PRを作り直さない", async () => {
		const state = connectedState();
		const { discord } = fakeDiscord();
		const send = vi
			.fn()
			.mockRejectedValueOnce(new Error("network"))
			.mockResolvedValue({});
		const client = {
			beta: { sessions: { events: { send } } },
		} as unknown as Anthropic;
		const createPullRequest = vi.fn(async () => ({
			status: "created" as const,
			url: "https://github.com/octocat/hello/pull/8",
		}));
		const { relay } = relayOf(state, discord, client, {
			github: foundGitHub({ createPullRequest }),
		});
		const call = githubTool("create_pull_request", {
			repository: "octocat/hello",
			head: "fix",
			title: "直す",
		});
		await relay.handle(call);
		const id = (call as { id: string }).id;

		expect(await relay.answerPullRequest(id, true)).toEqual({
			result: "failed",
			stream: false,
		});
		// 押し直し(「作らない」を押しても、作ったことを伝える)
		expect(await relay.answerPullRequest(id, false)).toEqual({
			result: "ok",
			stream: true,
		});
		expect(createPullRequest).toHaveBeenCalledTimes(1);
		expect(toolResults(send).at(-1)?.content).toEqual([
			{
				type: "text",
				text: "PRを作りました: https://github.com/octocat/hello/pull/8",
			},
		]);
	});

	it("pushしていないブランチでは、確認を求めずに、先にpushするようエージェントに返す", async () => {
		const state = connectedState();
		const { discord, posts } = fakeDiscord();
		const { client, send } = fakeRepositoryClient();
		const { relay } = relayOf(state, discord, client, {
			github: foundGitHub({ hasBranch: async () => false }),
		});

		await relay.handle(
			githubTool("create_pull_request", {
				repository: "octocat/hello",
				head: "not-pushed",
				title: "直す",
			}),
		);

		expect(posts).toEqual([]);
		expect(toolResults(send)[0]).toMatchObject({
			content: [
				{
					type: "text",
					text: "octocat/hello に、ブランチ「not-pushed」がありません。先にpushしてから、もう一度呼んでください。",
				},
			],
			is_error: true,
		});
		expect(state.pullRequests).toEqual([]);
	});

	it("セッションを終えたら、PRの確認のボタンも外す", async () => {
		const state = connectedState();
		const { discord, edits } = fakeDiscord();
		const { client } = fakeRepositoryClient();
		const { relay } = relayOf(state, discord, client, {
			github: foundGitHub(),
		});
		await relay.handle(
			githubTool("create_pull_request", {
				repository: "octocat/hello",
				head: "fix",
				title: "直す",
			}),
		);

		await relay.closeAfterEnd();

		expect(edits).toContainEqual({ id: "m1", body: { components: [] } });
		expect(state.pullRequests).toEqual([]);
	});

	it("保存したトークンが入れ替わっていたら、発言を送る前に、つないだリポジトリのトークンも入れ替える", async () => {
		const state = newState();
		state.repositories.push({
			fullName: "octocat/hello",
			resourceId: "sesrsc_1",
			mountPath: "/workspace/hello",
		});
		state.repositoryTokenVersion = 1;
		const { discord } = fakeDiscord();
		const { client, send, update } = fakeRepositoryClient();
		const accessToken = vi.fn(async () => ({
			value: "ghu_new",
			expiresAt: null,
			version: 2,
		}));
		const { relay } = relayOf(state, discord, client, {
			github: fakeGitHub({ accessToken }),
		});

		await relay.receiveOwner(ownerMessage("pushして"));

		expect(accessToken).toHaveBeenCalledWith(3_600_000);
		expect(update).toHaveBeenCalledWith("sesrsc_1", {
			session_id: "sesn_1",
			authorization_token: "ghu_new",
		});
		expect(state.repositoryTokenVersion).toBe(2);
		expect(send).toHaveBeenCalledTimes(1);
	});

	it("トークンが同じなら、入れ替えない", async () => {
		const state = newState();
		state.repositories.push({
			fullName: "octocat/hello",
			resourceId: "sesrsc_1",
			mountPath: "/workspace/hello",
		});
		state.repositoryTokenVersion = 1;
		const { discord } = fakeDiscord();
		const { client, update } = fakeRepositoryClient();
		const { relay } = relayOf(state, discord, client, {
			github: fakeGitHub({ accessToken: async () => TOKEN }),
		});

		await relay.receiveOwner(ownerMessage("続けて"));

		expect(update).not.toHaveBeenCalled();
	});

	it("リポジトリの名前は、owner/repo と、GitHubのURLの形を受け付ける", () => {
		expect(repositoryName("octocat/hello")).toBe("octocat/hello");
		expect(repositoryName(" https://github.com/octocat/hello.git ")).toBe(
			"octocat/hello",
		);
		expect(repositoryName("git@github.com:octocat/hello.git")).toBe(
			"octocat/hello",
		);
		expect(repositoryName("octocat/../etc")).toBeNull();
		expect(repositoryName("octocat/..")).toBeNull();
		expect(repositoryName("hello")).toBeNull();
		expect(repositoryName(42)).toBeNull();
	});

	it("PRの確認には、説明の先頭500文字までを引用する", () => {
		const text = pullRequestConfirmation({
			repository: "octocat/hello",
			head: "fix",
			base: "main",
			title: "直す",
			body: "あ".repeat(600),
		});
		expect(text.split("\n").at(-1)).toBe(`> ${"あ".repeat(500)}…`);
	});

	it("前の版で保存した状態にも、GitHubの項目を補う", () => {
		const {
			repositories: _repositories,
			repositoryTokenVersion: _version,
			pullRequests: _pullRequests,
			...old
		} = newState();
		expect(withDefaults(old)).toMatchObject({
			repositories: [],
			repositoryTokenVersion: null,
			pullRequests: [],
		});
	});
});
