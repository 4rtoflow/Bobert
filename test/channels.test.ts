import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
	type ChannelInfo,
	isPublicChannel,
	toChannelInfo,
} from "../src/discord/channels";
import { ChannelType } from "../src/discord/constants";
import { channelSyncJobs } from "../src/gateway/channels";
import {
	applyChannelSync,
	type ChannelDeps,
	resolvePublicChannels,
} from "../src/queue/channels";
import { fromDiscord } from "../src/respond/history";
import { loadChannels } from "../src/store/channels";
import { claimImportTargets, getChannelImport } from "../src/store/imports";
import { saveMessages } from "../src/store/messages";
import { ALICE, discordMessage } from "./fixtures";
import { EVERYONE_CAN_READ } from "./helpers";

const VIEW_CHANNEL = String(1n << 10n);
const READ_HISTORY = String(1n << 16n);

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
		everyoneAllow: null,
		everyoneDeny: null,
		...extra,
	};
}

describe("公開チャンネルの判定", () => {
	const guildId = "100";

	it("@everyoneが見られて、過去のメッセージも読めるチャンネルは公開", () => {
		expect(
			isPublicChannel(channel("1", guildId), undefined, EVERYONE_CAN_READ),
		).toBe(true);
	});

	it("@everyoneへの上書きで「チャンネルを見る」が拒否されていれば、権限付き", () => {
		const closed = channel("1", guildId, { everyoneDeny: VIEW_CHANNEL });
		expect(isPublicChannel(closed, undefined, EVERYONE_CAN_READ)).toBe(false);
	});

	it("「メッセージ履歴を読む」がなければ、権限付き。上書きで許可されていれば公開", () => {
		const base = VIEW_CHANNEL;
		expect(isPublicChannel(channel("1", guildId), undefined, base)).toBe(false);
		expect(
			isPublicChannel(
				channel("1", guildId, { everyoneAllow: READ_HISTORY }),
				undefined,
				base,
			),
		).toBe(true);
	});

	it("@everyoneが管理者なら、上書きにかかわらず公開", () => {
		const closed = channel("1", guildId, { everyoneDeny: VIEW_CHANNEL });
		expect(isPublicChannel(closed, undefined, String(1n << 3n))).toBe(true);
	});

	it("年齢制限のチャンネルは、権限付き", () => {
		expect(
			isPublicChannel(
				channel("1", guildId, { nsfw: true }),
				undefined,
				EVERYONE_CAN_READ,
			),
		).toBe(false);
	});

	it("公開スレッドは親に従う。非公開スレッドは権限付き", () => {
		const open = channel("1", guildId);
		const closed = channel("2", guildId, { everyoneDeny: VIEW_CHANNEL });
		const thread = (parentId: string, type: number) =>
			channel("3", guildId, { parentId, type });

		expect(
			isPublicChannel(
				thread("1", ChannelType.PublicThread),
				open,
				EVERYONE_CAN_READ,
			),
		).toBe(true);
		expect(
			isPublicChannel(
				thread("2", ChannelType.PublicThread),
				closed,
				EVERYONE_CAN_READ,
			),
		).toBe(false);
		expect(
			isPublicChannel(
				thread("1", ChannelType.PrivateThread),
				open,
				EVERYONE_CAN_READ,
			),
		).toBe(false);
		// 親が分からなければ、権限付きとみなす
		expect(
			isPublicChannel(
				thread("1", ChannelType.PublicThread),
				undefined,
				EVERYONE_CAN_READ,
			),
		).toBe(false);
	});

	it("Discordのチャンネルの情報から、@everyoneへの上書きを読む。スレッドでなければ、親(カテゴリー)は持たない", () => {
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
			everyoneAllow: "0",
			everyoneDeny: VIEW_CHANNEL,
		});
	});
});

/** 偽物のDiscordとVectorize。fetchedは、Discordに問い合わせたチャンネル */
function fakeDeps(known: Record<string, ChannelInfo | null> = {}) {
	const deletedVectors: string[] = [];
	const fetched: string[] = [];
	const deps: ChannelDeps = {
		db: env.DB,
		vectors: {
			deleteByIds: async (ids) => {
				deletedVectors.push(...ids);
			},
		},
		fetchChannel: async (channelId) => {
			fetched.push(channelId);
			return known[channelId] ?? null;
		},
		fetchEveryonePermissions: async () => EVERYONE_CAN_READ,
	};
	return { deps, deletedVectors, fetched };
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

describe("チャンネルの記録", () => {
	it("権限付きになったチャンネルの保存分を、D1とVectorizeから消す。取り込みの記録も消す", async () => {
		const guildId = "200";
		const { deps, deletedVectors } = fakeDeps();
		await applyChannelSync(
			{
				kind: "channels",
				guildId,
				syncedAt: 1,
				everyonePermissions: EVERYONE_CAN_READ,
				channels: [channel("2001", guildId), channel("2002", guildId)],
			},
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
				channels: [channel("2001", guildId, { everyoneDeny: VIEW_CHANNEL })],
			},
			deps,
		);

		expect(await storedIds("2001")).toEqual([]);
		expect(await storedIds("2002")).toEqual(["20020"]);
		expect(deletedVectors).toEqual(["20010"]);
		expect(await getChannelImport(env.DB, "2001")).toBeNull();
		expect((await loadChannels(env.DB, ["2001"])).get("2001")?.public).toBe(
			false,
		);
	});

	it("古い通知では、新しい記録を上書きしない", async () => {
		const guildId = "210";
		const { deps } = fakeDeps();
		await applyChannelSync(
			{
				kind: "channels",
				guildId,
				syncedAt: 5,
				everyonePermissions: EVERYONE_CAN_READ,
				channels: [channel("2101", guildId, { name: "新しい名前" })],
			},
			deps,
		);

		await applyChannelSync(
			{
				kind: "channels",
				guildId,
				syncedAt: 4,
				channels: [channel("2101", guildId, { name: "古い名前" })],
			},
			deps,
		);

		expect((await loadChannels(env.DB, ["2101"])).get("2101")?.name).toBe(
			"新しい名前",
		);
	});

	it("削除されたチャンネルは、中のスレッドも含めて、記録と保存分を消す", async () => {
		const guildId = "220";
		const { deps } = fakeDeps();
		await applyChannelSync(
			{
				kind: "channels",
				guildId,
				syncedAt: 1,
				everyonePermissions: EVERYONE_CAN_READ,
				channels: [
					channel("2201", guildId),
					channel("2202", guildId, {
						parentId: "2201",
						type: ChannelType.PublicThread,
					}),
				],
			},
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
			{
				kind: "channels",
				guildId,
				syncedAt: 1,
				everyonePermissions: EVERYONE_CAN_READ,
				channels: [channel("2301", guildId), channel("2302", guildId)],
			},
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

	it("記録のないチャンネルの保存分(この仕組みの前に保存したもの)は、Discordで確かめ直す。権限付きか、確かめられなければ消す", async () => {
		const guildId = "240";
		const { deps, fetched } = fakeDeps({
			"2401": channel("2401", guildId),
			"2402": channel("2402", guildId, { everyoneDeny: VIEW_CHANNEL }),
			"2403": null,
		});
		await storeMessage("24010", "2401", guildId);
		await storeMessage("24020", "2402", guildId);
		await storeMessage("24030", "2403", guildId);

		await applyChannelSync(
			{
				kind: "channels",
				guildId,
				syncedAt: 1,
				everyonePermissions: EVERYONE_CAN_READ,
				channels: [],
				allChannelIds: [],
			},
			deps,
		);

		expect(fetched.sort()).toEqual(["2401", "2402", "2403"]);
		expect(await storedIds("2401")).toEqual(["24010"]);
		expect(await storedIds("2402")).toEqual([]);
		expect(await storedIds("2403")).toEqual([]);
	});

	it("@everyoneの権限が分からないうちは、保存分を消さない", async () => {
		const guildId = "250";
		const { deps } = fakeDeps();
		await storeMessage("25010", "2501", guildId);

		await applyChannelSync(
			{
				kind: "channels",
				guildId,
				syncedAt: 1,
				channels: [channel("2501", guildId)],
			},
			deps,
		);

		expect(await storedIds("2501")).toEqual(["25010"]);
	});

	it("保存してよいかを確かめるとき、記録にないスレッドは、親のチャンネルと一緒にDiscordで確かめる", async () => {
		const guildId = "260";
		const { deps, fetched } = fakeDeps({
			"2602": channel("2602", guildId, {
				parentId: "2601",
				type: ChannelType.PublicThread,
			}),
			"2601": channel("2601", guildId),
		});

		const visible = await resolvePublicChannels(
			[{ channelId: "2602", guildId }],
			deps,
		);

		expect(fetched).toEqual(["2602", "2601"]);
		expect([...visible]).toEqual(["2602"]);
	});
});

describe("Gatewayの通知", () => {
	const guildId = "300";

	it("サーバーの情報(GUILD_CREATE)は、チャンネルとスレッド、@everyoneの権限、全チャンネルの一覧にする", () => {
		const jobs = channelSyncJobs(
			"GUILD_CREATE",
			{
				id: guildId,
				roles: [
					{ id: guildId, permissions: EVERYONE_CAN_READ },
					{ id: "999", permissions: "8" },
				],
				channels: [{ id: "3001", type: ChannelType.GuildText, name: "雑談" }],
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
		);

		expect(jobs).toEqual([
			{
				kind: "channels",
				guildId,
				syncedAt: 10,
				channels: [
					channel("3001", guildId, { name: "雑談" }),
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
				everyonePermissions: EVERYONE_CAN_READ,
				allChannelIds: ["3001"],
			},
		]);
	});

	it("使えないサーバー(障害中)の情報は、使わない", () => {
		expect(
			channelSyncJobs("GUILD_CREATE", { id: guildId, unavailable: true }, 1),
		).toEqual([]);
	});

	it("ロールの変更は、@everyoneのロールのときだけ使う", () => {
		const update = (roleId: string) =>
			channelSyncJobs(
				"GUILD_ROLE_UPDATE",
				{ guild_id: guildId, role: { id: roleId, permissions: "0" } },
				1,
			);

		expect(update(guildId)).toEqual([
			{ kind: "channels", guildId, syncedAt: 1, everyonePermissions: "0" },
		]);
		expect(update("999")).toEqual([]);
	});

	it("チャンネルとスレッドの削除は、削除の記録にする。メッセージの通知などは使わない", () => {
		expect(
			channelSyncJobs("THREAD_DELETE", { id: "3003", guild_id: guildId }, 1),
		).toEqual([{ kind: "channels", guildId, syncedAt: 1, deleted: ["3003"] }]);
		expect(channelSyncJobs("TYPING_START", { guild_id: guildId }, 1)).toEqual(
			[],
		);
	});
});
