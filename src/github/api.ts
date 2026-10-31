import type { GitHubTokens } from "../store/github";

/**
 * GitHubの呼び出し(仕様: docs/spec/architecture.md「エージェント」)。
 * トークンの発行と更新は、運営者が登録したBobert用のGitHub Appのクライアントで行う。
 * APIは、そのGitHub Appで本人に代わって操作するトークン(ユーザーアクセストークン)で呼ぶ
 */

const API_BASE = "https://api.github.com";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
/** GitHubのAPIは、User-Agentのないリクエストを断る */
const USER_AGENT = "Bobert (https://github.com/4rtoflow/Bobert)";
const API_VERSION = "2022-11-28";
/** 1ページで読む件数(GitHubの上限) */
const PER_PAGE = 100;
/** 1つのインストールで読む、リポジトリの一覧のページ数の上限 */
const MAX_REPOSITORY_PAGES = 10;

/** GitHubのAPIが、エラーの状態コードを返した */
export class GitHubApiError extends Error {
	constructor(
		readonly status: number,
		message: string,
		/** GitHubが返したエラーの説明(英語)。エージェントに理由を伝えるのに使う */
		readonly detail: string,
	) {
		super(message);
		this.name = "GitHubApiError";
	}
}

/** トークンの発行や更新を、GitHubが断った(codeは bad_verification_code、bad_refresh_token など) */
export class GitHubOAuthError extends Error {
	constructor(readonly code: string) {
		super(`GitHub OAuth error: ${code}`);
		this.name = "GitHubOAuthError";
	}
}

/** 連携のリンクから戻ってきたcodeを、トークンと交換する */
export function exchangeGitHubCode(
	env: Env,
	code: string,
	options: { codeVerifier: string | null; redirectUri: string | null },
	now = Date.now(),
): Promise<GitHubTokens> {
	const params: Record<string, string> = { code };
	if (options.codeVerifier !== null) {
		params.code_verifier = options.codeVerifier;
	}
	if (options.redirectUri !== null) {
		params.redirect_uri = options.redirectUri;
	}
	return requestTokens(env, params, now);
}

/** 更新用のトークンで、新しいトークンをもらう。使った更新用のトークンと、前のアクセストークンは使えなくなる */
export function refreshGitHubToken(
	env: Env,
	refreshToken: string,
	now = Date.now(),
): Promise<GitHubTokens> {
	return requestTokens(
		env,
		{ grant_type: "refresh_token", refresh_token: refreshToken },
		now,
	);
}

async function requestTokens(
	env: Env,
	params: Record<string, string>,
	now: number,
): Promise<GitHubTokens> {
	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/json",
			"User-Agent": USER_AGENT,
		},
		body: JSON.stringify({
			client_id: env.GITHUB_APP_CLIENT_ID,
			client_secret: env.GITHUB_APP_CLIENT_SECRET,
			...params,
		}),
	});
	if (!response.ok) {
		throw new GitHubApiError(
			response.status,
			`GitHub token request failed with status ${response.status}`,
			`GitHub token endpoint returned status ${response.status}`,
		);
	}
	// 断られたときも、状態コードは200で、errorに理由が入る
	const data = (await response.json()) as {
		access_token?: string;
		expires_in?: number;
		refresh_token?: string;
		refresh_token_expires_in?: number;
		error?: string;
	};
	if (data.error !== undefined || data.access_token === undefined) {
		throw new GitHubOAuthError(data.error ?? "no_access_token");
	}
	return {
		accessToken: data.access_token,
		refreshToken: data.refresh_token ?? null,
		expiresAt:
			data.expires_in === undefined ? null : now + data.expires_in * 1000,
		refreshExpiresAt:
			data.refresh_token_expires_in === undefined
				? null
				: now + data.refresh_token_expires_in * 1000,
	};
}

/** 本人がGitHub Appを入れたアカウント(本人か組織) */
export interface GitHubInstallation {
	id: number;
	account: string;
}

/** このトークンで使える、GitHub Appのインストールの一覧 */
export async function listInstallations(
	token: string,
): Promise<GitHubInstallation[]> {
	const data = await apiRequest<{
		installations: { id: number; account: { login: string } | null }[];
	}>(token, "GET", `/user/installations?per_page=${PER_PAGE}`);
	return data.installations.map((installation) => ({
		id: installation.id,
		account: installation.account?.login ?? "",
	}));
}

/** 本人が許可したリポジトリ */
export interface GitHubRepository {
	/** owner/repo */
	fullName: string;
	defaultBranch: string;
}

/** インストールで、このトークンが使えるリポジトリ(本人がBobertに触らせると選んだもの) */
export async function listInstallationRepositories(
	token: string,
	installationId: number,
): Promise<GitHubRepository[]> {
	const repositories: GitHubRepository[] = [];
	for (let page = 1; page <= MAX_REPOSITORY_PAGES; page++) {
		const data = await apiRequest<{
			repositories: { full_name: string; default_branch: string }[];
		}>(
			token,
			"GET",
			`/user/installations/${installationId}/repositories?per_page=${PER_PAGE}&page=${page}`,
		);
		repositories.push(
			...data.repositories.map((repository) => ({
				fullName: repository.full_name,
				defaultBranch: repository.default_branch,
			})),
		);
		if (data.repositories.length < PER_PAGE) {
			break;
		}
	}
	return repositories;
}

/** リポジトリに、そのブランチがあるか */
export async function branchExists(
	token: string,
	fullName: string,
	branch: string,
): Promise<boolean> {
	try {
		await apiRequest(
			token,
			"GET",
			`/repos/${repositoryPath(fullName)}/git/ref/heads/${branch.split("/").map(encodeURIComponent).join("/")}`,
		);
		return true;
	} catch (error) {
		if (error instanceof GitHubApiError && error.status === 404) {
			return false;
		}
		throw error;
	}
}

/** PRを作る。作ったPRのURLを返す */
export async function createGitHubPullRequest(
	token: string,
	fullName: string,
	request: { title: string; head: string; base: string; body: string },
): Promise<string> {
	const data = await apiRequest<{ html_url: string }>(
		token,
		"POST",
		`/repos/${repositoryPath(fullName)}/pulls`,
		request,
	);
	return data.html_url;
}

/**
 * 本人の、GitHub Appの承認を取り消す(/delete)。アクセストークンと更新用のトークンは、すべて使えなくなる。
 * GitHub App自体は、本人のアカウントに入ったまま残る(外すのは本人がGitHubで行う)
 */
export async function revokeGitHubGrant(
	env: Env,
	accessToken: string,
): Promise<void> {
	const response = await fetch(
		`${API_BASE}/applications/${encodeURIComponent(env.GITHUB_APP_CLIENT_ID)}/grant`,
		{
			method: "DELETE",
			headers: {
				...apiHeaders(),
				Authorization: `Basic ${btoa(`${env.GITHUB_APP_CLIENT_ID}:${env.GITHUB_APP_CLIENT_SECRET}`)}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ access_token: accessToken }),
		},
	);
	if (!response.ok) {
		throw new GitHubApiError(
			response.status,
			`GitHub grant revocation failed with status ${response.status}`,
			await errorDetail(response),
		);
	}
}

/** GitHubのAPIを、本人のトークンで呼ぶ */
async function apiRequest<T>(
	token: string,
	method: string,
	path: string,
	body?: unknown,
): Promise<T> {
	const response = await fetch(`${API_BASE}${path}`, {
		method,
		headers: {
			...apiHeaders(),
			Authorization: `Bearer ${token}`,
			...(body === undefined ? {} : { "Content-Type": "application/json" }),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	if (!response.ok) {
		// パスにはリポジトリの名前が入るので、エラーの説明には含めない
		throw new GitHubApiError(
			response.status,
			`GitHub API ${method} failed with status ${response.status}`,
			await errorDetail(response),
		);
	}
	return (await response.json()) as T;
}

function apiHeaders(): Record<string, string> {
	return {
		Accept: "application/vnd.github+json",
		"User-Agent": USER_AGENT,
		"X-GitHub-Api-Version": API_VERSION,
	};
}

/** GitHubが返したエラーの説明。例: 「Validation Failed: A pull request already exists for octocat:fix.」 */
async function errorDetail(response: Response): Promise<string> {
	const data = (await response.json().catch(() => ({}))) as {
		message?: string;
		errors?: ({ message?: string } | string)[];
	};
	const details = (data.errors ?? []).flatMap((entry) =>
		typeof entry === "string"
			? [entry]
			: entry.message === undefined
				? []
				: [entry.message],
	);
	return [data.message ?? `status ${response.status}`, ...details].join(": ");
}

/** owner/repo を、URLのパスに入れる形にする */
function repositoryPath(fullName: string): string {
	return fullName.split("/").map(encodeURIComponent).join("/");
}
