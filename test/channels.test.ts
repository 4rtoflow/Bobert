import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
	type ChannelInfo,
	type GuildRoles,
	isSharedChannel,
	toChannelInfo,
} from "../src/discord/channels";
import { ChannelType } from "../src/discord/constants";
import { channelSyncJobs } from "../src/gateway/channels";
import {
	applyChannelSync,
	type ChannelDeps,
	resolveSharedChannels,
} from "../src/queue/channels";
import type { ChannelSyncJob } from "../src/queue/messages";
import { fromDiscord } from "../src/respond/history";
import { loadChannels, loadGuildRoles } from "../src/store/channels";
import { claimImportTargets, getChannelImport } from "../src/store/imports";
import { saveMessages } from "../src/store/messages";
import { ALICE, BOT, discordMessage } from "./fixtures";
import {
	BOT_ROLE,
	EVERYONE_CAN_READ,
	hiddenFromEveryone,
	shownToBotRole,
	testGuildRoles,
	VIEW_CHANNEL,
} from "./helpers";

const ADMINISTRATOR = String(1n << 3n);

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

describe("共有チャンネルの判定", () => {
	const guildId = "100";
	const guild = testGuildRoles(guildId);
	const shared = (target: ChannelInfo, roles: GuildRoles = guild) =>
		isSharedChannel(target, undefined, roles, BOT.id);

	it("@everyoneが見られるチャンネルは、Botも見られるので共有する", () => {
		expect(shared(channel("1", guildId))).toBe(true);
	});

	it("@everyoneに見せないチャンネルも、Botのロールに見せていれば共有する", () => {
		expect(
			shared(channel("1", guildId, { overwrites: shownToBotRole(guildId) })),
		).toBe(true);
	});

	it("@everyoneにもBotのロールにも見せていなければ、共有しない", () => {
		expect(
			shared(
				channel("1", guildId, { overwrites: hiddenFromEveryone(guildId) }),
			),
		).toBe(false);
	});

	it("上書きは、@everyone、Botのロール、Botの順に当てる", () => {
		const roleDeny = { id: BOT_ROLE, type: 0, allow: "0", deny: VIEW_CHANNEL };
		const botAllow = { id: BOT.id, type: 1, allow: VIEW_CHANNEL, deny: "0" };
		const botDeny = { id: BOT.id, type: 1, allow: "0", deny: VIEW_CHANNEL };
		// Botのロールへの拒否は、@everyoneの権限より強い
		expect(shared(channel("1", guildId, { overwrites: [roleDeny] }))).toBe(
			false,
		);
		// Botへの許可は、ロールへの拒否より強い
		expect(
			shared(channel("1", guildId, { overwrites: [roleDeny, botAllow] })),
		).toBe(true);
		expect(shared(channel("1", guildId, { overwrites: [botDeny] }))).toBe(
			false,
		);
		// ほかの人への上書きは関係ない
		expect(
			shared(
				channel("1", guildId, {
					overwrites: [{ ...botDeny, id: ALICE.id }],
				}),
			),
		).toBe(true);
	});

	it("Botのロールの権限で見られれば、@everyoneが見られなくても共有する", () => {
		const roles: GuildRoles = {
			roles: [
				{ id: guildId, permissions: "0" },
				{ id: BOT_ROLE, permissions: VIEW_CHANNEL },
			],
			botRoleIds: [BOT_ROLE],
		};
		expect(shared(channel("1", guildId), roles)).toBe(true);
		expect(shared(channel("1", guildId), { ...roles, botRoleIds: [] })).toBe(
			false,
		);
	});

	it("ロールの一覧にないBotのロール(削除されたもの)への上書きは、数えない", () => {
		const deletedRole = "8888";
		const target = channel("1", guildId, {
			overwrites: [
				...hiddenFromEveryone(guildId),
				{ id: deletedRole, type: 0, allow: VIEW_CHANNEL, deny: "0" },
			],
		});
		expect(
			shared(target, {
				...guild,
				botRoleIds: [...guild.botRoleIds, deletedRole],
			}),
		).toBe(false);
	});

	it("Botが管理者なら、上書きにかかわらず共有する", () => {
		const roles: GuildRoles = {
			roles: [
				{ id: guildId, permissions: EVERYONE_CAN_READ },
				{ id: BOT_ROLE, permissions: ADMINISTRATOR },
			],
			botRoleIds: [BOT_ROLE],
		};
		expect(
			shared(
				channel("1", guildId, { overwrites: hiddenFromEveryone(guildId) }),
				roles,
			),
		).toBe(true);
	});

	it("「メッセージ履歴を読む」は条件にしない", () => {
		const roles: GuildRoles = {
			roles: [{ id: guildId, permissions: VIEW_CHANNEL }],
			botRoleIds: [],
		};
		expect(shared(channel("1", guildId), roles)).toBe(true);
	});

	it("年齢制限のチャンネルは、Botが見られても共有しない", () => {
		expect(shared(channel("1", guildId, { nsfw: true }))).toBe(false);
	});

	it("公開スレッドは親に従う。非公開スレッドは共有しない", () => {
		const open = channel("1", guildId);
		const closed = channel("2", guildId, {
			overwrites: hiddenFromEveryone(guildId),
		});
		const thread = (parentId: string, type: number) =>
			channel("3", guildId, { parentId, type });
		const threadShared = (target: ChannelInfo, parent?: ChannelInfo) =>
			isSharedChannel(target, parent, guild, BOT.id);

		expect(threadShared(thread("1", ChannelType.PublicThread), open)).toBe(
			true,
		);
		expect(threadShared(thread("2", ChannelType.PublicThread), closed)).toBe(
			false,
		);
		expect(threadShared(thread("1", ChannelType.PrivateThread), open)).toBe(
			false,
		);
		// 親が分からなければ、共有しない
		expect(threadShared(thread("1", ChannelType.PublicThread))).toBe(false);
	});

	it("Discordのチャンネルの情報から、権限の上書きを全部読む。スレッドでなければ、親(カテゴリー)は持たない", () => {
		expect(
			toChannelInfo(
				{
					id: "1",
					type: ChannelType.GuildText,
					name: "雑談",
					parent_id: "9",
					permission_overwrites: [
						{ id: "100", type: 0, allow: "0", deny: VIEW_CHANNEL },
						{ id: "555", type: 0, allow: VIEW_CHANNEL, deny: "0" },
						{ id: "666", type: 1, allow: VIEW_CHANNEL, deny: "0" },
					],
				},
				guildId,
			),
		).toEqual({
			channelId: "1",
			guildId,
			parentId: null,
			type: ChannelType.GuildText,
			name: "雑談",
			nsfw: false,
			overwrites: [
				{ id: "100", type: 0, allow: "0", deny: VIEW_CHANNEL },
				{ id: "555", type: 0, allow: VIEW_CHANNEL, deny: "0" },
				{ id: "666", type: 1, allow: VIEW_CHANNEL, deny: "0" },
			],
		});
	});
});

/** 偽物のDiscordとVectorize。fetchedは、Discordに問い合わせたチャンネル、rolesFetchedはロールを問い合わせたサーバー */
function fakeDeps(known: Record<string, ChannelInfo | null> = {}) {
	const deletedVectors: string[] = [];
	const fetched: string[] = [];
	const rolesFetched: string[] = [];
	const deps: ChannelDeps = {
		db: env.DB,
		vectors: {
			deleteByIds: async (ids) => {
				deletedVectors.push(...ids);
			},
		},
		botUserId: BOT.id,
		fetchChannel: async (channelId) => {
			fetched.push(channelId);
			return known[channelId] ?? null;
		},
		fetchGuildRoles: async (guildId) => {
			rolesFetched.push(guildId);
			return testGuildRoles(guildId);
		},
	};
	return { deps, deletedVectors, fetched, rolesFetched };
}

/** サーバーのロールの一覧とBotのロール(testGuildRoles)を含む、記録の仕事 */
function syncWithRoles(
	guildId: string,
	syncedAt: number,
	fields: Partial<ChannelSyncJob> = {},
): ChannelSyncJob {
	const guild = testGuildRoles(guildId);
	return {
		kind: "channels",
		guildId,
		syncedAt,
		roles: guild.roles,
		allRoles: true,
		botRoleIds: guild.botRoleIds,
		...fields,
	};
}

async function storeMessage(id: string, channelId: string, guildId: string) {
	await saveMessages(env.DB, [
		fromDiscord(
			discordMessage(id, ALICE, `発言${id}`, { channel_id: channelId }),
			guildId,
		),
	]);
}

async function storedIds(channelId: string): Promise<string[]> {
	const { results } = await env.DB.prepare(
		"SELECT message_id FROM messages WHERE channel_id = ? ORDER BY message_id",
	)
		.bind(channelId)
		.all<{ message_id: string }>();
	return results.map((row) => row.message_id);
}

async function isShared(channelId: string): Promise<boolean | undefined> {
	return (await loadChannels(env.DB, [channelId])).get(channelId)?.shared;
}

describe("チャンネルの記録", () => {
	it("Botが見られなくなったチャンネルの保存分を、D1とVectorizeから消す。取り込みの記録も消す", async () => {
		const guildId = "200";
		const { deps, deletedVectors } = fakeDeps();
		await applyChannelSync(
			syncWithRoles(guildId, 1, {
				channels: [channel("2001", guildId), channel("2002", guildId)],
			}),
			deps,
		);
		await storeMessage("20010", "2001", guildId);
		await storeMessage("20020", "2002", guildId);
		await claimImportTargets(env.DB, { runId: "r", guildId }, ["2001"]);

		await applyChannelSync(
			{
				kind: "channels",
				guildId,
				syncedAt: 2,
				channels: [
					channel("2001", guildId, {
						overwrites: hiddenFromEveryone(guildId),
					}),
				],
			},
			deps,
		);

		expect(await storedIds("2001")).toEqual([]);
		expect(await storedIds("2002")).toEqual(["20020"]);
		expect(deletedVectors).toEqual(["20010"]);
		expect(await getChannelImport(env.DB, "2001")).toBeNull();
		expect(await isShared("2001")).toBe(false);
	});

	it("@everyoneが見られないチャンネルも、Botのロールが見られれば共有する。Botのロールが外れたら、保存分を消す", async () => {
		const guildId = "205";
		const { deps } = fakeDeps();
		await applyChannelSync(
			syncWithRoles(guildId, 1, {
				channels: [
					channel("2051", guildId, { overwrites: shownToBotRole(guildId) }),
				],
			}),
			deps,
		);
		expect(await isShared("2051")).toBe(true);
		await storeMessage("20510", "2051", guildId);

		// Bot自身のメンバーの変更(GUILD_MEMBER_UPDATE)で、ロールが外れた
		await applyChannelSync(
			{ kind: "channels", guildId, syncedAt: 2, botRoleIds: [] },
			deps,
		);

		expect(await isShared("2051")).toBe(false);
		expect(await storedIds("2051")).toEqual([]);
	});

	it("ロールの権限の変更と削除で、判定し直す", async () => {
		const guildId = "207";
		const { deps } = fakeDeps();
		// @everyoneは見られず、Botのロールの権限で見られる
		await applyChannelSync(
			syncWithRoles(guildId, 1, {
				roles: [
					{ id: guildId, permissions: "0" },
					{ id: BOT_ROLE, permissions: VIEW_CHANNEL },
				],
				channels: [channel("2071", guildId)],
			}),
			deps,
		);
		expect(await isShared("2071")).toBe(true);

		await applyChannelSync(
			{
				kind: "channels",
				guildId,
				syncedAt: 2,
				roles: [{ id: BOT_ROLE, permissions: "0" }],
			},
			deps,
		);
		expect(await isShared("2071")).toBe(false);

		await applyChannelSync(
			{
				kind: "channels",
				guildId,
				syncedAt: 3,
				roles: [{ id: BOT_ROLE, permissions: VIEW_CHANNEL }],
			},
			deps,
		);
		expect(await isShared("2071")).toBe(true);

		await applyChannelSync(
			{ kind: "channels", guildId, syncedAt: 4, deletedRoleIds: [BOT_ROLE] },
			deps,
		);
		expect(await isShared("2071")).toBe(false);
	});

	it("サーバーの全ロールの一覧で置き換えると、一覧にないロールの記録を消す。古い通知では、新しい記録を上書きしない", async () => {
		const guildId = "208";
		const { deps } = fakeDeps();
		await applyChannelSync(
			syncWithRoles(guildId, 5, {
				roles: [
					{ id: guildId, permissions: EVERYONE_CAN_READ },
					{ id: "2081", permissions: "1" },
					{ id: "2082", permissions: "2" },
				],
			}),
			deps,
		);
		// 古い通知
		await applyChannelSync(
			{
				kind: "channels",
				guildId,
				syncedAt: 4,
				roles: [{ id: "2081", permissions: "99" }],
			},
			deps,
		);

		await applyChannelSync(
			syncWithRoles(guildId, 6, {
				roles: [
					{ id: guildId, permissions: EVERYONE_CAN_READ },
					{ id: "2081", permissions: "1" },
				],
			}),
			deps,
		);

		expect((await loadGuildRoles(env.DB, guildId))?.roles).toEqual([
			{ id: guildId, permissions: EVERYONE_CAN_READ },
			{ id: "2081", permissions: "1" },
		]);
	});

	it("古い通知では、新しい記録を上書きしない", async () => {
		const guildId = "210";
		const { deps } = fakeDeps();
		await applyChannelSync(
			syncWithRoles(guildId, 5, {
				channels: [channel("2101", guildId, { name: "新しい名前" })],
			}),
			deps,
		);

		await applyChannelSync(
			{
				kind: "channels",
				guildId,
				syncedAt: 4,
				channels: [channel("2101", guildId, { name: "古い名前" })],
				botRoleIds: [],
			},
			deps,
		);

		expect((await loadChannels(env.DB, ["2101"])).get("2101")?.name).toBe(
			"新しい名前",
		);
		expect((await loadGuildRoles(env.DB, guildId))?.botRoleIds).toEqual([
			BOT_ROLE,
		]);
	});

	it("削除されたチャンネルは、中のスレッドも含めて、記録と保存分を消す", async () => {
		const guildId = "220";
		const { deps } = fakeDeps();
		await applyChannelSync(
			syncWithRoles(guildId, 1, {
				channels: [
					channel("2201", guildId),
					channel("2202", guildId, {
						parentId: "2201",
						type: ChannelType.PublicThread,
					}),
				],
			}),
			deps,
		);
		await storeMessage("22010", "2201", guildId);
		await storeMessage("22020", "2202", guildId);

		await applyChannelSync(
			{ kind: "channels", guildId, syncedAt: 2, deleted: ["2201"] },
			deps,
		);

		expect(await storedIds("2201")).toEqual([]);
		expect(await storedIds("2202")).toEqual([]);
		expect((await loadChannels(env.DB, ["2201", "2202"])).size).toBe(0);
	});

	it("サーバーの全チャンネルの一覧にない記録は、Botが止まっていた間に削除されたとみなす", async () => {
		const guildId = "230";
		const { deps } = fakeDeps();
		await applyChannelSync(
			syncWithRoles(guildId, 1, {
				channels: [channel("2301", guildId), channel("2302", guildId)],
			}),
			deps,
		);
		await storeMessage("23020", "2302", guildId);

		await applyChannelSync(
			{ kind: "channels", guildId, syncedAt: 2, allChannelIds: ["2301"] },
			deps,
		);

		expect(await storedIds("2302")).toEqual([]);
		expect([...(await loadChannels(env.DB, ["2301", "2302"])).keys()]).toEqual([
			"2301",
		]);
	});

	it("記録のないチャンネルの保存分(この仕組みの前に保存したもの)は、Discordで確かめ直す。共有しないか、確かめられなければ消す", async () => {
		const guildId = "240";
		const { deps, fetched } = fakeDeps({
			"2401": channel("2401", guildId),
			"2402": channel("2402", guildId, {
				overwrites: hiddenFromEveryone(guildId),
			}),
			"2403": null,
		});
		await storeMessage("24010", "2401", guildId);
		await storeMessage("24020", "2402", guildId);
		await storeMessage("24030", "2403", guildId);

		await applyChannelSync(
			syncWithRoles(guildId, 1, { channels: [], allChannelIds: [] }),
			deps,
		);

		expect(fetched.sort()).toEqual(["2401", "2402", "2403"]);
		expect(await storedIds("2401")).toEqual(["24010"]);
		expect(await storedIds("2402")).toEqual([]);
		expect(await storedIds("2403")).toEqual([]);
	});

	it("Botのロールが分からないうちは、保存分を消さない", async () => {
		const guildId = "250";
		const { deps } = fakeDeps();
		await storeMessage("25010", "2501", guildId);

		await applyChannelSync(
			{
				kind: "channels",
				guildId,
				syncedAt: 1,
				roles: testGuildRoles(guildId).roles,
				channels: [channel("2501", guildId)],
			},
			deps,
		);

		expect(await storedIds("2501")).toEqual(["25010"]);
		expect(await isShared("2501")).toBe(false);
	});

	it("デプロイの前に入った仕事(@everyoneの権限と、@everyoneへの上書き)も、今の形に直して記録する", async () => {
		const guildId = "255";
		const { deps } = fakeDeps();
		const legacy = {
			kind: "channels",
			guildId,
			syncedAt: 1,
			everyonePermissions: EVERYONE_CAN_READ,
			botRoleIds: [],
			channels: [
				{
					channelId: "2551",
					guildId,
					parentId: null,
					type: ChannelType.GuildText,
					name: "雑談",
					nsfw: false,
					everyoneAllow: null,
					everyoneDeny: VIEW_CHANNEL,
				},
				{
					channelId: "2552",
					guildId,
					parentId: null,
					type: ChannelType.GuildText,
					name: "質問",
					nsfw: false,
					everyoneAllow: null,
					everyoneDeny: null,
				},
			],
		} as unknown as ChannelSyncJob;

		await applyChannelSync(legacy, deps);

		const records = await loadChannels(env.DB, ["2551", "2552"]);
		expect(records.get("2551")?.overwrites).toEqual(
			hiddenFromEveryone(guildId),
		);
		expect(records.get("2551")?.shared).toBe(false);
		expect(records.get("2552")?.overwrites).toEqual([]);
		expect(records.get("2552")?.shared).toBe(true);
	});

	it("保存してよいかを確かめるとき、記録にないスレッドは、親のチャンネルと一緒にDiscordで確かめる。ロールが分からなければ、それも確かめる", async () => {
		const guildId = "260";
		const { deps, fetched, rolesFetched } = fakeDeps({
			"2602": channel("2602", guildId, {
				parentId: "2601",
				type: ChannelType.PublicThread,
			}),
			"2601": channel("2601", guildId),
		});

		const visible = await resolveSharedChannels(
			[{ channelId: "2602", guildId }],
			deps,
		);

		expect(fetched).toEqual(["2602", "2601"]);
		expect(rolesFetched).toEqual([guildId]);
		expect([...visible]).toEqual(["2602"]);
	});
});

describe("Gatewayの通知", () => {
	const guildId = "300";

	it("サーバーの情報(GUILD_CREATE)は、チャンネルとスレッド、ロールの一覧とBotのロール、全チャンネルの一覧にする", () => {
		const jobs = channelSyncJobs(
			"GUILD_CREATE",
			{
				id: guildId,
				roles: [
					{ id: guildId, permissions: EVERYONE_CAN_READ, name: "@everyone" },
					{ id: "999", permissions: "8", name: "管理者" },
				],
				members: [{ user: { id: BOT.id }, roles: ["999"] }],
				channels: [
					{
						id: "3001",
						type: ChannelType.GuildText,
						name: "雑談",
						permission_overwrites: [
							{ id: guildId, type: 0, allow: "0", deny: VIEW_CHANNEL },
						],
					},
				],
				threads: [
					{
						id: "3002",
						type: ChannelType.PublicThread,
						name: "相談",
						parent_id: "3001",
					},
				],
			},
			10,
			BOT.id,
		);

		expect(jobs).toEqual([
			{
				kind: "channels",
				guildId,
				syncedAt: 10,
				channels: [
					channel("3001", guildId, {
						name: "雑談",
						overwrites: hiddenFromEveryone(guildId),
					}),
					channel("3002", guildId, {
						name: "相談",
						type: ChannelType.PublicThread,
						parentId: "3001",
					}),
				],
			},
			{
				kind: "channels",
				guildId,
				syncedAt: 10,
				roles: [
					{ id: guildId, permissions: EVERYONE_CAN_READ },
					{ id: "999", permissions: "8" },
				],
				allRoles: true,
				botRoleIds: ["999"],
				allChannelIds: ["3001"],
			},
		]);
	});

	it("サーバーの情報のチャンネルが多ければ、Queuesの大きさの上限に収まるように分ける", () => {
		const overwrites = Array.from({ length: 30 }, (_, i) => ({
			id: String(400000 + i),
			type: 0,
			allow: VIEW_CHANNEL,
			deny: "0",
		}));
		const channels = Array.from({ length: 300 }, (_, i) => ({
			id: String(310000 + i),
			type: ChannelType.GuildText,
			name: "長い名前のチャンネル".repeat(5),
			permission_overwrites: overwrites,
		}));

		const jobs = channelSyncJobs(
			"GUILD_CREATE",
			{ id: guildId, roles: [], channels },
			1,
			BOT.id,
		);

		expect(jobs.length).toBeGreaterThan(3);
		for (const job of jobs) {
			expect(new TextEncoder().encode(JSON.stringify(job)).length).toBeLessThan(
				128 * 1024,
			);
		}
		expect(jobs.flatMap((job) => job.channels ?? [])).toHaveLength(300);
	});

	it("サーバーの情報にBot自身がいなければ、Botのロールは入れない", () => {
		const jobs = channelSyncJobs(
			"GUILD_CREATE",
			{
				id: guildId,
				roles: [],
				members: [{ user: { id: ALICE.id }, roles: [] }],
			},
			1,
			BOT.id,
		);
		expect(jobs.at(-1)).toEqual({
			kind: "channels",
			guildId,
			syncedAt: 1,
			roles: [],
			allRoles: true,
			allChannelIds: [],
		});
	});

	it("使えないサーバー(障害中)の情報は、使わない", () => {
		expect(
			channelSyncJobs(
				"GUILD_CREATE",
				{ id: guildId, unavailable: true },
				1,
				BOT.id,
			),
		).toEqual([]);
	});

	it("ロールの作成・変更・削除は、どのロールでも記録にする", () => {
		const role = { id: "999", permissions: "0", name: "メンバー" };
		expect(
			channelSyncJobs(
				"GUILD_ROLE_CREATE",
				{ guild_id: guildId, role },
				1,
				BOT.id,
			),
		).toEqual([
			{
				kind: "channels",
				guildId,
				syncedAt: 1,
				roles: [{ id: "999", permissions: "0" }],
			},
		]);
		expect(
			channelSyncJobs(
				"GUILD_ROLE_UPDATE",
				{ guild_id: guildId, role },
				2,
				BOT.id,
			),
		).toEqual([
			{
				kind: "channels",
				guildId,
				syncedAt: 2,
				roles: [{ id: "999", permissions: "0" }],
			},
		]);
		expect(
			channelSyncJobs(
				"GUILD_ROLE_DELETE",
				{ guild_id: guildId, role_id: "999" },
				3,
				BOT.id,
			),
		).toEqual([
			{ kind: "channels", guildId, syncedAt: 3, deletedRoleIds: ["999"] },
		]);
	});

	it("メンバーの変更は、Bot自身のときだけ、Botのロールにする", () => {
		const update = (userId: string) =>
			channelSyncJobs(
				"GUILD_MEMBER_UPDATE",
				{ guild_id: guildId, user: { id: userId }, roles: ["999"] },
				1,
				BOT.id,
			);

		expect(update(BOT.id)).toEqual([
			{ kind: "channels", guildId, syncedAt: 1, botRoleIds: ["999"] },
		]);
		expect(update(ALICE.id)).toEqual([]);
	});

	it("チャンネルとスレッドの削除は、削除の記録にする。メッセージの通知などは使わない", () => {
		expect(
			channelSyncJobs(
				"THREAD_DELETE",
				{ id: "3003", guild_id: guildId },
				1,
				BOT.id,
			),
		).toEqual([{ kind: "channels", guildId, syncedAt: 1, deleted: ["3003"] }]);
		expect(
			channelSyncJobs("TYPING_START", { guild_id: guildId }, 1, BOT.id),
		).toEqual([]);
	});
});
