import { env } from "cloudflare:workers";
import type { APIMessage } from "discord-api-types/v10";
import { describe, expect, it } from "vitest";
import { DiscordApiError } from "../src/discord/api";
import {
	type ImportDeps,
	importChannelPage,
	startChannelImport,
} from "../src/queue/import";
import type { ImportJob, QueueMessage } from "../src/queue/messages";
import { claimChannelImport, getChannelImport } from "../src/store/imports";
import { ALICE, BOT, discordMessage } from "./fixtures";
import { fakeIngestDeps } from "./helpers";

const GUILD_ID = "900";

/** チャンネルの過去ログ。IDがfirstIdから続くcount件を、Discordと同じく新しい順に並べる */
function channelHistory(
	channelId: string,
	firstId: number,
	count: number,
): APIMessage[] {
	return Array.from({ length: count }, (_, i) => {
		const id = firstId + count - 1 - i;
		return discordMessage(String(id), ALICE, `発言${id}`, {
			channel_id: channelId,
		});
	});
}

/** 偽物のDiscordとQueue。続きの仕事を記録する */
function fakeImport(listMessages: ImportDeps["listMessages"]) {
	const { deps: ingest, embedded } = fakeIngestDeps(BOT.id);
	const continued: { job: ImportJob; delaySeconds: number }[] = [];
	const deps: ImportDeps = {
		...ingest,
		listMessages,
		continueImport: async (job, delaySeconds) => {
			continued.push({ job, delaySeconds });
		},
	};
	return { deps, continued, embedded };
}

function importJob(channelId: string, before: string | null): ImportJob {
	return { kind: "import", channelId, guildId: GUILD_ID, before };
}

describe("過去ログの取り込み", () => {
	it("1回分(100件)を読んで保存し、続きの仕事を間を空けて入れる", async () => {
		const channelId = "7001";
		await claimChannelImport(env.DB, channelId);
		const page = channelHistory(channelId, 20000, 100);
		const requested: (string | null)[] = [];
		const { deps, continued, embedded } = fakeImport(async (_, before) => {
			requested.push(before);
			return page;
		});

		await importChannelPage(importJob(channelId, null), deps);

		expect(requested).toEqual([null]);
		expect(embedded).toHaveLength(100);
		const row = await env.DB.prepare(
			"SELECT guild_id, channel_id FROM messages WHERE message_id = ?",
		)
			.bind("20050")
			.first();
		expect(row).toEqual({ guild_id: GUILD_ID, channel_id: channelId });
		// 続きは、いちばん古いメッセージより前から
		expect(continued).toEqual([
			{ job: importJob(channelId, "20000"), delaySeconds: 2 },
		]);
		expect(await getChannelImport(env.DB, channelId)).toEqual({
			status: "running",
			oldestImportedMessageId: "20000",
		});
	});

	it("100件に満たなければ、最後まで読んだので終える", async () => {
		const channelId = "7002";
		await claimChannelImport(env.DB, channelId);
		const { deps, continued } = fakeImport(async () =>
			channelHistory(channelId, 21000, 3),
		);

		await importChannelPage(importJob(channelId, "21003"), deps);

		expect(continued).toEqual([]);
		expect(await getChannelImport(env.DB, channelId)).toEqual({
			status: "done",
			oldestImportedMessageId: "21000",
		});
	});

	it("参加やピン留めの通知などのシステムのメッセージは、保存しない", async () => {
		const channelId = "7003";
		await claimChannelImport(env.DB, channelId);
		const joined = discordMessage("22001", ALICE, "", {
			channel_id: channelId,
			type: 7 as APIMessage["type"],
		});
		const said = discordMessage("22000", ALICE, "よろしく", {
			channel_id: channelId,
		});
		const { deps, embedded } = fakeImport(async () => [joined, said]);

		await importChannelPage(importJob(channelId, null), deps);

		expect(embedded).toEqual(["よろしく"]);
		const count = await env.DB.prepare(
			"SELECT COUNT(*) AS count FROM messages WHERE message_id = ?",
		)
			.bind("22001")
			.first<number>("count");
		expect(count).toBe(0);
	});

	it("読む権限がなければ、取り込めなかったと記録して終える", async () => {
		const channelId = "7004";
		await claimChannelImport(env.DB, channelId);
		const { deps, continued } = fakeImport(async () => {
			throw new DiscordApiError(403, 50001, "forbidden");
		});

		await importChannelPage(importJob(channelId, null), deps);

		expect(continued).toEqual([]);
		expect(await getChannelImport(env.DB, channelId)).toMatchObject({
			status: "failed",
		});
	});

	it("そのほかの失敗は、やり直しに回す", async () => {
		const channelId = "7005";
		await claimChannelImport(env.DB, channelId);
		const { deps } = fakeImport(async () => {
			throw new DiscordApiError(500, null, "server error");
		});

		await expect(
			importChannelPage(importJob(channelId, null), deps),
		).rejects.toThrow(DiscordApiError);
	});
});

describe("取り込みの始め方", () => {
	function fakeQueue(send: (body: QueueMessage) => Promise<void>) {
		return { send } as unknown as Queue<QueueMessage>;
	}

	it("初めて使われたチャンネルでだけ、取り込みを始める", async () => {
		const sent: QueueMessage[] = [];
		const queue = fakeQueue(async (body) => {
			sent.push(body);
		});

		expect(await startChannelImport(env.DB, queue, "7101", GUILD_ID)).toBe(
			true,
		);
		expect(await startChannelImport(env.DB, queue, "7101", GUILD_ID)).toBe(
			false,
		);

		expect(sent).toEqual([importJob("7101", null)]);
		expect(await getChannelImport(env.DB, "7101")).toMatchObject({
			status: "pending",
		});
	});

	it("仕事を入れられなければ、記録を消して、次に使われたときにやり直す", async () => {
		const queue = fakeQueue(async () => {
			throw new Error("queue unavailable");
		});

		await expect(
			startChannelImport(env.DB, queue, "7201", GUILD_ID),
		).rejects.toThrow();

		expect(await getChannelImport(env.DB, "7201")).toBeNull();
	});
});
