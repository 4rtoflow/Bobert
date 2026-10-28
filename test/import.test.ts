import { env } from "cloudflare:workers";
import type { APIMessage } from "discord-api-types/v10";
import { describe, expect, it } from "vitest";
import { DiscordApiError } from "../src/discord/api";
import { type ImportDeps, importChannelPage } from "../src/queue/import";
import type { ImportJob } from "../src/queue/messages";
import {
	claimImportTargets,
	createImportRun,
	failStalledImports,
	getChannelImport,
	importRunProgress,
	MAX_PARALLEL_IMPORTS,
	STALL_MS,
	startQueuedImports,
} from "../src/store/imports";
import { ALICE, BOT, discordMessage } from "./fixtures";
import { fakeIngestDeps } from "./helpers";

const GUILD_ID = "900";

let nextRun = 1;

/** /importの回を作り、チャンネルを入れて、取り込みを始める(取り込み中にする) */
async function beginImport(...channelIds: string[]): Promise<string> {
	const runId = `run-${nextRun++}`;
	await createImportRun(env.DB, {
		runId,
		guildId: GUILD_ID,
		estimatedTotal: null,
		startedAt: Date.now(),
	});
	await claimImportTargets(env.DB, { runId, guildId: GUILD_ID }, channelIds);
	await startQueuedImports(env.DB, runId);
	return runId;
}

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
function fakeImport(
	listMessages: ImportDeps["listMessages"],
	overrides: Partial<ImportDeps> = {},
) {
	const { deps: ingest, embedded } = fakeIngestDeps(BOT.id);
	const continued: { job: ImportJob; delaySeconds: number }[] = [];
	const deps: ImportDeps = {
		...ingest,
		listMessages,
		continueImport: async (job, delaySeconds) => {
			continued.push({ job, delaySeconds });
		},
		...overrides,
	};
	return { deps, continued, embedded };
}

function importJob(channelId: string, before: string | null): ImportJob {
	return { kind: "import", channelId, guildId: GUILD_ID, before };
}

describe("過去ログの取り込み", () => {
	it("1回分(100件)を読んで保存し、取り込んだ件数を数えて、続きの仕事を間を空けて入れる", async () => {
		const channelId = "7001";
		const runId = await beginImport(channelId);
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
			runId,
		});
		expect(await importRunProgress(env.DB, runId)).toEqual({
			channels: 1,
			finished: 0,
			imported: 100,
		});
	});

	it("100件に満たなければ、最後まで読んだので終える", async () => {
		const channelId = "7002";
		const runId = await beginImport(channelId);
		const { deps, continued } = fakeImport(async () =>
			channelHistory(channelId, 21000, 3),
		);

		await importChannelPage(importJob(channelId, "21003"), deps);

		expect(continued).toEqual([]);
		expect(await getChannelImport(env.DB, channelId)).toEqual({
			status: "done",
			oldestImportedMessageId: "21000",
			runId,
		});
		expect(await importRunProgress(env.DB, runId)).toEqual({
			channels: 1,
			finished: 1,
			imported: 3,
		});
	});

	it("参加やピン留めの通知などのシステムのメッセージは、保存しない", async () => {
		const channelId = "7003";
		await beginImport(channelId);
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
		await beginImport(channelId);
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
		await beginImport(channelId);
		const { deps } = fakeImport(async () => {
			throw new DiscordApiError(500, null, "server error");
		});

		await expect(
			importChannelPage(importJob(channelId, null), deps),
		).rejects.toThrow(DiscordApiError);
	});

	it("公開チャンネルでなくなっていたら、読まずに、取り込めなかったと記録する", async () => {
		const channelId = "7006";
		await beginImport(channelId);
		let listed = false;
		const { deps } = fakeImport(
			async () => {
				listed = true;
				return [];
			},
			{ fetchChannel: async () => null },
		);

		await importChannelPage(importJob(channelId, null), deps);

		expect(listed).toBe(false);
		expect(await getChannelImport(env.DB, channelId)).toMatchObject({
			status: "failed",
		});
	});

	it("チャンネルを終えたら、同じ回の、順番待ちのチャンネルの取り込みを始める", async () => {
		const channels = Array.from({ length: MAX_PARALLEL_IMPORTS + 1 }, (_, i) =>
			String(7100 + i),
		);
		await beginImport(...channels);
		const [first] = channels;
		const waiting = channels.at(-1) ?? "";
		expect(await getChannelImport(env.DB, waiting)).toMatchObject({
			status: "pending",
		});
		const { deps, continued } = fakeImport(async () => []);

		await importChannelPage(importJob(first ?? "", null), deps);

		expect(continued).toEqual([
			{ job: importJob(waiting, null), delaySeconds: 0 },
		]);
		expect(await getChannelImport(env.DB, waiting)).toMatchObject({
			status: "running",
		});
	});
});

describe("/importの回", () => {
	async function newRun(): Promise<string> {
		const runId = `run-${nextRun++}`;
		await createImportRun(env.DB, {
			runId,
			guildId: GUILD_ID,
			estimatedTotal: null,
			startedAt: Date.now(),
		});
		return runId;
	}

	async function setStatus(
		channelId: string,
		status: string,
		updatedAt: number,
	): Promise<void> {
		await env.DB.prepare(
			"UPDATE channel_imports SET status = ?, updated_at = ? WHERE channel_id = ?",
		)
			.bind(status, updatedAt, channelId)
			.run();
	}

	it("まだ取り込んでいないもの、取り込めなかったもの、途中で止まったものを入れる。取り込み済みと取り込み中は入れない", async () => {
		const now = Date.now();
		const before = await newRun();
		await claimImportTargets(
			env.DB,
			{ runId: before, guildId: GUILD_ID },
			["7201", "7202", "7203", "7204"],
			now,
		);
		await setStatus("7201", "done", now);
		await setStatus("7202", "failed", now);
		await setStatus("7203", "running", now - STALL_MS - 1);
		await setStatus("7204", "running", now);
		const runId = await newRun();

		const claimed = await claimImportTargets(
			env.DB,
			{ runId, guildId: GUILD_ID },
			["7201", "7202", "7203", "7204", "7205"],
			now,
		);

		expect(claimed.sort()).toEqual(["7202", "7203", "7205"]);
		expect(await getChannelImport(env.DB, "7204")).toMatchObject({
			status: "running",
			runId: before,
		});
	});

	it("同時に取り込むのは、上限の数まで。二重には始めない", async () => {
		const runId = await newRun();
		const channels = Array.from({ length: MAX_PARALLEL_IMPORTS + 2 }, (_, i) =>
			String(7300 + i),
		);
		await claimImportTargets(env.DB, { runId, guildId: GUILD_ID }, channels);

		const started = await startQueuedImports(env.DB, runId);
		const again = await startQueuedImports(env.DB, runId);

		expect(started).toHaveLength(MAX_PARALLEL_IMPORTS);
		expect(again).toEqual([]);
	});

	it("途中で止まったものは、取り込めなかったとする", async () => {
		const now = Date.now();
		const runId = await newRun();
		await claimImportTargets(env.DB, { runId, guildId: GUILD_ID }, [
			"7401",
			"7402",
		]);
		await setStatus("7401", "running", now - STALL_MS - 1);
		await setStatus("7402", "running", now);

		expect(await failStalledImports(env.DB, runId, now)).toEqual(["7401"]);
		expect(await importRunProgress(env.DB, runId)).toMatchObject({
			channels: 2,
			finished: 1,
		});
	});
});
