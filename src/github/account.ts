import { logEvent } from "../log";
import {
	deleteGitHubLink,
	type GitHubLink,
	type GitHubTokens,
	loadGitHubLink,
	replaceGitHubTokens,
} from "../store/github";
import {
	branchExists,
	createGitHubPullRequest,
	GitHubApiError,
	GitHubOAuthError,
	type GitHubRepository,
	listInstallationRepositories,
	listInstallations,
	refreshGitHubToken,
	revokeGitHubGrant,
} from "./api";

/**
 * 本人のGitHubとの連携を使う(仕様: docs/spec/architecture.md「エージェント」)。
 * - トークンは8時間で切れるので、残りの有効期間が足りなければ、Bobertが更新する
 * - GitHubでBobertのアプリを外されていたら(トークンが取り消された、アプリがどこにも入っていない)、
 *   次に使うときに気づき、連携の記録を消して「連携していない」と返す
 */

/** APIを1回呼ぶのに要る、トークンの残りの有効期間 */
export const API_TOKEN_VALIDITY_MS = 5 * 60_000;

/**
 * ほかの処理が更新しているかもしれないときに、記録を読み直す回数と間隔。
 * 更新用のトークンは1回しか使えないので、同時に更新すると、遅れた方は断られるため
 */
const RELOAD_ATTEMPTS = 2;
const RELOAD_INTERVAL_MS = 500;

/** 本人のアクセストークン */
export interface GitHubToken {
	value: string;
	/** 有効期限(ミリ秒)。期限がなければnull */
	expiresAt: number | null;
	/** 保存した記録の番号。トークンが入れ替わったかを見分けるのに使う */
	version: number;
}

/**
 * 本人のアクセストークン。残りの有効期間がminValidityMsより短ければ、更新してから返す。
 * 連携していないか、外されていた(更新できなかった)ならnull
 */
export async function gitHubAccessToken(
	env: Env,
	userId: string,
	minValidityMs: number,
	now = Date.now(),
): Promise<GitHubToken | null> {
	const link = await loadGitHubLink(env, userId);
	if (link === null) {
		return null;
	}
	if (link.expiresAt === null || link.expiresAt - now >= minValidityMs) {
		return tokenOf(link);
	}
	return refresh(env, userId, link, now);
}

/** トークンを更新して保存する。更新できなければ、外されたとみなして連携を消し、nullを返す */
async function refresh(
	env: Env,
	userId: string,
	link: GitHubLink,
	now: number,
): Promise<GitHubToken | null> {
	if (
		link.refreshToken === null ||
		(link.refreshExpiresAt !== null && link.refreshExpiresAt <= now)
	) {
		// 更新できない。まだ切れていなければ、そのまま使う
		if (link.expiresAt === null || link.expiresAt > now) {
			return tokenOf(link);
		}
		await unlink(env, userId, link.version, "refresh_token_expired");
		return null;
	}
	let tokens: GitHubTokens;
	try {
		tokens = await refreshGitHubToken(env, link.refreshToken, now);
	} catch (error) {
		if (!(error instanceof GitHubOAuthError)) {
			throw error;
		}
		// ほかの処理が先に更新していれば、そちらを使う
		const latest = await reloadChanged(env, userId, link.version);
		if (latest !== null) {
			return tokenOf(latest);
		}
		await unlink(env, userId, link.version, error.code);
		return null;
	}
	if (await replaceGitHubTokens(env, userId, tokens, link.version, now)) {
		logEvent("github", "token_refreshed", { userId });
		return {
			value: tokens.accessToken,
			expiresAt: tokens.expiresAt,
			version: link.version + 1,
		};
	}
	// 更新している間に、連携し直されたか、消された。保存されている方を使う
	const latest = await loadGitHubLink(env, userId);
	return latest === null ? null : tokenOf(latest);
}

/** 記録が入れ替わるのを、少しの間待つ。入れ替わったら、新しい記録を返す */
async function reloadChanged(
	env: Env,
	userId: string,
	version: number,
): Promise<GitHubLink | null> {
	for (let attempt = 0; attempt < RELOAD_ATTEMPTS; attempt++) {
		await sleep(RELOAD_INTERVAL_MS);
		const latest = await loadGitHubLink(env, userId);
		if (latest === null) {
			return null;
		}
		if (latest.version !== version) {
			return latest;
		}
	}
	return null;
}

/**
 * トークンでGitHubを呼ぶ。断られたら(401)、トークンが取り消されたか、ほかの処理の更新で古くなったので、
 * 読み直すか更新して、もう一度だけ試す。それでも断られたら、外されたとみなして連携を消し、nullを返す
 */
async function withToken<T>(
	env: Env,
	userId: string,
	minValidityMs: number,
	work: (token: GitHubToken) => Promise<T>,
): Promise<{ token: GitHubToken; value: T } | null> {
	const token = await gitHubAccessToken(env, userId, minValidityMs);
	if (token === null) {
		return null;
	}
	try {
		return { token, value: await work(token) };
	} catch (error) {
		if (!isUnauthorized(error)) {
			throw error;
		}
	}
	const link = await loadGitHubLink(env, userId);
	if (link === null) {
		return null;
	}
	const retry =
		link.version === token.version
			? await refresh(env, userId, link, Date.now())
			: tokenOf(link);
	if (retry === null) {
		return null;
	}
	try {
		return { token: retry, value: await work(retry) };
	} catch (error) {
		if (isUnauthorized(error)) {
			await unlink(env, userId, retry.version, "unauthorized");
			return null;
		}
		throw error;
	}
}

/** 本人が許可したリポジトリを探した結果 */
export type RepositoryLookup =
	/** 連携していないか、外されていた */
	| { status: "unlinked" }
	/** 許可されていない。allowedは、許可されたリポジトリ(owner/repo) */
	| { status: "not_allowed"; allowed: string[] }
	| { status: "found"; repository: GitHubRepository; token: GitHubToken };

/**
 * 本人が連携で許可したリポジトリの中から、owner/repoの名前で探す(大文字と小文字は区別しない)。
 * トークンは、残りの有効期間がminValidityMsより短ければ、更新してから返す
 */
export async function findAllowedRepository(
	env: Env,
	userId: string,
	fullName: string,
	minValidityMs: number,
): Promise<RepositoryLookup> {
	const result = await withToken(env, userId, minValidityMs, (token) =>
		allowedRepositories(token.value),
	);
	if (result === null) {
		return { status: "unlinked" };
	}
	if (result.value === null) {
		// アプリがどこにも入っていない(GitHubで外された)
		await unlink(env, userId, result.token.version, "uninstalled");
		return { status: "unlinked" };
	}
	const wanted = fullName.toLowerCase();
	const repository = result.value.find(
		(entry) => entry.fullName.toLowerCase() === wanted,
	);
	return repository === undefined
		? {
				status: "not_allowed",
				allowed: result.value.map((entry) => entry.fullName),
			}
		: { status: "found", repository, token: result.token };
}

/**
 * 本人が連携で許可したリポジトリの名前(owner/repo)。連携していないか、アプリがどこにも入っていなければ空。
 * /agent の欄の候補に使う。アプリが外されていても、ここでは連携の記録を消さない(リポジトリを選んだときに気づく)
 */
export async function listAllowedRepositoryNames(
	env: Env,
	userId: string,
): Promise<string[]> {
	const result = await withToken(env, userId, API_TOKEN_VALIDITY_MS, (token) =>
		allowedRepositories(token.value),
	);
	return result?.value?.map((entry) => entry.fullName) ?? [];
}

/** 本人が許可したリポジトリ。アプリがどこにも入っていなければnull */
async function allowedRepositories(
	token: string,
): Promise<GitHubRepository[] | null> {
	const installations = await listInstallations(token);
	if (installations.length === 0) {
		return null;
	}
	const repositories: GitHubRepository[] = [];
	for (const installation of installations) {
		repositories.push(
			...(await listInstallationRepositories(token, installation.id)),
		);
	}
	return repositories;
}

/** リポジトリに、ブランチがあるか。確かめられなければ(GitHubのエラーなど)、あるものとして扱う */
export async function hasBranch(
	token: string,
	fullName: string,
	branch: string,
): Promise<boolean> {
	try {
		return await branchExists(token, fullName, branch);
	} catch (error) {
		logEvent("github", "branch_check_failed", { error: errorName(error) });
		return true;
	}
}

/** 作るPR */
export interface PullRequestRequest {
	/** owner/repo */
	repository: string;
	head: string;
	base: string;
	title: string;
	body: string;
}

/** PRを作った結果 */
export type PullRequestOutcome =
	| { status: "unlinked" }
	| { status: "created"; url: string }
	/** GitHubに断られた。reasonは、GitHubが返したエラーの説明 */
	| { status: "failed"; reason: string };

/** 本人のトークンで、PRを作る */
export async function openPullRequest(
	env: Env,
	userId: string,
	request: PullRequestRequest,
): Promise<PullRequestOutcome> {
	try {
		const result = await withToken(
			env,
			userId,
			API_TOKEN_VALIDITY_MS,
			(token) =>
				createGitHubPullRequest(token.value, request.repository, {
					title: request.title,
					head: request.head,
					base: request.base,
					body: request.body,
				}),
		);
		if (result === null) {
			return { status: "unlinked" };
		}
		logEvent("github", "pull_request_created", { userId });
		return { status: "created", url: result.value };
	} catch (error) {
		if (error instanceof GitHubApiError) {
			logEvent("github", "pull_request_failed", {
				userId,
				status: error.status,
			});
			return { status: "failed", reason: error.detail };
		}
		throw error;
	}
}

/**
 * GitHubの側でも、Bobertの承認を取り消す(/delete)。アクセストークンが切れていれば、更新してから取り消す。
 * 取り消せなくても(もう取り消されていたなど)、記録はもう消してあるので、記録を残すだけにする
 */
export async function revokeGitHubAuthorization(
	env: Env,
	userId: string,
	link: GitHubLink,
	now = Date.now(),
): Promise<void> {
	try {
		let accessToken = link.accessToken;
		if (link.expiresAt !== null && link.expiresAt <= now) {
			if (link.refreshToken === null) {
				return;
			}
			accessToken = (await refreshGitHubToken(env, link.refreshToken, now))
				.accessToken;
		}
		await revokeGitHubGrant(env, accessToken);
		logEvent("github", "authorization_revoked", { userId });
	} catch (error) {
		logEvent("github", "authorization_revoke_failed", {
			userId,
			error: errorName(error),
		});
	}
}

/** 連携が外されていた。記録を消す(読んだときから入れ替わっていなければ) */
async function unlink(
	env: Env,
	userId: string,
	version: number,
	reason: string,
): Promise<void> {
	if (await deleteGitHubLink(env.DB, userId, version)) {
		logEvent("github", "unlinked", { userId, reason });
	}
}

function tokenOf(link: GitHubLink): GitHubToken {
	return {
		value: link.accessToken,
		expiresAt: link.expiresAt,
		version: link.version,
	};
}

function isUnauthorized(error: unknown): boolean {
	return error instanceof GitHubApiError && error.status === 401;
}

function errorName(error: unknown): string {
	return error instanceof Error ? error.name : "unknown";
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
