import { describe, expect, it } from "vitest";
import type {
	Changes,
	Fetch,
	HttpResponse,
	MergedPullRequest,
	ReleaseOptions,
} from "../scripts/whats-new-lib";
import {
	buildWhatsNewMessages,
	CONTINUED_FIELD_NAME,
	classify,
	latestVersion,
	nextPageUrl,
	nextVersion,
	releaseWhatsNew,
} from "../scripts/whats-new-lib";

const API = "https://api.github.com";
const REPO = `${API}/repos/owner/bobert`;
const SHA = "d0d0d0d";
// スレッドに送るWebhook(元のクエリが残ることを確かめる)
const WEBHOOK = "https://discord.com/api/webhooks/1/token?thread_id=2";
const NOW = new Date("2026-11-05T10:00:00Z");

function pull(
	number: number,
	title: string,
	labels: string[] = [],
): MergedPullRequest {
	return { number, title, labels };
}

function json(
	status: number,
	body: unknown,
	headers: Record<string, string> = {},
): HttpResponse {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json", ...headers },
	});
}

describe("版の番号", () => {
	it("版のタグのうち、いちばん新しいものを選ぶ", () => {
		expect(
			latestVersion([
				"v1.9.3",
				"v1.10.0",
				"v1.10.1-rc",
				"v2.0.0",
				"v1.2",
				"release",
			]),
		).toEqual({ major: 10, minor: 0 });
		expect(latestVersion(["release"])).toBeNull();
	});

	it("機能追加があればmajorを上げてminorを0に戻し、軽微な修正だけならminorを上げる", () => {
		const current = { major: 2, minor: 3 };
		const feature = pull(1, "A", ["機能追加"]);
		const fix = pull(2, "B", ["軽微な修正"]);
		expect(nextVersion(current, { features: [feature], fixes: [fix] })).toEqual(
			{ major: 3, minor: 0 },
		);
		// PRがいくつあっても、上げるのは1つだけ
		expect(
			nextVersion(current, {
				features: [feature, pull(3, "C", ["機能追加"])],
				fixes: [],
			}),
		).toEqual({ major: 3, minor: 0 });
		expect(
			nextVersion(current, {
				features: [],
				fixes: [fix, pull(4, "D", ["軽微な修正"])],
			}),
		).toEqual({ major: 2, minor: 4 });
		expect(nextVersion(current, { features: [], fixes: [] })).toBeNull();
	});

	it("両方のラベルがあるPRは機能追加にし、どちらのラベルもないPRは載せない", () => {
		const both = pull(1, "A", ["軽微な修正", "機能追加"]);
		const fix = pull(2, "B", ["軽微な修正", "documentation"]);
		const none = pull(3, "C", ["documentation"]);
		expect(classify([both, fix, none])).toEqual({
			features: [both],
			fixes: [fix],
		});
	});
});

describe("What's Newのメッセージ", () => {
	it("見出しに版を出し、機能追加と軽微な修正に分けて、PRのタイトルを箇条書きにする", () => {
		const changes: Changes = {
			features: [
				pull(10, "クレジットの寄付を実装"),
				pull(11, "右クリックメニューの「Bobertに聞く」を実装"),
			],
			fixes: [pull(12, "AIの返答の先頭に付いた「[時刻] Bobert: 」を外す")],
		};
		expect(buildWhatsNewMessages({ major: 3, minor: 0 }, changes, NOW)).toEqual(
			[
				{
					embeds: [
						{
							title: "What's New v1.3.0",
							fields: [
								{
									name: "機能追加",
									value:
										"- クレジットの寄付を実装\n- 右クリックメニューの「Bobertに聞く」を実装",
								},
								{
									name: "軽微な修正",
									value: "- AIの返答の先頭に付いた「[時刻] Bobert: 」を外す",
								},
							],
							timestamp: "2026-11-05T10:00:00.000Z",
						},
					],
					allowed_mentions: { parse: [] },
				},
			],
		);
	});

	it("PRがない方の項目は出さない", () => {
		const [message, ...rest] = buildWhatsNewMessages(
			{ major: 2, minor: 4 },
			{ features: [], fixes: [pull(1, "直した")] },
			NOW,
		);
		expect(rest).toEqual([]);
		expect(message?.embeds?.[0]?.title).toBe("What's New v1.2.4");
		expect(message?.embeds?.[0]?.fields).toEqual([
			{ name: "軽微な修正", value: "- 直した" },
		]);
	});

	it("項目の上限を超える分は、名前の見えない続きの項目に分ける", () => {
		const titles = Array.from({ length: 12 }, (_, i) =>
			`${i}`.padEnd(200, "あ"),
		);
		const [message, ...rest] = buildWhatsNewMessages(
			{ major: 1, minor: 0 },
			{ features: titles.map((title, i) => pull(i, title)), fixes: [] },
			NOW,
		);
		expect(rest).toEqual([]);
		const fields = message?.embeds?.[0]?.fields ?? [];
		expect(fields.length).toBeGreaterThan(1);
		expect(fields.map((field) => field.name)).toEqual([
			"機能追加",
			...Array(fields.length - 1).fill(CONTINUED_FIELD_NAME),
		]);
		for (const field of fields) {
			expect(field.value.length).toBeLessThanOrEqual(1024);
		}
		// 分けても、すべてのPRが順番どおりに載る
		expect(fields.flatMap((field) => field.value.split("\n"))).toEqual(
			titles.map((title) => `- ${title}`),
		);
	});

	it("1つの埋め込みに収まらなければメッセージを分け、見出しは最初に、日時は最後に付ける", () => {
		const titles = Array.from({ length: 60 }, (_, i) =>
			`${i}`.padEnd(250, "あ"),
		);
		const messages = buildWhatsNewMessages(
			{ major: 1, minor: 0 },
			{ features: titles.map((title, i) => pull(i, title)), fixes: [] },
			NOW,
		);
		expect(messages.length).toBeGreaterThan(1);
		const embeds = messages.map((message) => message.embeds?.[0]);
		for (const embed of embeds) {
			const fields = embed?.fields ?? [];
			expect(fields.length).toBeLessThanOrEqual(25);
			const size =
				(embed?.title ?? "").length +
				fields.reduce(
					(sum, field) => sum + field.name.length + field.value.length,
					0,
				);
			expect(size).toBeLessThanOrEqual(6000);
		}
		expect(embeds.map((embed) => embed?.title)).toEqual([
			"What's New v1.1.0",
			...Array(embeds.length - 1).fill(undefined),
		]);
		expect(embeds.map((embed) => embed?.timestamp)).toEqual([
			...Array(embeds.length - 1).fill(undefined),
			"2026-11-05T10:00:00.000Z",
		]);
		expect(
			embeds.flatMap((embed) =>
				(embed?.fields ?? []).flatMap((field) => field.value.split("\n")),
			),
		).toEqual(titles.map((title) => `- ${title}`));
	});
});

describe("GitHubのAPIのページ", () => {
	it("Linkヘッダーから、次のページのURLを読む", () => {
		// GitHubが実際に返す形(last、next、firstの順)
		const link =
			'<https://api.github.com/repositories/1/compare/a...b?per_page=2&page=7>; rel="last", <https://api.github.com/repositories/1/compare/a...b?per_page=2&page=2>; rel="next", <https://api.github.com/repositories/1/compare/a...b?per_page=2&page=1>; rel="first"';
		expect(nextPageUrl(link)).toBe(
			"https://api.github.com/repositories/1/compare/a...b?per_page=2&page=2",
		);
		expect(
			nextPageUrl('<https://example.com/?page=1>; rel="first"'),
		).toBeNull();
		expect(nextPageUrl(null)).toBeNull();
	});
});

interface PullFixture {
	number: number;
	title: string;
	labels?: string[];
	/** falseなら、まだマージされていないPR */
	merged?: boolean;
	/** マージ先のブランチ(省略するとmain) */
	base?: string;
}

interface FakeRepo {
	/** 今あるタグの名前 */
	tags: string[];
	/** 前の版のタグと、デプロイしたコミットを比べた結果。pagesは、ページごとのコミット */
	compare?: { status: string; pages: string[][] };
	/** コミットごとの、そのコミットを含むPR */
	pulls?: Record<string, PullFixture[]>;
	/** Discordの返事。送るたびに先頭から使い、なくなったら成功を返す */
	discord?: HttpResponse[];
}

interface Call {
	method: string;
	url: string;
	body: unknown;
}

/** GitHubのAPIとDiscordの代わり。呼び出しを順に記録する */
function fakeFetch(repo: FakeRepo): { fetch: Fetch; calls: Call[] } {
	const calls: Call[] = [];
	const fetch: Fetch = async (url, init) => {
		calls.push({
			method: init.method,
			url,
			body: init.body === undefined ? undefined : JSON.parse(init.body),
		});
		if (url.startsWith("https://discord.com/")) {
			return repo.discord?.shift() ?? json(200, { id: "100" });
		}
		const { pathname, searchParams } = new URL(url);
		const path = `${API}${pathname}`;
		if (path === `${REPO}/git/matching-refs/tags/v1.`) {
			return json(
				200,
				repo.tags.map((tag) => ({ ref: `refs/tags/${tag}` })),
			);
		}
		if (path.startsWith(`${REPO}/compare/`)) {
			const pages = repo.compare?.pages ?? [[]];
			const page = Number(searchParams.get("page") ?? "1");
			const headers: Record<string, string> =
				page < pages.length
					? { link: `<${path}?per_page=100&page=${page + 1}>; rel="next"` }
					: {};
			return json(
				200,
				{
					status: repo.compare?.status ?? "ahead",
					commits: (pages[page - 1] ?? []).map((sha) => ({ sha })),
				},
				headers,
			);
		}
		const commit = /\/commits\/(\w+)\/pulls$/.exec(pathname)?.[1];
		if (commit !== undefined) {
			return json(
				200,
				(repo.pulls?.[commit] ?? []).map((pull) => ({
					number: pull.number,
					title: pull.title,
					merged_at: pull.merged === false ? null : "2026-11-05T09:00:00Z",
					base: { ref: pull.base ?? "main" },
					labels: (pull.labels ?? []).map((name) => ({ name })),
				})),
			);
		}
		if (path === `${REPO}/git/refs` && init.method === "POST") {
			return json(201, {});
		}
		return json(404, { message: "Not Found" });
	};
	return { fetch, calls };
}

function run(repo: FakeRepo, overrides: Partial<ReleaseOptions> = {}) {
	const { fetch, calls } = fakeFetch(repo);
	const logs: string[] = [];
	const sleeps: number[] = [];
	const promise = releaseWhatsNew({
		repository: "owner/bobert",
		sha: SHA,
		branch: "main",
		githubApiUrl: API,
		githubToken: "test-token",
		webhookUrl: WEBHOOK,
		dryRun: false,
		now: NOW,
		fetch,
		sleep: async (ms) => {
			sleeps.push(ms);
		},
		log: (line) => {
			logs.push(line);
		},
		...overrides,
	});
	return { promise, calls, logs, sleeps };
}

/** 書き込みの呼び出し(Discordへの送信と、タグの作成) */
function posts(calls: Call[]): Call[] {
	return calls.filter((call) => call.method === "POST");
}

/** 前の版がv1.2.3で、その後に機能追加のPRが1つ入ったリポジトリ */
function labeledRepo(discord: HttpResponse[] = []): FakeRepo {
	return {
		tags: ["v1.2.3"],
		compare: { status: "ahead", pages: [["c1"]] },
		pulls: { c1: [{ number: 10, title: "A", labels: ["機能追加"] }] },
		discord,
	};
}

describe("What's Newの送信と版のタグ", () => {
	it("版のタグがまだなければ、このコミットにv1.0.0を付けるだけで、Discordには送らない", async () => {
		const { promise, calls } = run({ tags: [] });
		await promise;
		expect(posts(calls)).toEqual([
			{
				method: "POST",
				url: `${REPO}/git/refs`,
				body: { ref: "refs/tags/v1.0.0", sha: SHA },
			},
		]);
	});

	it("前の版から入ったPRのうち、ラベルの付いたものを送ってから、次の版のタグを付ける", async () => {
		const { promise, calls } = run({
			tags: ["v1.2.2", "v1.2.3"],
			compare: { status: "ahead", pages: [["c1", "c2", "c3"]] },
			pulls: {
				c1: [{ number: 10, title: "A", labels: ["機能追加"] }],
				// まだマージされていないPRと、ほかのブランチへのPRは載せない
				c2: [
					{ number: 11, title: "B", labels: ["軽微な修正"] },
					{
						number: 20,
						title: "未マージ",
						labels: ["機能追加"],
						merged: false,
					},
					{
						number: 21,
						title: "別のブランチ",
						labels: ["機能追加"],
						base: "develop",
					},
				],
				// 同じPRが複数のコミットに出ても、1回だけ載せる。ラベルのないPRは載せない
				c3: [
					{ number: 10, title: "A", labels: ["機能追加"] },
					{ number: 12, title: "C" },
				],
			},
		});
		await promise;
		// いちばん新しい版のタグと比べる
		expect(
			calls.some((call) =>
				call.url.startsWith(`${REPO}/compare/v1.2.3...${SHA}`),
			),
		).toBe(true);
		const [discord, tag, ...rest] = posts(calls);
		expect(rest).toEqual([]);
		const url = new URL(discord?.url ?? "");
		expect(`${url.origin}${url.pathname}`).toBe(
			"https://discord.com/api/webhooks/1/token",
		);
		expect(url.searchParams.get("thread_id")).toBe("2");
		expect(url.searchParams.get("wait")).toBe("true");
		expect(discord?.body).toEqual({
			embeds: [
				{
					title: "What's New v1.3.0",
					fields: [
						{ name: "機能追加", value: "- A" },
						{ name: "軽微な修正", value: "- B" },
					],
					timestamp: "2026-11-05T10:00:00.000Z",
				},
			],
			allowed_mentions: { parse: [] },
		});
		expect(tag).toEqual({
			method: "POST",
			url: `${REPO}/git/refs`,
			body: { ref: "refs/tags/v1.3.0", sha: SHA },
		});
	});

	it("前の版の後のコミットを、ページをたどってすべて調べる", async () => {
		const { promise, calls } = run({
			tags: ["v1.2.3"],
			compare: { status: "ahead", pages: [["c1"], ["c2"]] },
			pulls: {
				c1: [{ number: 10, title: "A", labels: ["軽微な修正"] }],
				c2: [{ number: 11, title: "B", labels: ["軽微な修正"] }],
			},
		});
		await promise;
		const [discord, tag] = posts(calls);
		expect(discord?.body).toMatchObject({
			embeds: [
				{
					title: "What's New v1.2.4",
					fields: [{ name: "軽微な修正", value: "- A\n- B" }],
				},
			],
		});
		expect(tag?.body).toEqual({ ref: "refs/tags/v1.2.4", sha: SHA });
	});

	it("ラベルの付いたPRがなければ、版を上げず、Discordにも送らない", async () => {
		const { promise, calls } = run({
			tags: ["v1.2.3"],
			compare: { status: "ahead", pages: [["c1"]] },
			pulls: {
				c1: [{ number: 10, title: "CIを直す", labels: ["documentation"] }],
			},
		});
		await promise;
		expect(posts(calls)).toEqual([]);
	});

	it.each(["behind", "identical"])(
		"このコミットが前の版に含まれていれば(%s)、何もしない",
		async (status) => {
			const { promise, calls } = run({
				tags: ["v1.2.3"],
				compare: { status, pages: [[]] },
			});
			await promise;
			expect(posts(calls)).toEqual([]);
			expect(calls.some((call) => call.url.endsWith("/pulls"))).toBe(false);
		},
	);

	it("前の版のコミットがmainの履歴になければ、エラーにする", async () => {
		const { promise, calls } = run({
			tags: ["v1.2.3"],
			compare: { status: "diverged", pages: [["c1"]] },
		});
		await expect(promise).rejects.toThrow("mainの履歴にありません");
		expect(posts(calls)).toEqual([]);
	});

	it("Discordに送れなければ、タグを付けずにエラーにする", async () => {
		const { promise, calls } = run(
			labeledRepo([json(400, { message: "Invalid Form Body" })]),
		);
		await expect(promise).rejects.toThrow(
			"What's NewをDiscordに送れませんでした(400)",
		);
		expect(posts(calls).map((call) => call.url)).not.toContain(
			`${REPO}/git/refs`,
		);
	});

	it("Discordが混雑(429)を返したら、言われた時間だけ待って送り直す", async () => {
		const { promise, calls, sleeps } = run(
			labeledRepo([
				json(429, {
					message: "You are being rate limited.",
					retry_after: 1.5,
					global: false,
				}),
			]),
		);
		await promise;
		expect(sleeps).toEqual([1500]);
		expect(
			posts(calls).map((call) =>
				call.url.startsWith("https://discord.com/") ? "discord" : call.url,
			),
		).toEqual(["discord", "discord", `${REPO}/git/refs`]);
	});

	it("Discord側の障害(5xx)が続けば、3回で諦め、タグを付けない", async () => {
		const { promise, calls, sleeps } = run(
			labeledRepo([json(500, {}), json(502, {}), json(503, {})]),
		);
		await expect(promise).rejects.toThrow("(503)");
		expect(sleeps).toEqual([2000, 4000]);
		expect(posts(calls)).toHaveLength(3);
	});

	it("送る内容があるのに送り先のWebhookがなければ、エラーにする", async () => {
		const { promise, calls } = run(labeledRepo(), { webhookUrl: undefined });
		await expect(promise).rejects.toThrow("WHATS_NEW_WEBHOOK_URL");
		expect(posts(calls)).toEqual([]);
	});

	it("--dry-runでは、送る内容を表示するだけで、送信もタグの作成もしない", async () => {
		const { promise, calls, logs } = run(labeledRepo(), {
			dryRun: true,
			webhookUrl: undefined,
		});
		await promise;
		expect(posts(calls)).toEqual([]);
		expect(logs.join("\n")).toContain("What's New v1.3.0");
	});
});
