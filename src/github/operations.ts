import {
	apiRequest,
	apiText,
	GitHubApiError,
	type GitHubRepository,
	repositoryPath,
} from "./api";

/**
 * エージェントが、つないだリポジトリのIssue、PR、Actions、Projects、Pagesを、本人のトークンで読み書きする
 * (仕様: docs/spec/architecture.md「エージェント」の「GitHub」)。
 * 読む操作(github_read)は確認なしで答え、書く操作(github_write)は、本人に確認してから行う
 */

/** 一覧で読む件数の、既定と上限 */
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

/** 読んだ結果の、1つの文章の長さの上限(本文、コメント)と、結果全体の上限 */
const TEXT_LIMIT = 4000;
const RESULT_LIMIT = 30_000;
/** ジョブのログは、終わりの方に失敗の理由があるので、後ろから読む */
const LOG_LIMIT = 15_000;

export type IssueState = "open" | "closed" | "all";

/** 読む操作(github_read) */
export type GitHubReadRequest =
	| { kind: "issues"; state: IssueState; labels: string[]; limit: number }
	| { kind: "issue"; number: number }
	| { kind: "pulls"; state: IssueState; limit: number }
	| { kind: "pull"; number: number }
	| { kind: "workflows" }
	| {
			kind: "runs";
			workflow: string | null;
			branch: string | null;
			status: string | null;
			limit: number;
	  }
	| { kind: "run"; runId: number }
	| { kind: "job_logs"; jobId: number }
	| { kind: "projects" }
	| { kind: "project"; number: number }
	| { kind: "pages" };

export type MergeMethod = "merge" | "squash" | "rebase";
export type ReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

/** 書く操作(github_write) */
export type GitHubWriteAction =
	| {
			action: "issue_create";
			title: string;
			body: string;
			labels: string[];
			assignees: string[];
	  }
	| { action: "issue_comment"; number: number; body: string }
	| {
			action: "issue_update";
			number: number;
			title: string | null;
			body: string | null;
			labels: string[] | null;
			assignees: string[] | null;
	  }
	| {
			action: "issue_close";
			number: number;
			reason: "completed" | "not_planned";
	  }
	| { action: "issue_reopen"; number: number }
	| { action: "pr_comment"; number: number; body: string }
	| { action: "pr_review"; number: number; event: ReviewEvent; body: string }
	| {
			action: "pr_merge";
			number: number;
			method: MergeMethod;
			commitTitle: string | null;
			commitMessage: string | null;
	  }
	| { action: "pr_close"; number: number }
	| {
			action: "workflow_dispatch";
			workflow: string;
			/** nullなら、リポジトリの既定のブランチ */
			ref: string | null;
			inputs: Record<string, string>;
	  }
	| { action: "run_rerun"; runId: number; failedOnly: boolean }
	| { action: "run_cancel"; runId: number }
	| { action: "project_add_item"; project: number; number: number }
	| {
			action: "project_update_item";
			project: number;
			itemId: string;
			field: string;
			value: string;
	  }
	| { action: "pages_build" };

export type GitHubWriteName = GitHubWriteAction["action"];

/** 書く操作の名前。仕様の「操作」の行の文言に対応する */
export const WRITE_ACTIONS: readonly GitHubWriteName[] = [
	"issue_create",
	"issue_comment",
	"issue_update",
	"issue_close",
	"issue_reopen",
	"pr_comment",
	"pr_review",
	"pr_merge",
	"pr_close",
	"workflow_dispatch",
	"run_rerun",
	"run_cancel",
	"project_add_item",
	"project_update_item",
	"pages_build",
];

export const READ_KINDS: readonly GitHubReadRequest["kind"][] = [
	"issues",
	"issue",
	"pulls",
	"pull",
	"workflows",
	"runs",
	"run",
	"job_logs",
	"projects",
	"project",
	"pages",
];

type Input = Record<string, unknown>;

/** 1以上の整数(数値か、数字だけの文字)。そうでなければnull */
function count(value: unknown): number | null {
	const number =
		typeof value === "string" && /^\d+$/.test(value.trim())
			? Number(value)
			: value;
	return typeof number === "number" &&
		Number.isSafeInteger(number) &&
		number > 0
		? number
		: null;
}

function text(value: unknown): string | null {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function stringList(value: unknown): string[] | null {
	if (!Array.isArray(value)) {
		return null;
	}
	return value
		.filter((entry): entry is string => typeof entry === "string")
		.map((entry) => entry.trim())
		.filter((entry) => entry !== "");
}

function limitOf(value: unknown): number {
	return Math.min(count(value) ?? DEFAULT_LIMIT, MAX_LIMIT);
}

function stateOf(value: unknown): IssueState {
	return value === "closed" || value === "all" ? value : "open";
}

/** github_readの入力を読む。正しくなければ、エージェントに返す文 */
export function parseGitHubRead(input: Input): GitHubReadRequest | string {
	const kind = input.kind;
	switch (kind) {
		case "issues":
			return {
				kind,
				state: stateOf(input.state),
				labels: stringList(input.labels) ?? [],
				limit: limitOf(input.limit),
			};
		case "pulls":
			return { kind, state: stateOf(input.state), limit: limitOf(input.limit) };
		case "issue":
		case "pull":
		case "project": {
			const number = count(input.number);
			return number === null
				? "number(IssueやPR、Projectの番号)を、1以上の整数で指定してください。"
				: { kind, number };
		}
		case "run": {
			const runId = count(input.run_id);
			return runId === null
				? "run_id(実行のID)を、1以上の整数で指定してください。"
				: { kind, runId };
		}
		case "job_logs": {
			const jobId = count(input.job_id);
			return jobId === null
				? "job_id(ジョブのID。kindがrunの結果で分かる)を、1以上の整数で指定してください。"
				: { kind, jobId };
		}
		case "runs":
			return {
				kind,
				workflow: text(input.workflow),
				branch: text(input.branch),
				status: text(input.status),
				limit: limitOf(input.limit),
			};
		case "workflows":
		case "projects":
		case "pages":
			return { kind };
		default:
			return `kind は、次のどれかで指定してください: ${READ_KINDS.join(", ")}`;
	}
}

/** github_writeの入力を読む。正しくなければ、エージェントに返す文 */
export function parseGitHubWrite(input: Input): GitHubWriteAction | string {
	const action = input.action;
	const number = count(input.number);
	const body = typeof input.body === "string" ? input.body : "";
	const needNumber =
		"number(IssueやPRの番号)を、1以上の整数で指定してください。";
	switch (action) {
		case "issue_create": {
			const title = text(input.title);
			return title === null
				? "title(Issueのタイトル)を指定してください。"
				: {
						action,
						title: title.replace(/\s*\n\s*/g, " "),
						body,
						labels: stringList(input.labels) ?? [],
						assignees: stringList(input.assignees) ?? [],
					};
		}
		case "issue_comment":
		case "pr_comment":
			if (number === null) {
				return needNumber;
			}
			return body.trim() === ""
				? "body(コメントの本文)を指定してください。"
				: { action, number, body };
		case "issue_update": {
			if (number === null) {
				return needNumber;
			}
			const title = text(input.title);
			const update = {
				action,
				number,
				title: title === null ? null : title.replace(/\s*\n\s*/g, " "),
				body: typeof input.body === "string" ? input.body : null,
				labels: stringList(input.labels),
				assignees: stringList(input.assignees),
			} as const;
			return update.title === null &&
				update.body === null &&
				update.labels === null &&
				update.assignees === null
				? "title、body、labels、assignees のどれかを指定してください。"
				: update;
		}
		case "issue_close":
			return number === null
				? needNumber
				: {
						action,
						number,
						reason:
							input.reason === "not_planned" ? "not_planned" : "completed",
					};
		case "issue_reopen":
		case "pr_close":
			return number === null ? needNumber : { action, number };
		case "pr_review": {
			if (number === null) {
				return needNumber;
			}
			const event = input.event;
			if (
				event !== "APPROVE" &&
				event !== "REQUEST_CHANGES" &&
				event !== "COMMENT"
			) {
				return "event を、APPROVE、REQUEST_CHANGES、COMMENT のどれかで指定してください。";
			}
			return event !== "APPROVE" && body.trim() === ""
				? "APPROVE以外のレビューには、body(レビューの本文)が要ります。"
				: { action, number, event, body };
		}
		case "pr_merge": {
			if (number === null) {
				return needNumber;
			}
			const method = input.merge_method;
			return {
				action,
				number,
				method: method === "squash" || method === "rebase" ? method : "merge",
				commitTitle: text(input.commit_title),
				commitMessage: text(input.commit_message),
			};
		}
		case "workflow_dispatch": {
			const workflow = text(input.workflow);
			if (workflow === null) {
				return "workflow(ワークフローのファイル名かID。例: ci.yml)を指定してください。";
			}
			const inputs: Record<string, string> = {};
			const given = input.inputs;
			if (
				typeof given === "object" &&
				given !== null &&
				!Array.isArray(given)
			) {
				for (const [key, value] of Object.entries(given)) {
					inputs[key] = String(value);
				}
			}
			return { action, workflow, ref: text(input.ref), inputs };
		}
		case "run_rerun":
		case "run_cancel": {
			const runId = count(input.run_id);
			if (runId === null) {
				return "run_id(実行のID)を、1以上の整数で指定してください。";
			}
			return action === "run_rerun"
				? { action, runId, failedOnly: input.failed_only === true }
				: { action, runId };
		}
		case "project_add_item": {
			const project = count(input.project);
			return project === null || number === null
				? "project(Projectの番号)と number(追加するIssueかPRの番号)を、1以上の整数で指定してください。"
				: { action, project, number };
		}
		case "project_update_item": {
			const project = count(input.project);
			const itemId = text(input.item_id);
			const field = text(input.field);
			const value =
				typeof input.value === "string" || typeof input.value === "number"
					? String(input.value)
					: null;
			return project === null ||
				itemId === null ||
				field === null ||
				value === null
				? "project(Projectの番号)、item_id(項目のID。kindがprojectの結果で分かる)、field(フィールドの名前)、value(新しい値)を指定してください。"
				: { action, project, itemId, field, value };
		}
		case "pages_build":
			return { action };
		default:
			return `action は、次のどれかで指定してください: ${WRITE_ACTIONS.join(", ")}`;
	}
}

/** 書く操作で、GitHubに渡す前に確かめた結果 */
export interface PreparedWrite {
	/** 既定の値(ブランチ)を入れた操作 */
	action: GitHubWriteAction;
	/** 確認の「対象」の行の値 */
	target: string;
	/** 確認で引用する内容。なければ空 */
	detail: string;
}

/** 書く操作を行った結果 */
export interface WriteResult {
	/** 結果のページのURL。なければnull */
	url: string | null;
}

/**
 * 書く操作の対象を、GitHubで確かめる(IssueやPRの番号があるか、Projectやフィールドがあるか)。
 * 確認の「対象」の行に、タイトルなどを出すのにも使う。ないときは、GitHubApiErrorを投げる
 */
export async function prepareGitHubWrite(
	token: string,
	repository: GitHubRepository,
	action: GitHubWriteAction,
): Promise<PreparedWrite> {
	const repo = repositoryPath(repository.fullName);
	switch (action.action) {
		case "issue_create":
			return { action, target: action.title, detail: issueDetail(action) };
		case "issue_comment":
		case "issue_update":
		case "issue_close":
		case "issue_reopen": {
			const issue = await apiRequest<{ title: string }>(
				token,
				"GET",
				`/repos/${repo}/issues/${action.number}`,
			);
			return {
				action,
				target: `#${action.number} ${issue.title}`,
				detail: issueDetail(action),
			};
		}
		case "pr_comment":
		case "pr_review":
		case "pr_merge":
		case "pr_close": {
			const pull = await apiRequest<{ title: string }>(
				token,
				"GET",
				`/repos/${repo}/pulls/${action.number}`,
			);
			return {
				action,
				target: `#${action.number} ${pull.title}`,
				detail: pullDetail(action),
			};
		}
		case "workflow_dispatch": {
			const ref = action.ref ?? repository.defaultBranch;
			const inputs = Object.entries(action.inputs).map(
				([key, value]) => `${key}=${value}`,
			);
			return {
				action: { ...action, ref },
				target: `${action.workflow}(${ref})`,
				detail: inputs.length === 0 ? "" : `inputs: ${inputs.join(", ")}`,
			};
		}
		case "run_rerun":
		case "run_cancel": {
			const run = await apiRequest<{ name?: string | null }>(
				token,
				"GET",
				`/repos/${repo}/actions/runs/${action.runId}`,
			);
			return {
				action,
				target: `${action.runId} ${run.name ?? ""}`.trim(),
				detail:
					action.action === "run_rerun" && action.failedOnly
						? "failed_only: true"
						: "",
			};
		}
		case "project_add_item": {
			const project = await loadProject(
				token,
				repository.fullName,
				action.project,
			);
			await apiRequest(token, "GET", `/repos/${repo}/issues/${action.number}`);
			return {
				action,
				target: project.title,
				detail: `number: ${action.number}`,
			};
		}
		case "project_update_item": {
			const project = await loadProject(
				token,
				repository.fullName,
				action.project,
			);
			resolveFieldValue(project, action.field, action.value);
			return {
				action,
				target: project.title,
				detail: `${action.field}: ${action.value}`,
			};
		}
		case "pages_build":
			return { action, target: "", detail: "" };
	}
}

function issueDetail(
	action: Extract<
		GitHubWriteAction,
		{
			action:
				| "issue_create"
				| "issue_comment"
				| "issue_update"
				| "issue_close"
				| "issue_reopen";
		}
	>,
): string {
	const lines: string[] = [];
	switch (action.action) {
		case "issue_create":
			lines.push(action.body);
			if (action.labels.length > 0) {
				lines.push(`labels: ${action.labels.join(", ")}`);
			}
			if (action.assignees.length > 0) {
				lines.push(`assignees: ${action.assignees.join(", ")}`);
			}
			break;
		case "issue_comment":
			lines.push(action.body);
			break;
		case "issue_update":
			if (action.title !== null) {
				lines.push(`title: ${action.title}`);
			}
			if (action.body !== null) {
				lines.push(action.body);
			}
			if (action.labels !== null) {
				lines.push(`labels: ${action.labels.join(", ")}`);
			}
			if (action.assignees !== null) {
				lines.push(`assignees: ${action.assignees.join(", ")}`);
			}
			break;
		case "issue_close":
			lines.push(`reason: ${action.reason}`);
			break;
		case "issue_reopen":
			break;
	}
	return lines.join("\n").trim();
}

function pullDetail(
	action: Extract<
		GitHubWriteAction,
		{ action: "pr_comment" | "pr_review" | "pr_merge" | "pr_close" }
	>,
): string {
	switch (action.action) {
		case "pr_comment":
			return action.body.trim();
		case "pr_review":
			return [`event: ${action.event}`, action.body.trim()]
				.filter((line) => line !== "")
				.join("\n");
		case "pr_merge":
			return [
				`merge_method: ${action.method}`,
				...(action.commitTitle === null
					? []
					: [`commit_title: ${action.commitTitle}`]),
			].join("\n");
		case "pr_close":
			return "";
	}
}

/** 書く操作を、GitHubで行う。GitHubに断られたら、GitHubApiErrorを投げる */
export async function runGitHubWrite(
	token: string,
	fullName: string,
	action: GitHubWriteAction,
): Promise<WriteResult> {
	const repo = repositoryPath(fullName);
	const url = (data: { html_url: string }): WriteResult => ({
		url: data.html_url,
	});
	switch (action.action) {
		case "issue_create":
			return url(
				await apiRequest(token, "POST", `/repos/${repo}/issues`, {
					title: action.title,
					body: action.body,
					...(action.labels.length > 0 && { labels: action.labels }),
					...(action.assignees.length > 0 && { assignees: action.assignees }),
				}),
			);
		case "issue_comment":
		case "pr_comment":
			return url(
				await apiRequest(
					token,
					"POST",
					`/repos/${repo}/issues/${action.number}/comments`,
					{ body: action.body },
				),
			);
		case "issue_update":
			return url(
				await apiRequest(
					token,
					"PATCH",
					`/repos/${repo}/issues/${action.number}`,
					{
						...(action.title !== null && { title: action.title }),
						...(action.body !== null && { body: action.body }),
						...(action.labels !== null && { labels: action.labels }),
						...(action.assignees !== null && { assignees: action.assignees }),
					},
				),
			);
		case "issue_close":
			return url(
				await apiRequest(
					token,
					"PATCH",
					`/repos/${repo}/issues/${action.number}`,
					{ state: "closed", state_reason: action.reason },
				),
			);
		case "issue_reopen":
			return url(
				await apiRequest(
					token,
					"PATCH",
					`/repos/${repo}/issues/${action.number}`,
					{ state: "open" },
				),
			);
		case "pr_review":
			return url(
				await apiRequest(
					token,
					"POST",
					`/repos/${repo}/pulls/${action.number}/reviews`,
					{
						event: action.event,
						...(action.body.trim() !== "" && { body: action.body }),
					},
				),
			);
		case "pr_merge":
			await apiRequest(
				token,
				"PUT",
				`/repos/${repo}/pulls/${action.number}/merge`,
				{
					merge_method: action.method,
					...(action.commitTitle !== null && {
						commit_title: action.commitTitle,
					}),
					...(action.commitMessage !== null && {
						commit_message: action.commitMessage,
					}),
				},
			);
			return { url: `https://github.com/${fullName}/pull/${action.number}` };
		case "pr_close":
			return url(
				await apiRequest(
					token,
					"PATCH",
					`/repos/${repo}/pulls/${action.number}`,
					{ state: "closed" },
				),
			);
		case "workflow_dispatch":
			await apiRequest(
				token,
				"POST",
				`/repos/${repo}/actions/workflows/${encodeURIComponent(action.workflow)}/dispatches`,
				{
					ref: action.ref,
					...(Object.keys(action.inputs).length > 0 && {
						inputs: action.inputs,
					}),
				},
			);
			return { url: `https://github.com/${fullName}/actions` };
		case "run_rerun":
			await apiRequest(
				token,
				"POST",
				`/repos/${repo}/actions/runs/${action.runId}/${action.failedOnly ? "rerun-failed-jobs" : "rerun"}`,
			);
			return {
				url: `https://github.com/${fullName}/actions/runs/${action.runId}`,
			};
		case "run_cancel":
			await apiRequest(
				token,
				"POST",
				`/repos/${repo}/actions/runs/${action.runId}/cancel`,
			);
			return {
				url: `https://github.com/${fullName}/actions/runs/${action.runId}`,
			};
		case "project_add_item": {
			const project = await loadProject(token, fullName, action.project);
			const issue = await apiRequest<{ node_id: string }>(
				token,
				"GET",
				`/repos/${repo}/issues/${action.number}`,
			);
			await graphql(
				token,
				"mutation($project:ID!,$content:ID!){addProjectV2ItemById(input:{projectId:$project,contentId:$content}){item{id}}}",
				{ project: project.id, content: issue.node_id },
			);
			return { url: project.url };
		}
		case "project_update_item": {
			const project = await loadProject(token, fullName, action.project);
			const { fieldId, value } = resolveFieldValue(
				project,
				action.field,
				action.value,
			);
			await graphql(
				token,
				"mutation($project:ID!,$item:ID!,$field:ID!,$value:ProjectV2FieldValue!){updateProjectV2ItemFieldValue(input:{projectId:$project,itemId:$item,fieldId:$field,value:$value}){projectV2Item{id}}}",
				{ project: project.id, item: action.itemId, field: fieldId, value },
			);
			return { url: project.url };
		}
		case "pages_build":
			await apiRequest(token, "POST", `/repos/${repo}/pages/builds`);
			return { url: null };
	}
}

/** 読む操作を行い、エージェントに返す文章にする。GitHubに断られたら、GitHubApiErrorを投げる */
export async function runGitHubRead(
	token: string,
	fullName: string,
	request: GitHubReadRequest,
): Promise<string> {
	const repo = repositoryPath(fullName);
	switch (request.kind) {
		case "issues": {
			const query = new URLSearchParams({
				state: request.state,
				per_page: String(MAX_LIMIT * 2),
			});
			if (request.labels.length > 0) {
				query.set("labels", request.labels.join(","));
			}
			const items = await apiRequest<Raw[]>(
				token,
				"GET",
				`/repos/${repo}/issues?${query}`,
			);
			// この一覧には、PRも混ざる
			return json(
				items
					.filter((item) => item.pull_request === undefined)
					.slice(0, request.limit)
					.map(summarizeIssue),
			);
		}
		case "issue": {
			const [issue, comments] = await Promise.all([
				apiRequest<Raw>(
					token,
					"GET",
					`/repos/${repo}/issues/${request.number}`,
				),
				apiRequest<Raw[]>(
					token,
					"GET",
					`/repos/${repo}/issues/${request.number}/comments?per_page=50`,
				),
			]);
			return json({
				...summarizeIssue(issue),
				body: clip(issue.body, TEXT_LIMIT),
				comments: comments.map(summarizeComment),
			});
		}
		case "pulls": {
			const items = await apiRequest<Raw[]>(
				token,
				"GET",
				`/repos/${repo}/pulls?state=${request.state}&per_page=${request.limit}`,
			);
			return json(items.map(summarizePull));
		}
		case "pull": {
			const [pull, files, reviews, comments] = await Promise.all([
				apiRequest<Raw>(token, "GET", `/repos/${repo}/pulls/${request.number}`),
				apiRequest<Raw[]>(
					token,
					"GET",
					`/repos/${repo}/pulls/${request.number}/files?per_page=100`,
				),
				apiRequest<Raw[]>(
					token,
					"GET",
					`/repos/${repo}/pulls/${request.number}/reviews?per_page=50`,
				),
				apiRequest<Raw[]>(
					token,
					"GET",
					`/repos/${repo}/issues/${request.number}/comments?per_page=50`,
				),
			]);
			return json({
				...summarizePull(pull),
				body: clip(pull.body, TEXT_LIMIT),
				merged: pull.merged,
				mergeable: pull.mergeable,
				mergeable_state: pull.mergeable_state,
				files: files.map((file) => ({
					filename: file.filename,
					status: file.status,
					additions: file.additions,
					deletions: file.deletions,
				})),
				reviews: reviews.map((review) => ({
					user: login(review.user),
					state: review.state,
					body: clip(review.body, TEXT_LIMIT),
				})),
				comments: comments.map(summarizeComment),
			});
		}
		case "workflows": {
			const data = await apiRequest<{ workflows: Raw[] }>(
				token,
				"GET",
				`/repos/${repo}/actions/workflows?per_page=100`,
			);
			return json(
				data.workflows.map((workflow) => ({
					id: workflow.id,
					name: workflow.name,
					path: workflow.path,
					state: workflow.state,
				})),
			);
		}
		case "runs": {
			const query = new URLSearchParams({ per_page: String(request.limit) });
			if (request.branch !== null) {
				query.set("branch", request.branch);
			}
			if (request.status !== null) {
				query.set("status", request.status);
			}
			const base =
				request.workflow === null
					? `/repos/${repo}/actions/runs`
					: `/repos/${repo}/actions/workflows/${encodeURIComponent(request.workflow)}/runs`;
			const data = await apiRequest<{ workflow_runs: Raw[] }>(
				token,
				"GET",
				`${base}?${query}`,
			);
			return json(data.workflow_runs.map(summarizeRun));
		}
		case "run": {
			const [run, jobs] = await Promise.all([
				apiRequest<Raw>(
					token,
					"GET",
					`/repos/${repo}/actions/runs/${request.runId}`,
				),
				apiRequest<{ jobs: Raw[] }>(
					token,
					"GET",
					`/repos/${repo}/actions/runs/${request.runId}/jobs?per_page=100`,
				),
			]);
			return json({
				...summarizeRun(run),
				jobs: jobs.jobs.map((job) => ({
					id: job.id,
					name: job.name,
					status: job.status,
					conclusion: job.conclusion,
					failed_steps: (Array.isArray(job.steps) ? (job.steps as Raw[]) : [])
						.filter((step) => step.conclusion === "failure")
						.map((step) => step.name),
				})),
			});
		}
		case "job_logs": {
			const logs = await apiText(
				token,
				"GET",
				`/repos/${repo}/actions/jobs/${request.jobId}/logs`,
			);
			const plain = logs.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z /gm, "");
			return plain.length <= LOG_LIMIT
				? plain
				: `(前の部分は省きました)\n${plain.slice(-LOG_LIMIT)}`;
		}
		case "projects": {
			const [owner, name] = splitName(fullName);
			const data = await graphql<{
				repository: { projectsV2: { nodes: Raw[] } };
			}>(
				token,
				"query($owner:String!,$name:String!){repository(owner:$owner,name:$name){projectsV2(first:30){nodes{number title url closed}}}}",
				{ owner, name },
			);
			return json(data.repository.projectsV2.nodes);
		}
		case "project": {
			const [owner, name] = splitName(fullName);
			const data = await graphql<{
				repository: { projectV2: Raw | null };
			}>(token, PROJECT_READ_QUERY, { owner, name, number: request.number });
			if (data.repository.projectV2 === null) {
				throw projectNotFound(request.number);
			}
			return json(data.repository.projectV2);
		}
		case "pages": {
			try {
				const [pages, build] = await Promise.all([
					apiRequest<Raw>(token, "GET", `/repos/${repo}/pages`),
					apiRequest<Raw>(
						token,
						"GET",
						`/repos/${repo}/pages/builds/latest`,
					).catch(() => null),
				]);
				return json({
					url: pages.html_url,
					status: pages.status,
					build_type: pages.build_type,
					source: pages.source,
					latest_build:
						build === null
							? null
							: {
									status: build.status,
									error: build.error,
									created_at: build.created_at,
								},
				});
			} catch (error) {
				if (error instanceof GitHubApiError && error.status === 404) {
					return "このリポジトリでは、Pagesが有効になっていません。";
				}
				throw error;
			}
		}
	}
}

type Raw = Record<string, unknown>;

/** 結果をJSONの文章にする。長すぎれば、後ろを切る */
function json(value: unknown): string {
	const body = JSON.stringify(value, null, 1);
	return body.length <= RESULT_LIMIT
		? body
		: `${body.slice(0, RESULT_LIMIT)}\n(長いので、ここまでです)`;
}

function clip(value: unknown, limit: number): string {
	const body = typeof value === "string" ? value : "";
	return body.length <= limit ? body : `${body.slice(0, limit)}…`;
}

function login(user: unknown): string | null {
	return typeof user === "object" && user !== null && "login" in user
		? String((user as { login: unknown }).login)
		: null;
}

function labelNames(labels: unknown): string[] {
	return Array.isArray(labels)
		? labels.map((label) =>
				typeof label === "string" ? label : String((label as Raw).name),
			)
		: [];
}

function summarizeIssue(issue: Raw): Raw {
	return {
		number: issue.number,
		title: issue.title,
		state: issue.state,
		user: login(issue.user),
		labels: labelNames(issue.labels),
		assignees: Array.isArray(issue.assignees) ? issue.assignees.map(login) : [],
		comments: issue.comments,
		updated_at: issue.updated_at,
		url: issue.html_url,
	};
}

function summarizePull(pull: Raw): Raw {
	const ref = (side: unknown) =>
		typeof side === "object" && side !== null
			? (side as { ref?: unknown }).ref
			: null;
	return {
		number: pull.number,
		title: pull.title,
		state: pull.state,
		draft: pull.draft,
		user: login(pull.user),
		head: ref(pull.head),
		base: ref(pull.base),
		updated_at: pull.updated_at,
		url: pull.html_url,
	};
}

function summarizeComment(comment: Raw): Raw {
	return {
		user: login(comment.user),
		created_at: comment.created_at,
		body: clip(comment.body, TEXT_LIMIT),
	};
}

function summarizeRun(run: Raw): Raw {
	return {
		id: run.id,
		name: run.name,
		status: run.status,
		conclusion: run.conclusion,
		branch: run.head_branch,
		event: run.event,
		sha: typeof run.head_sha === "string" ? run.head_sha.slice(0, 7) : null,
		created_at: run.created_at,
		url: run.html_url,
	};
}

function splitName(fullName: string): [string, string] {
	const slash = fullName.indexOf("/");
	return [fullName.slice(0, slash), fullName.slice(slash + 1)];
}

// ---- Projects(GraphQL) ----

const FIELD_NAME = "field{... on ProjectV2FieldCommon{name}}";

const PROJECT_READ_QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){projectV2(number:$number){title url closed shortDescription fields(first:50){nodes{... on ProjectV2FieldCommon{name dataType} ... on ProjectV2SingleSelectField{options{name}}}} items(first:50){nodes{id type content{... on Issue{number title} ... on PullRequest{number title} ... on DraftIssue{title}} fieldValues(first:20){nodes{... on ProjectV2ItemFieldTextValue{text ${FIELD_NAME}} ... on ProjectV2ItemFieldNumberValue{number ${FIELD_NAME}} ... on ProjectV2ItemFieldDateValue{date ${FIELD_NAME}} ... on ProjectV2ItemFieldSingleSelectValue{name ${FIELD_NAME}}}}}}}}}`;

const PROJECT_QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){projectV2(number:$number){id title url fields(first:50){nodes{... on ProjectV2FieldCommon{id name dataType} ... on ProjectV2SingleSelectField{options{id name}}}}}}}`;

interface Project {
	id: string;
	title: string;
	url: string;
	fields: {
		id: string;
		name: string;
		dataType: string;
		options?: { id: string; name: string }[];
	}[];
}

function projectNotFound(number: number): GitHubApiError {
	return new GitHubApiError(
		404,
		"GitHub project not found",
		`このリポジトリにつながったProject #${number} が見つかりません。`,
	);
}

async function loadProject(
	token: string,
	fullName: string,
	number: number,
): Promise<Project> {
	const [owner, name] = splitName(fullName);
	const data = await graphql<{
		repository: {
			projectV2: {
				id: string;
				title: string;
				url: string;
				fields: { nodes: (Project["fields"][number] | null)[] };
			} | null;
		};
	}>(token, PROJECT_QUERY, { owner, name, number });
	const project = data.repository.projectV2;
	if (project === null) {
		throw projectNotFound(number);
	}
	return {
		...project,
		fields: project.fields.nodes.filter(
			(field): field is Project["fields"][number] =>
				field !== null && typeof field.id === "string",
		),
	};
}

/** フィールドの名前と新しい値から、GitHubに渡すフィールドのIDと値を決める */
function resolveFieldValue(
	project: Project,
	fieldName: string,
	value: string,
): { fieldId: string; value: Record<string, unknown> } {
	const wanted = fieldName.toLowerCase();
	const field = project.fields.find(
		(entry) => entry.name.toLowerCase() === wanted,
	);
	if (field === undefined) {
		throw invalidInput(
			`フィールド「${fieldName}」がありません。あるフィールド: ${project.fields.map((entry) => entry.name).join(", ")}`,
		);
	}
	switch (field.dataType) {
		case "TEXT":
			return { fieldId: field.id, value: { text: value } };
		case "NUMBER": {
			const number = Number(value);
			if (!Number.isFinite(number)) {
				throw invalidInput(
					`フィールド「${field.name}」の値は、数値にしてください。`,
				);
			}
			return { fieldId: field.id, value: { number } };
		}
		case "DATE":
			return { fieldId: field.id, value: { date: value } };
		case "SINGLE_SELECT": {
			const option = field.options?.find(
				(entry) => entry.name.toLowerCase() === value.toLowerCase(),
			);
			if (option === undefined) {
				throw invalidInput(
					`フィールド「${field.name}」に、選択肢「${value}」がありません。ある選択肢: ${(field.options ?? []).map((entry) => entry.name).join(", ")}`,
				);
			}
			return { fieldId: field.id, value: { singleSelectOptionId: option.id } };
		}
		default:
			throw invalidInput(
				`フィールド「${field.name}」(${field.dataType})は、まだ更新できません。text、number、date、single selectのフィールドだけ更新できます。`,
			);
	}
}

function invalidInput(detail: string): GitHubApiError {
	return new GitHubApiError(422, "GitHub write input is invalid", detail);
}

async function graphql<T = unknown>(
	token: string,
	query: string,
	variables: Record<string, unknown>,
): Promise<T> {
	const data = await apiRequest<{
		data?: T | null;
		errors?: { message?: string }[];
	}>(token, "POST", "/graphql", { query, variables });
	if (data.data === undefined || data.data === null || data.errors?.length) {
		throw new GitHubApiError(
			422,
			"GitHub GraphQL request failed",
			(data.errors ?? []).map((error) => error.message ?? "error").join(": ") ||
				"GraphQL error",
		);
	}
	return data.data;
}
