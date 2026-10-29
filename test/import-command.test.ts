import { env } from "cloudflare:workers";
import type { APIMessage } from "discord-api-types/v10";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelInfo } from "../src/discord/channels";
import {
	ChannelType,
	InteractionResponseType,
	InteractionType,
} from "../src/discord/constants";
import {
	type GuildSnapshot,
	type ImportStartDeps,
	listGuild,
	startImport,
} from "../src/import/start";
import type { ProgressDisplay } from "../src/import/watch";
import { COMMANDS } from "../src/interactions/commands";
import type {
	ImportCommandJob,
	ImportJob,
	QueueMessage,
} from "../src/queue/messages";
import {
	getChannelImport,
	loadImportRun,
	MAX_PARALLEL_IMPORTS,
} from "../src/store/imports";
import { BOT } from "./fixtures";
import {
	BOT_ROLE,
	EVERYONE_CAN_READ,
	fakeIngestDeps,
	guildInteraction,
	hiddenFromEveryone,
	mockFetch,
	sendInteraction,
	shownToBotRole,
	testGuildRoles,
} from "./helpers";

afterEach(() => {
	vi.restoreAllMocks();
});

function channel(
	channelId: string,
	guildId: string,
	extra: Partial<ChannelInfo> = {},
): ChannelInfo {
	return {
		channelId,
		guildId,
		parentId: null,
		type: ChannelType.GuildText,
		name: `channel-${channelId}`,
		nsfw: false,
		overwrites: [],
		...extra,
	};
}

let nextInteraction = 1;

function importJob(guildId: string): ImportCommandJob {
	return {
		kind: "import_command",
		interactionId: String(nextInteraction++),
		interactionToken: "token",
		guildId,
		channelId: "777",
		userId: "100",
		requestedAt: 1_000,
	};
}

/** 偽物のDiscord、Queue、見張り役。表示した文と、入れた仕事と、見張りを頼んだ表示を記録する */
function fakeStart(
	snapshot: GuildSnapshot | (() => Promise<GuildSnapshot>),
	count: number | null = 1234,
) {
	const edits: string[] = [];
	const enqueued: ImportJob[] = [];
	const watched: ProgressDisplay[] = [];
	const counted: string[][] = [];
	const deps: ImportStartDeps = {
		db: env.DB,
		channels: fakeIngestDeps(BOT.id).deps,
		listGuild: typeof snapshot === "function" ? snapshot : async () => snapshot,
		countMessages: async (_, channelIds) => {
			counted.push([...channelIds]);
			return count;
		},
		enqueueImports: async (jobs) => {
			enqueued.push(...jobs);
		},
		editOriginal: async (content) => {
			edits.push(content);
			return {
				id: "9001",
				channel_id: "777",
				content,
			} as APIMessage;
		},
		watch: async (display) => {
			watched.push(display);
		},
	};
	return { deps, edits, enqueued, watched, counted };
}

describe("/importのコマンド", () => {
	it("サーバー管理の権限を持つ人だけが使える", () => {
		const command = COMMANDS.find((item) => item.name === "import");
		expect(command).toMatchObject({
			description:
				"Botが見られるチャンネルの過去のメッセージの取り込みと、進み具合の確認(サーバー管理者用)",
			default_member_permissions: "32",
		});
	});

	it("全員に見える保留の応答を返し、応答用のQueueで取り込みを始める", async () => {
		const sent: QueueMessage[] = [];
		const environment: Env = {
			...env,
			RESPOND_QUEUE: {
				send: async (body: QueueMessage) => {
					sent.push(body);
				},
			} as unknown as Queue,
		};

		const body = await sendInteraction(
			{
				...guildInteraction(InteractionType.ApplicationCommand, {
					id: "50",
					name: "import",
					type: 1,
				}),
				channel: { id: "800", type: 0 },
			},
			environment,
		);

		// 実行した人にだけ見えるメッセージは15分までしか書き換えられないので、全員に見える応答にする
		expect(body).toEqual({
			type: InteractionResponseType.DeferredChannelMessageWithSource,
		});
		expect(sent).toEqual([
			expect.objectContaining({
				kind: "import_command",
				interactionToken: "interaction-token",
				guildId: "900",
				channelId: "800",
				userId: "100",
			}),
		]);
	});
});

describe("/importの始め方", () => {
	it("Botが見られるチャンネルとスレッドを、上限の数まで取り込み始め、保留の応答を進み具合の表示にする", async () => {
		const guildId = "5100";
		const channels = Array.from({ length: MAX_PARALLEL_IMPORTS }, (_, i) =>
			channel(String(51000 + i), guildId),
		);
		// @everyoneは見られないが、Botのロールは見られる
		const membersOnly = channel("51010", guildId, {
			overwrites: shownToBotRole(guildId),
		});
		const closed = channel("51100", guildId, {
			overwrites: hiddenFromEveryone(guildId),
		});
		const adult = channel("51150", guildId, { nsfw: true });
		const category = channel("51200", guildId, {
			type: ChannelType.GuildCategory,
		});
		const thread = channel("51300", guildId, {
			type: ChannelType.PublicThread,
			parentId: "51000",
		});
		const privateThread = channel("51400", guildId, {
			type: ChannelType.PrivateThread,
			parentId: "51000",
		});
		const { deps, edits, enqueued, watched, counted } = fakeStart({
			roles: testGuildRoles(guildId),
			channels: [...channels, membersOnly, closed, adult, category],
			threads: [thread, privateThread],
		});
		const job = importJob(guildId);

		await startImport(job, deps, 5_000);

		// Botが見られないチャンネル、年齢制限のチャンネル、非公開スレッド、カテゴリーは、取り込まない
		expect(counted).toHaveLength(1);
		expect(counted[0]?.sort()).toEqual(
			[...channels.map((item) => item.channelId), "51010", "51300"].sort(),
		);
		expect(enqueued).toHaveLength(MAX_PARALLEL_IMPORTS);
		expect(enqueued[0]).toMatchObject({
			kind: "import",
			guildId,
			before: null,
		});
		expect(edits).toEqual(["取り込み中: 0% (ETA: --:--)"]);
		expect(watched).toEqual([
			{
				runId: `${guildId}-${job.interactionId}`,
				guildId,
				channelId: "777",
				messageId: "9001",
				interactionToken: "token",
				createdAt: 1_000,
				content: "取り込み中: 0% (ETA: --:--)",
			},
		]);
		expect(
			await loadImportRun(env.DB, `${guildId}-${job.interactionId}`),
		).toMatchObject({ estimatedTotal: 1234 });
		expect(await getChannelImport(env.DB, "51100")).toBeNull();
	});

	it("取り込み中に実行されたら、同じ回の進み具合を、新しい表示でも見せる", async () => {
		const guildId = "5200";
		const snapshot = {
			roles: testGuildRoles(guildId),
			channels: [channel("52000", guildId)],
			threads: [],
		};
		const first = fakeStart(snapshot);
		const job = importJob(guildId);
		await startImport(job, first.deps, 5_000);
		const second = fakeStart(snapshot);

		await startImport(importJob(guildId), second.deps, 6_000);

		expect(second.enqueued).toEqual([]);
		expect(second.watched).toEqual([
			expect.objectContaining({ runId: `${guildId}-${job.interactionId}` }),
		]);
	});

	it("すべて取り込み済みなら、0件の完了の表示にする", async () => {
		const guildId = "5300";
		const snapshot = {
			roles: testGuildRoles(guildId),
			channels: [channel("53000", guildId)],
			threads: [],
		};
		await startImport(importJob(guildId), fakeStart(snapshot).deps, 5_000);
		await env.DB.prepare(
			"UPDATE channel_imports SET status = 'done' WHERE channel_id = ?",
		)
			.bind("53000")
			.run();
		const { deps, edits, watched } = fakeStart(snapshot);

		await startImport(importJob(guildId), deps, 6_000);

		expect(edits).toEqual(["取り込み完了: 0件"]);
		expect(watched).toEqual([]);
	});

	it("Botが見られるチャンネルがなければ、そう表示する", async () => {
		const guildId = "5400";
		const { deps, edits } = fakeStart({
			roles: { roles: [{ id: guildId, permissions: "0" }], botRoleIds: [] },
			channels: [channel("54000", guildId)],
			threads: [],
		});

		await startImport(importJob(guildId), deps, 5_000);

		expect(edits).toEqual([
			"Botが見られるチャンネルがないため、取り込むものはありません。",
		]);
	});

	it("件数を見積もれなければ、見積もりなしで始める", async () => {
		const guildId = "5500";
		const job = importJob(guildId);
		const { deps } = fakeStart(
			{
				roles: testGuildRoles(guildId),
				channels: [channel("55000", guildId)],
				threads: [],
			},
			null,
		);

		await startImport(job, deps, 5_000);

		expect(
			await loadImportRun(env.DB, `${guildId}-${job.interactionId}`),
		).toMatchObject({ estimatedTotal: null });
	});

	it("始められなければ、そう表示する", async () => {
		const { deps, edits } = fakeStart(async () => {
			throw new Error("discord unavailable");
		});

		await startImport(importJob("5600"), deps, 5_000);

		expect(edits).toEqual([
			"取り込みを始められませんでした。少し待ってから、もう一度試してください。",
		]);
	});
});

describe("サーバーのチャンネルとスレッドの列挙", () => {
	it("ロールの権限とBotのロールを読む。アーカイブされた公開スレッドは、共有チャンネルの分だけ、続きがある限り読む", async () => {
		const guildId = "5700";
		const archivedCalls: string[] = [];
		mockFetch((call) => {
			const path = call.url.pathname.replace("/api/v10", "");
			if (path === `/guilds/${guildId}/channels`) {
				return Response.json([
					{ id: "57001", type: ChannelType.GuildText, name: "雑談" },
					{
						id: "57002",
						type: ChannelType.GuildText,
						name: "運営",
						permission_overwrites: hiddenFromEveryone(guildId),
					},
					{
						id: "57003",
						type: ChannelType.GuildText,
						name: "メンバー",
						permission_overwrites: shownToBotRole(guildId),
					},
				]);
			}
			if (path === `/guilds/${guildId}/roles`) {
				return Response.json([
					{ id: guildId, permissions: EVERYONE_CAN_READ },
					{ id: BOT_ROLE, permissions: "0" },
				]);
			}
			if (path === `/guilds/${guildId}/members/${BOT.id}`) {
				return Response.json({ user: BOT, roles: [BOT_ROLE] });
			}
			if (path === `/guilds/${guildId}/threads/active`) {
				return Response.json({ threads: [], members: [] });
			}
			const archived = path.match(
				/^\/channels\/(\d+)\/threads\/archived\/public$/,
			);
			if (archived) {
				const parentId = archived[1] ?? "";
				const before = call.url.searchParams.get("before");
				archivedCalls.push(`${parentId}:${before ?? ""}`);
				return Response.json(
					before === null
						? {
								threads: [
									{
										id: `${parentId}0`,
										type: ChannelType.PublicThread,
										name: "古い相談",
										parent_id: parentId,
										thread_metadata: {
											archive_timestamp: "2026-10-01T00:00:00.000Z",
										},
									},
								],
								has_more: true,
							}
						: { threads: [], has_more: false },
				);
			}
			return new Response(null, { status: 500 });
		});

		const snapshot = await listGuild("token", guildId, BOT.id);

		// Botが見られない57002の分は読まない
		expect(archivedCalls).toEqual([
			"57001:",
			"57001:2026-10-01T00:00:00.000Z",
			"57003:",
			"57003:2026-10-01T00:00:00.000Z",
		]);
		expect(snapshot.roles).toEqual(testGuildRoles(guildId));
		expect(snapshot.channels.map((item) => item.channelId)).toEqual([
			"57001",
			"57002",
			"57003",
		]);
		expect(snapshot.threads).toEqual([
			channel("570010", guildId, {
				name: "古い相談",
				type: ChannelType.PublicThread,
				parentId: "57001",
			}),
			channel("570030", guildId, {
				name: "古い相談",
				type: ChannelType.PublicThread,
				parentId: "57003",
			}),
		]);
	});
});
