import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	completedText,
	formatEta,
	progressText,
	type RunState,
} from "../src/import/progress";
import { editProgress } from "../src/import/start";
import {
	INTERACTION_EDIT_WINDOW_MS,
	type ProgressDisplay,
	refreshDisplays,
	type WatchDeps,
	type WatchState,
} from "../src/import/watch";
import type { ImportJob } from "../src/queue/messages";
import {
	claimImportTargets,
	createImportRun,
	MAX_PARALLEL_IMPORTS,
	STALL_MS,
	startQueuedImports,
} from "../src/store/imports";
import { mockFetch } from "./helpers";

afterEach(() => {
	vi.restoreAllMocks();
});

function state(overrides: Partial<RunState> = {}): RunState {
	return {
		channels: 4,
		finished: 0,
		imported: 0,
		estimatedTotal: 1000,
		...overrides,
	};
}

describe("進み具合の表示", () => {
	it("見積もりがあれば、取り込んだ件数で%を出し、直近の速さからETAを出す", () => {
		const now = 100_000;
		// 直近の1分で、30秒に300件進んだ(1秒あたり10件)。残りは580件
		const samples = [
			{ at: now - 30_000, value: 120 },
			{ at: now, value: 420 },
		];

		expect(progressText(state({ imported: 420 }), samples, now)).toBe(
			"取り込み中: 42% (ETA: 0:58)",
		);
	});

	it("最初はETAが分からないので、--:--にする", () => {
		expect(progressText(state(), [], 0)).toBe("取り込み中: 0% (ETA: --:--)");
	});

	it("見積もりを超えても、完了するまでは99%で止める", () => {
		expect(progressText(state({ imported: 1500 }), [], 0)).toBe(
			"取り込み中: 99% (ETA: --:--)",
		);
	});

	it("見積もりがなければ、終わったチャンネルの数で%を出す", () => {
		expect(
			progressText(state({ estimatedTotal: null, finished: 1 }), [], 0),
		).toBe("取り込み中: 25% (ETA: --:--)");
	});

	it("1分より前の記録は、ETAの計算に使わない。進んでいなければ、--:--にする", () => {
		const now = 200_000;
		const samples = [
			{ at: now - 90_000, value: 0 },
			{ at: now - 10_000, value: 400 },
			{ at: now, value: 400 },
		];

		expect(progressText(state({ imported: 400 }), samples, now)).toBe(
			"取り込み中: 40% (ETA: --:--)",
		);
	});

	it("ETAは分:秒で書き、1時間を超えても分で続ける", () => {
		expect(formatEta(185_000)).toBe("3:05");
		expect(formatEta(4_530_000)).toBe("75:30");
		expect(formatEta(null)).toBe("--:--");
	});

	it("完了の件数は、3桁ごとにカンマを入れる", () => {
		expect(completedText(9123)).toBe("取り込み完了: 9,123件");
		expect(completedText(0)).toBe("取り込み完了: 0件");
	});
});

describe("進み具合の見張り", () => {
	const guildId = "6100";
	let nextRun = 1;

	/** 回を作り、チャンネルを入れて、取り込みを始める */
	async function run(channelIds: string[], now: number): Promise<string> {
		const runId = `watch-${nextRun++}`;
		await createImportRun(env.DB, {
			runId,
			guildId,
			estimatedTotal: null,
			startedAt: now,
		});
		await claimImportTargets(env.DB, { runId, guildId }, channelIds, now);
		await startQueuedImports(env.DB, runId, now);
		return runId;
	}

	function display(runId: string, content = ""): ProgressDisplay {
		return {
			runId,
			guildId,
			channelId: "777",
			messageId: "9001",
			interactionToken: "token",
			createdAt: 0,
			content,
		};
	}

	function fakeWatch(result: "ok" | "gone" | "failed" = "ok") {
		const edits: string[] = [];
		const enqueued: ImportJob[] = [];
		const deps: WatchDeps = {
			db: env.DB,
			edit: async (_, content) => {
				edits.push(content);
				return result;
			},
			enqueueImports: async (jobs) => {
				enqueued.push(...jobs);
			},
		};
		return { deps, edits, enqueued };
	}

	async function finish(channelId: string, count: number) {
		await env.DB.prepare(
			"UPDATE channel_imports SET status = 'done', imported_count = ? WHERE channel_id = ?",
		)
			.bind(count, channelId)
			.run();
	}

	it("文が変わったときだけ書き換え、進みを記録する", async () => {
		const runId = await run(["61001", "61002"], 1_000);
		const { deps, edits } = fakeWatch();
		const first: WatchState = { displays: [display(runId)], samples: {} };

		const second = await refreshDisplays(first, deps, 2_000);
		await refreshDisplays(second, deps, 7_000);

		expect(edits).toEqual(["取り込み中: 0% (ETA: --:--)"]);
		expect(second.samples[runId]).toEqual([{ at: 2_000, value: 0 }]);
	});

	it("回が終わったら、その回で取り込んだ件数で完了の表示にして、見張るのをやめる", async () => {
		const runId = await run(["61101", "61102"], 1_000);
		await finish("61101", 1200);
		await finish("61102", 34);
		const { deps, edits } = fakeWatch();

		const next = await refreshDisplays(
			{ displays: [display(runId)], samples: {} },
			deps,
			2_000,
		);

		expect(edits).toEqual(["取り込み完了: 1,234件"]);
		expect(next).toEqual({ displays: [], samples: {} });
	});

	it("メッセージが消えていたら見張るのをやめ、書き換えに失敗したら前の文のまま次にやり直す", async () => {
		const runId = await run(["61201"], 1_000);

		const gone = await refreshDisplays(
			{ displays: [display(runId)], samples: {} },
			fakeWatch("gone").deps,
			2_000,
		);
		const failed = await refreshDisplays(
			{ displays: [display(runId, "前の文")], samples: {} },
			fakeWatch("failed").deps,
			2_000,
		);

		expect(gone.displays).toEqual([]);
		expect(failed.displays).toEqual([display(runId, "前の文")]);
	});

	it("途中で止まったチャンネルは取り込めなかったとし、空いた分だけ、順番待ちのチャンネルを始める", async () => {
		const channels = Array.from({ length: MAX_PARALLEL_IMPORTS + 1 }, (_, i) =>
			String(61300 + i),
		);
		const runId = await run(channels, 1_000);
		const { deps, enqueued } = fakeWatch();

		await refreshDisplays(
			{ displays: [display(runId)], samples: {} },
			deps,
			1_000 + STALL_MS + 1,
		);

		expect(enqueued).toEqual([
			{
				kind: "import",
				channelId: channels.at(-1),
				guildId,
				before: null,
			},
		]);
	});
});

describe("表示の書き換え", () => {
	const display: ProgressDisplay = {
		runId: "r",
		guildId: "6200",
		channelId: "777",
		messageId: "9001",
		interactionToken: "token",
		createdAt: 0,
		content: "",
	};

	it("実行から14分までは、Interactionのトークンで書き換える。その後は、Botのトークンで書き換える", async () => {
		const calls = mockFetch(() => Response.json({}));

		await editProgress(env, display, "取り込み中: 1% (ETA: --:--)", 60_000);
		await editProgress(
			env,
			display,
			"取り込み中: 2% (ETA: --:--)",
			INTERACTION_EDIT_WINDOW_MS + 1,
		);

		expect(
			calls.map((call) => [
				call.method,
				call.url.pathname,
				call.headers.get("Authorization"),
			]),
		).toEqual([
			[
				"PATCH",
				`/api/v10/webhooks/${env.DISCORD_APPLICATION_ID}/token/messages/@original`,
				null,
			],
			[
				"PATCH",
				"/api/v10/channels/777/messages/9001",
				`Bot ${env.DISCORD_BOT_TOKEN}`,
			],
		]);
	});

	it("メッセージが消えていたら、goneを返す", async () => {
		mockFetch(() => Response.json({ code: 10008 }, { status: 404 }));

		expect(await editProgress(env, display, "x", 60_000)).toBe("gone");
	});
});
