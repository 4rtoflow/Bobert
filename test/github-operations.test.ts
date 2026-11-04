import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubApiError } from "../src/github/api";
import {
	type GitHubWriteAction,
	parseGitHubRead,
	parseGitHubWrite,
	prepareGitHubWrite,
	runGitHubRead,
	runGitHubWrite,
} from "../src/github/operations";
import { type FetchCall, mockFetch } from "./helpers";

afterEach(() => {
	vi.restoreAllMocks();
});

const REPOSITORY = {
	fullName: "octocat/hello",
	defaultBranch: "main",
	pushedAt: null,
};

/** 呼び出しの「メソッド パス」。クエリは含める */
function requestLine(call: FetchCall): string {
	return `${call.method} ${call.url.pathname}${call.url.search}`;
}

describe("github_readの入力", () => {
	it("kindごとに、必要な値を読む", () => {
		expect(
			parseGitHubRead({
				kind: "issues",
				state: "all",
				labels: ["bug", 1],
				limit: 500,
			}),
		).toEqual({ kind: "issues", state: "all", labels: ["bug"], limit: 50 });
		expect(parseGitHubRead({ kind: "issues" })).toEqual({
			kind: "issues",
			state: "open",
			labels: [],
			limit: 20,
		});
		expect(parseGitHubRead({ kind: "pull", number: "12" })).toEqual({
			kind: "pull",
			number: 12,
		});
		expect(parseGitHubRead({ kind: "run", run_id: 99 })).toEqual({
			kind: "run",
			runId: 99,
		});
		expect(parseGitHubRead({ kind: "job_logs", job_id: 5 })).toEqual({
			kind: "job_logs",
			jobId: 5,
		});
		expect(parseGitHubRead({ kind: "pages" })).toEqual({ kind: "pages" });
	});

	it("番号がないか、kindが正しくなければ、エージェントに返す文にする", () => {
		expect(parseGitHubRead({ kind: "issue" })).toContain("number");
		expect(parseGitHubRead({ kind: "issue", number: 0 })).toContain("number");
		expect(parseGitHubRead({ kind: "run" })).toContain("run_id");
		expect(parseGitHubRead({ kind: "job_logs" })).toContain("job_id");
		expect(parseGitHubRead({ kind: "x" })).toContain("kind は");
	});
});

describe("github_writeの入力", () => {
	it("actionごとに、必要な値を読む", () => {
		expect(
			parseGitHubWrite({
				action: "issue_create",
				title: "題\nです",
				body: "本文",
			}),
		).toEqual({
			action: "issue_create",
			title: "題 です",
			body: "本文",
			labels: [],
			assignees: [],
		});
		expect(
			parseGitHubWrite({
				action: "issue_close",
				number: 3,
				reason: "not_planned",
			}),
		).toEqual({ action: "issue_close", number: 3, reason: "not_planned" });
		expect(parseGitHubWrite({ action: "pr_merge", number: 3 })).toEqual({
			action: "pr_merge",
			number: 3,
			method: "merge",
			commitTitle: null,
			commitMessage: null,
		});
		expect(
			parseGitHubWrite({
				action: "workflow_dispatch",
				workflow: "ci.yml",
				inputs: { level: 3 },
			}),
		).toEqual({
			action: "workflow_dispatch",
			workflow: "ci.yml",
			ref: null,
			inputs: { level: "3" },
		});
		expect(
			parseGitHubWrite({ action: "run_rerun", run_id: 9, failed_only: true }),
		).toEqual({ action: "run_rerun", runId: 9, failedOnly: true });
		expect(parseGitHubWrite({ action: "pages_build" })).toEqual({
			action: "pages_build",
		});
	});

	it("足りない値や、正しくない値は、エージェントに返す文にする", () => {
		expect(parseGitHubWrite({ action: "issue_create" })).toContain("title");
		expect(parseGitHubWrite({ action: "issue_comment", number: 1 })).toContain(
			"body",
		);
		expect(parseGitHubWrite({ action: "issue_update", number: 1 })).toContain(
			"どれかを指定",
		);
		expect(
			parseGitHubWrite({ action: "pr_review", number: 1, event: "COMMENT" }),
		).toContain("body");
		expect(parseGitHubWrite({ action: "pr_review", number: 1 })).toContain(
			"event",
		);
		expect(
			parseGitHubWrite({ action: "project_add_item", project: 1 }),
		).toContain("number");
		expect(parseGitHubWrite({ action: "workflow_dispatch" })).toContain(
			"workflow",
		);
		expect(parseGitHubWrite({ action: "delete_repo" })).toContain("action は");
	});
});

describe("書く操作を確かめる", () => {
	it("Issueは、番号とタイトルを対象にする。ないときはGitHubApiErrorを投げる", async () => {
		const calls = mockFetch((call) =>
			call.url.pathname.endsWith("/issues/3")
				? Response.json({ title: "ログインできない" })
				: Response.json({ message: "Not Found" }, { status: 404 }),
		);

		const prepared = await prepareGitHubWrite("ghu_t", REPOSITORY, {
			action: "issue_reopen",
			number: 3,
		});
		await expect(
			prepareGitHubWrite("ghu_t", REPOSITORY, {
				action: "issue_reopen",
				number: 4,
			}),
		).rejects.toBeInstanceOf(GitHubApiError);

		expect(prepared).toEqual({
			action: { action: "issue_reopen", number: 3 },
			target: "#3 ログインできない",
			detail: "",
		});
		expect(requestLine(calls[0] as FetchCall)).toBe(
			"GET /repos/octocat/hello/issues/3",
		);
		expect((calls[0] as FetchCall).headers.get("Authorization")).toBe(
			"Bearer ghu_t",
		);
	});

	it("PRは、pullsのタイトルを対象にし、内容に方式を書く", async () => {
		mockFetch(() => Response.json({ title: "直す" }));

		const prepared = await prepareGitHubWrite("t", REPOSITORY, {
			action: "pr_merge",
			number: 7,
			method: "squash",
			commitTitle: null,
			commitMessage: null,
		});

		expect(prepared.target).toBe("#7 直す");
		expect(prepared.detail).toBe("merge_method: squash");
	});

	it("ワークフローの起動は、refを省くと既定のブランチにして、対象に書く", async () => {
		mockFetch(() => Response.json({}));

		const prepared = await prepareGitHubWrite("t", REPOSITORY, {
			action: "workflow_dispatch",
			workflow: "ci.yml",
			ref: null,
			inputs: { level: "3" },
		});

		expect(prepared).toEqual({
			action: {
				action: "workflow_dispatch",
				workflow: "ci.yml",
				ref: "main",
				inputs: { level: "3" },
			},
			target: "ci.yml(main)",
			detail: "inputs: level=3",
		});
	});

	it("実行の再実行は、実行のIDとワークフローの名前を対象にする", async () => {
		mockFetch(() => Response.json({ name: "CI" }));

		const prepared = await prepareGitHubWrite("t", REPOSITORY, {
			action: "run_cancel",
			runId: 55,
		});

		expect(prepared.target).toBe("55 CI");
	});

	it("Projectの項目の更新は、フィールドと値を確かめる", async () => {
		mockFetch(() =>
			Response.json({
				data: {
					repository: {
						projectV2: {
							id: "PVT_1",
							title: "ロードマップ",
							url: "https://github.com/users/octocat/projects/1",
							fields: {
								nodes: [
									{
										id: "F1",
										name: "Status",
										dataType: "SINGLE_SELECT",
										options: [{ id: "O1", name: "Done" }],
									},
									{ id: "F2", name: "Size", dataType: "NUMBER" },
									{},
								],
							},
						},
					},
				},
			}),
		);
		const update = (field: string, value: string): GitHubWriteAction => ({
			action: "project_update_item",
			project: 1,
			itemId: "PVTI_1",
			field,
			value,
		});

		const prepared = await prepareGitHubWrite(
			"t",
			REPOSITORY,
			update("status", "done"),
		);

		expect(prepared.target).toBe("ロードマップ");
		expect(prepared.detail).toBe("status: done");
		await expect(
			prepareGitHubWrite("t", REPOSITORY, update("Nope", "x")),
		).rejects.toMatchObject({
			detail: expect.stringContaining("あるフィールド: Status, Size"),
		});
		await expect(
			prepareGitHubWrite("t", REPOSITORY, update("Status", "Later")),
		).rejects.toMatchObject({
			detail: expect.stringContaining("ある選択肢: Done"),
		});
		await expect(
			prepareGitHubWrite("t", REPOSITORY, update("Size", "大")),
		).rejects.toMatchObject({ detail: expect.stringContaining("数値") });
	});

	it("存在しないProjectは、見つからないと返す", async () => {
		mockFetch(() =>
			Response.json({ data: { repository: { projectV2: null } } }),
		);

		await expect(
			prepareGitHubWrite("t", REPOSITORY, {
				action: "project_add_item",
				project: 9,
				number: 1,
			}),
		).rejects.toMatchObject({ status: 404 });
	});
});

describe("書く操作を行う", () => {
	/** 操作を行い、GitHubに送った呼び出しを返す */
	async function run(
		action: GitHubWriteAction,
		respond: (call: FetchCall) => Response = () =>
			Response.json({ html_url: "https://github.com/octocat/hello/x/1" }),
	) {
		const calls = mockFetch(respond);
		const result = await runGitHubWrite("ghu_t", "octocat/hello", action);
		return { result, calls };
	}

	it("Issueを作る(空のラベルや担当者は送らない)", async () => {
		const { result, calls } = await run({
			action: "issue_create",
			title: "バグ",
			body: "本文",
			labels: [],
			assignees: ["octocat"],
		});

		expect(result).toEqual({ url: "https://github.com/octocat/hello/x/1" });
		expect(requestLine(calls[0] as FetchCall)).toBe(
			"POST /repos/octocat/hello/issues",
		);
		expect((calls[0] as FetchCall).body).toEqual({
			title: "バグ",
			body: "本文",
			assignees: ["octocat"],
		});
	});

	it("コメントは、IssueもPRも、issuesのcommentsに書く", async () => {
		const issue = await run({ action: "issue_comment", number: 2, body: "a" });
		const pull = await run({ action: "pr_comment", number: 3, body: "b" });

		expect(requestLine(issue.calls[0] as FetchCall)).toBe(
			"POST /repos/octocat/hello/issues/2/comments",
		);
		expect(requestLine(pull.calls[0] as FetchCall)).toBe(
			"POST /repos/octocat/hello/issues/3/comments",
		);
	});

	it("Issueを更新する、閉じる、開き直す", async () => {
		const update = await run({
			action: "issue_update",
			number: 2,
			title: "新",
			body: null,
			labels: ["bug"],
			assignees: null,
		});
		const close = await run({
			action: "issue_close",
			number: 2,
			reason: "not_planned",
		});
		const reopen = await run({ action: "issue_reopen", number: 2 });

		expect(requestLine(update.calls[0] as FetchCall)).toBe(
			"PATCH /repos/octocat/hello/issues/2",
		);
		expect((update.calls[0] as FetchCall).body).toEqual({
			title: "新",
			labels: ["bug"],
		});
		expect((close.calls[0] as FetchCall).body).toEqual({
			state: "closed",
			state_reason: "not_planned",
		});
		expect((reopen.calls[0] as FetchCall).body).toEqual({ state: "open" });
	});

	it("PRのレビュー、マージ、閉じる", async () => {
		const review = await run({
			action: "pr_review",
			number: 5,
			event: "APPROVE",
			body: "",
		});
		const merge = await run(
			{
				action: "pr_merge",
				number: 5,
				method: "squash",
				commitTitle: "題",
				commitMessage: null,
			},
			() => Response.json({ merged: true }),
		);
		const close = await run({ action: "pr_close", number: 5 });

		expect(requestLine(review.calls[0] as FetchCall)).toBe(
			"POST /repos/octocat/hello/pulls/5/reviews",
		);
		expect((review.calls[0] as FetchCall).body).toEqual({ event: "APPROVE" });
		expect(requestLine(merge.calls[0] as FetchCall)).toBe(
			"PUT /repos/octocat/hello/pulls/5/merge",
		);
		expect((merge.calls[0] as FetchCall).body).toEqual({
			merge_method: "squash",
			commit_title: "題",
		});
		expect(merge.result).toEqual({
			url: "https://github.com/octocat/hello/pull/5",
		});
		expect((close.calls[0] as FetchCall).body).toEqual({ state: "closed" });
	});

	it("ワークフローの起動、再実行、キャンセル(本文のない応答も扱う)", async () => {
		const dispatch = await run(
			{
				action: "workflow_dispatch",
				workflow: "ci.yml",
				ref: "main",
				inputs: {},
			},
			() => new Response(null, { status: 204 }),
		);
		const rerun = await run(
			{ action: "run_rerun", runId: 8, failedOnly: true },
			() => Response.json({}, { status: 201 }),
		);
		const cancel = await run(
			{ action: "run_cancel", runId: 8 },
			() => new Response("{}", { status: 202 }),
		);

		expect(requestLine(dispatch.calls[0] as FetchCall)).toBe(
			"POST /repos/octocat/hello/actions/workflows/ci.yml/dispatches",
		);
		expect((dispatch.calls[0] as FetchCall).body).toEqual({ ref: "main" });
		expect(dispatch.result).toEqual({
			url: "https://github.com/octocat/hello/actions",
		});
		expect(requestLine(rerun.calls[0] as FetchCall)).toBe(
			"POST /repos/octocat/hello/actions/runs/8/rerun-failed-jobs",
		);
		expect(requestLine(cancel.calls[0] as FetchCall)).toBe(
			"POST /repos/octocat/hello/actions/runs/8/cancel",
		);
		expect(cancel.result).toEqual({
			url: "https://github.com/octocat/hello/actions/runs/8",
		});
	});

	it("Pagesのビルドを始める", async () => {
		const { result, calls } = await run({ action: "pages_build" }, () =>
			Response.json({ status: "queued" }, { status: 201 }),
		);

		expect(requestLine(calls[0] as FetchCall)).toBe(
			"POST /repos/octocat/hello/pages/builds",
		);
		expect(result).toEqual({ url: null });
	});

	it("Projectに項目を足し、項目を更新する", async () => {
		const project = {
			data: {
				repository: {
					projectV2: {
						id: "PVT_1",
						title: "ロードマップ",
						url: "https://github.com/users/octocat/projects/1",
						fields: {
							nodes: [
								{
									id: "F1",
									name: "Status",
									dataType: "SINGLE_SELECT",
									options: [{ id: "O1", name: "Done" }],
								},
							],
						},
					},
				},
			},
		};
		const respond = (call: FetchCall) => {
			if (call.url.pathname === "/graphql") {
				const query = (call.body as { query: string }).query;
				return Response.json(
					query.startsWith("mutation") ? { data: { ok: true } } : project,
				);
			}
			return Response.json({ node_id: "I_1" });
		};

		const add = await run(
			{ action: "project_add_item", project: 1, number: 4 },
			respond,
		);
		const update = await run(
			{
				action: "project_update_item",
				project: 1,
				itemId: "PVTI_1",
				field: "Status",
				value: "Done",
			},
			respond,
		);

		const addMutation = add.calls.at(-1) as FetchCall;
		expect((addMutation.body as { variables: unknown }).variables).toEqual({
			project: "PVT_1",
			content: "I_1",
		});
		const updateMutation = update.calls.at(-1) as FetchCall;
		expect((updateMutation.body as { variables: unknown }).variables).toEqual({
			project: "PVT_1",
			item: "PVTI_1",
			field: "F1",
			value: { singleSelectOptionId: "O1" },
		});
		expect(update.result).toEqual({
			url: "https://github.com/users/octocat/projects/1",
		});
	});

	it("GraphQLがエラーを返したら、GitHubApiErrorにする", async () => {
		mockFetch(() =>
			Response.json({ errors: [{ message: "Could not resolve" }] }),
		);

		await expect(
			runGitHubWrite("t", "octocat/hello", {
				action: "project_add_item",
				project: 1,
				number: 1,
			}),
		).rejects.toMatchObject({ detail: "Could not resolve" });
	});

	it("GitHubが断ったら、理由つきのGitHubApiErrorを投げる", async () => {
		mockFetch(() =>
			Response.json(
				{ message: "Pull Request is not mergeable" },
				{ status: 405 },
			),
		);

		await expect(
			runGitHubWrite("t", "octocat/hello", {
				action: "pr_merge",
				number: 1,
				method: "merge",
				commitTitle: null,
				commitMessage: null,
			}),
		).rejects.toMatchObject({
			status: 405,
			detail: "Pull Request is not mergeable",
		});
	});
});

describe("読む操作", () => {
	it("Issueの一覧は、PRを除いて、要点だけにする", async () => {
		const calls = mockFetch(() =>
			Response.json([
				{
					number: 1,
					title: "バグ",
					state: "open",
					user: { login: "octocat" },
					labels: [{ name: "bug" }],
					assignees: [],
					comments: 2,
					updated_at: "2026-11-01T00:00:00Z",
					html_url: "https://github.com/octocat/hello/issues/1",
					body: "長い本文",
				},
				{ number: 2, title: "PR", pull_request: {} },
			]),
		);

		const text = await runGitHubRead("t", "octocat/hello", {
			kind: "issues",
			state: "open",
			labels: ["bug"],
			limit: 20,
		});

		expect(requestLine(calls[0] as FetchCall)).toBe(
			"GET /repos/octocat/hello/issues?state=open&per_page=100&labels=bug",
		);
		const items = JSON.parse(text) as {
			number: number;
			labels: string[];
			body?: string;
		}[];
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({ number: 1, labels: ["bug"] });
		expect(items[0]).not.toHaveProperty("body");
	});

	it("Issueは、本文とコメントを読む", async () => {
		mockFetch((call) =>
			call.url.pathname.endsWith("/comments")
				? Response.json([
						{ user: { login: "a" }, created_at: "t", body: "コメント" },
					])
				: Response.json({ number: 3, title: "題", body: "本文", labels: [] }),
		);

		const data = JSON.parse(
			await runGitHubRead("t", "octocat/hello", { kind: "issue", number: 3 }),
		);

		expect(data.body).toBe("本文");
		expect(data.comments).toEqual([
			{ user: "a", created_at: "t", body: "コメント" },
		]);
	});

	it("PRは、変更したファイルとレビューも読む", async () => {
		mockFetch((call) => {
			const path = call.url.pathname;
			if (path.endsWith("/files")) {
				return Response.json([
					{
						filename: "a.ts",
						status: "modified",
						additions: 2,
						deletions: 1,
						patch: "...",
					},
				]);
			}
			if (path.endsWith("/reviews")) {
				return Response.json([
					{ user: { login: "r" }, state: "APPROVED", body: "良い" },
				]);
			}
			if (path.endsWith("/comments")) {
				return Response.json([]);
			}
			return Response.json({
				number: 4,
				title: "直す",
				body: "説明",
				merged: false,
				mergeable_state: "clean",
				head: { ref: "fix" },
				base: { ref: "main" },
			});
		});

		const data = JSON.parse(
			await runGitHubRead("t", "octocat/hello", { kind: "pull", number: 4 }),
		);

		expect(data).toMatchObject({
			number: 4,
			head: "fix",
			base: "main",
			mergeable_state: "clean",
			files: [
				{ filename: "a.ts", status: "modified", additions: 2, deletions: 1 },
			],
			reviews: [{ user: "r", state: "APPROVED", body: "良い" }],
		});
	});

	it("ワークフローと実行を読む。実行のジョブでは、失敗した手順を示す", async () => {
		const calls = mockFetch((call) => {
			const path = call.url.pathname;
			if (path.endsWith("/workflows")) {
				return Response.json({
					workflows: [
						{
							id: 1,
							name: "CI",
							path: ".github/workflows/ci.yml",
							state: "active",
						},
					],
				});
			}
			if (path.endsWith("/jobs")) {
				return Response.json({
					jobs: [
						{
							id: 77,
							name: "test",
							status: "completed",
							conclusion: "failure",
							steps: [
								{ name: "Set up", conclusion: "success" },
								{ name: "Run tests", conclusion: "failure" },
							],
						},
					],
				});
			}
			if (path.endsWith("/runs")) {
				return Response.json({
					workflow_runs: [
						{
							id: 9,
							name: "CI",
							status: "completed",
							conclusion: "failure",
							head_branch: "main",
							head_sha: "abcdef123456",
						},
					],
				});
			}
			return Response.json({ id: 9, name: "CI", head_sha: "abcdef123456" });
		});

		const workflows = JSON.parse(
			await runGitHubRead("t", "octocat/hello", { kind: "workflows" }),
		);
		const runs = JSON.parse(
			await runGitHubRead("t", "octocat/hello", {
				kind: "runs",
				workflow: "ci.yml",
				branch: "main",
				status: "failure",
				limit: 5,
			}),
		);
		const run = JSON.parse(
			await runGitHubRead("t", "octocat/hello", { kind: "run", runId: 9 }),
		);

		expect(workflows).toEqual([
			{ id: 1, name: "CI", path: ".github/workflows/ci.yml", state: "active" },
		]);
		expect(requestLine(calls[1] as FetchCall)).toBe(
			"GET /repos/octocat/hello/actions/workflows/ci.yml/runs?per_page=5&branch=main&status=failure",
		);
		expect(runs[0]).toMatchObject({ id: 9, sha: "abcdef1" });
		expect(run.jobs).toEqual([
			{
				id: 77,
				name: "test",
				status: "completed",
				conclusion: "failure",
				failed_steps: ["Run tests"],
			},
		]);
	});

	it("ジョブのログは、時刻を除き、長ければ後ろの部分だけを返す", async () => {
		mockFetch(
			() =>
				new Response(
					`2026-11-01T00:00:00.1234567Z first\n${"x".repeat(20_000)}\n2026-11-01T00:00:01.0000000Z ##[error]Process completed with exit code 1.`,
				),
		);

		const text = await runGitHubRead("t", "octocat/hello", {
			kind: "job_logs",
			jobId: 77,
		});

		expect(text.startsWith("(前の部分は省きました)")).toBe(true);
		expect(text.endsWith("##[error]Process completed with exit code 1.")).toBe(
			true,
		);
		expect(text).not.toContain("2026-11-01T00:00:01");
	});

	it("Projectの一覧と、Projectの項目を読む", async () => {
		const calls = mockFetch((call) => {
			const query = (call.body as { query: string }).query;
			return Response.json({
				data: {
					repository: query.includes("projectsV2")
						? { projectsV2: { nodes: [{ number: 1, title: "ロードマップ" }] } }
						: {
								projectV2: {
									title: "ロードマップ",
									items: { nodes: [{ id: "PVTI_1" }] },
								},
							},
				},
			});
		});

		const projects = JSON.parse(
			await runGitHubRead("t", "octocat/hello", { kind: "projects" }),
		);
		const project = JSON.parse(
			await runGitHubRead("t", "octocat/hello", { kind: "project", number: 1 }),
		);

		expect(projects).toEqual([{ number: 1, title: "ロードマップ" }]);
		expect(project.items.nodes).toEqual([{ id: "PVTI_1" }]);
		expect((calls[1] as FetchCall).body).toMatchObject({
			variables: { owner: "octocat", name: "hello", number: 1 },
		});
	});

	it("Pagesが有効でなければ、そう返す", async () => {
		mockFetch(() => Response.json({ message: "Not Found" }, { status: 404 }));

		expect(await runGitHubRead("t", "octocat/hello", { kind: "pages" })).toBe(
			"このリポジトリでは、Pagesが有効になっていません。",
		);
	});

	it("GitHubが断ったら、GitHubApiErrorを投げる", async () => {
		mockFetch(() => Response.json({ message: "Forbidden" }, { status: 403 }));

		await expect(
			runGitHubRead("t", "octocat/hello", { kind: "workflows" }),
		).rejects.toMatchObject({ status: 403, detail: "Forbidden" });
	});
});
