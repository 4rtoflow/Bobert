import { decryptSecret, encryptSecret } from "../crypto";

/**
 * GitHubとの連携の記録(D1)。仕様: docs/spec/llm-cost.md「資格情報の登録・保存・削除」
 * - github_links: 本人のトークン(APIキーと同じ鍵で暗号化する)
 * - github_link_states: 連携のリンクの途中の状態
 */

/** GitHubのトークン(Bobert用のGitHub Appで、本人に代わって操作するもの) */
export interface GitHubTokens {
	/** ユーザーアクセストークン(ghu_で始まる) */
	accessToken: string;
	/** 更新用のトークン(ghr_で始まる)。期限のないトークンならnull */
	refreshToken: string | null;
	/** アクセストークンの有効期限(ミリ秒)。期限がなければnull */
	expiresAt: number | null;
	/** 更新用のトークンの有効期限(ミリ秒)。分からなければnull */
	refreshExpiresAt: number | null;
}

/** 保存した連携 */
export interface GitHubLink extends GitHubTokens {
	/** トークンを入れ替えるたびに増える番号 */
	version: number;
}

/** 暗号化して保存する中身 */
interface SecretPayload {
	access_token: string;
	refresh_token: string | null;
}

interface GitHubLinkRow {
	key_version: number;
	iv: string;
	ciphertext: string;
	expires_at: number | null;
	refresh_expires_at: number | null;
	version: number;
}

/** 連携を保存する(連携し直したときは上書きする) */
export async function saveGitHubLink(
	env: Env,
	userId: string,
	tokens: GitHubTokens,
	now = Date.now(),
): Promise<void> {
	const secret = await encryptTokens(env, userId, tokens);
	await env.DB.prepare(
		`INSERT INTO github_links (user_id, key_version, iv, ciphertext, expires_at, refresh_expires_at, version, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
		ON CONFLICT (user_id) DO UPDATE SET
			key_version = excluded.key_version,
			iv = excluded.iv,
			ciphertext = excluded.ciphertext,
			expires_at = excluded.expires_at,
			refresh_expires_at = excluded.refresh_expires_at,
			version = github_links.version + 1,
			updated_at = excluded.updated_at`,
	)
		.bind(
			userId,
			secret.keyVersion,
			secret.iv,
			secret.ciphertext,
			tokens.expiresAt,
			tokens.refreshExpiresAt,
			now,
			now,
		)
		.run();
}

/**
 * 更新したトークンで入れ替える。読んだときから、ほかの処理が入れ替えていなければ入れ替えて、trueを返す
 * (同時に更新したときに、ほかの処理が入れ替えたトークンを上書きしないため)
 */
export async function replaceGitHubTokens(
	env: Env,
	userId: string,
	tokens: GitHubTokens,
	expectedVersion: number,
	now = Date.now(),
): Promise<boolean> {
	const secret = await encryptTokens(env, userId, tokens);
	const result = await env.DB.prepare(
		`UPDATE github_links SET key_version = ?, iv = ?, ciphertext = ?, expires_at = ?, refresh_expires_at = ?,
			version = version + 1, updated_at = ?
		WHERE user_id = ? AND version = ?`,
	)
		.bind(
			secret.keyVersion,
			secret.iv,
			secret.ciphertext,
			tokens.expiresAt,
			tokens.refreshExpiresAt,
			now,
			userId,
			expectedVersion,
		)
		.run();
	return result.meta.changes > 0;
}

/** 保存した連携を、トークンを復号して返す。連携していなければnull */
export async function loadGitHubLink(
	env: Env,
	userId: string,
): Promise<GitHubLink | null> {
	const row = await env.DB.prepare(
		`SELECT key_version, iv, ciphertext, expires_at, refresh_expires_at, version
		FROM github_links WHERE user_id = ?`,
	)
		.bind(userId)
		.first<GitHubLinkRow>();
	if (row === null) {
		return null;
	}
	const payload = JSON.parse(
		await decryptSecret(
			{ keyVersion: row.key_version, iv: row.iv, ciphertext: row.ciphertext },
			secretOwner(userId),
			env.CREDENTIAL_ENCRYPTION_KEYS,
		),
	) as SecretPayload;
	return {
		accessToken: payload.access_token,
		refreshToken: payload.refresh_token,
		expiresAt: row.expires_at,
		refreshExpiresAt: row.refresh_expires_at,
		version: row.version,
	};
}

/** 連携しているか(トークンを復号せずに確かめる) */
export async function hasGitHubLink(
	db: D1Database,
	userId: string,
): Promise<boolean> {
	const row = await db
		.prepare("SELECT 1 AS found FROM github_links WHERE user_id = ?")
		.bind(userId)
		.first<{ found: number }>();
	return row !== null;
}

/**
 * 連携を消す。versionを渡したときは、読んだときから入れ替わっていない場合だけ消す
 * (ほかの処理が更新したばかりのトークンを消さないため)。消したらtrue
 */
export async function deleteGitHubLink(
	db: D1Database,
	userId: string,
	version?: number,
): Promise<boolean> {
	const result =
		version === undefined
			? await db
					.prepare("DELETE FROM github_links WHERE user_id = ?")
					.bind(userId)
					.run()
			: await db
					.prepare("DELETE FROM github_links WHERE user_id = ? AND version = ?")
					.bind(userId, version)
					.run();
	return result.meta.changes > 0;
}

/**
 * 連携のリンクの、どこまで進んだか。
 * - authorize: リンクの先の、承認の画面から戻るのを待っている
 * - install: 承認したが、まだアプリを入れていなかったので、アプリを入れる画面(触らせるリポジトリを選ぶ画面)へ進めた
 */
export type GitHubLinkStage = "authorize" | "install";

/**
 * 「GitHubと連携」を押した場面。
 * - agent: /agent の返事から。連携できたら、同じメッセージを、リポジトリを選ぶセレクトメニューに書き換える
 * - link: エージェントのチャンネルでの知らせなどから。連携できたら、「GitHubと連携しました。」とだけ書く
 */
export type GitHubLinkPurpose = "agent" | "link";

/** 連携のリンクの途中の状態 */
export interface GitHubLinkState {
	/** 「GitHubと連携」を押した人 */
	userId: string;
	/** ボタンへの返事(本人にだけ見える)のInteractionのトークン。連携できたら、この返事を書き換える */
	interactionToken: string;
	stage: GitHubLinkStage;
	purpose: GitHubLinkPurpose;
	/** 承認の画面のPKCEのcode_verifier。アプリを入れる画面からの戻りではnull */
	codeVerifier: string | null;
	expiresAt: number;
	createdAt: number;
}

/** 連携のリンクの状態を保存する。ついでに期限切れの行を消す */
export async function saveGitHubLinkState(
	db: D1Database,
	state: string,
	value: GitHubLinkState,
	now = Date.now(),
): Promise<void> {
	await db.batch([
		db.prepare("DELETE FROM github_link_states WHERE expires_at < ?").bind(now),
		db
			.prepare(
				`INSERT INTO github_link_states (state, user_id, interaction_token, stage, purpose, code_verifier, expires_at, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				state,
				value.userId,
				value.interactionToken,
				value.stage,
				value.purpose,
				value.codeVerifier,
				value.expiresAt,
				value.createdAt,
			),
	]);
}

/** 保存した状態を取り出して消す(1回しか使えない)。見つからないか期限切れならnull */
export async function takeGitHubLinkState(
	db: D1Database,
	state: string,
	now = Date.now(),
): Promise<GitHubLinkState | null> {
	const row = await db
		.prepare(
			`DELETE FROM github_link_states WHERE state = ?
			RETURNING user_id, interaction_token, stage, purpose, code_verifier, expires_at, created_at`,
		)
		.bind(state)
		.first<{
			user_id: string;
			interaction_token: string;
			stage: GitHubLinkStage;
			purpose: GitHubLinkPurpose;
			code_verifier: string | null;
			expires_at: number;
			created_at: number;
		}>();
	if (row === null || row.expires_at < now) {
		return null;
	}
	return {
		userId: row.user_id,
		interactionToken: row.interaction_token,
		stage: row.stage,
		purpose: row.purpose,
		codeVerifier: row.code_verifier,
		expiresAt: row.expires_at,
		createdAt: row.created_at,
	};
}

function encryptTokens(env: Env, userId: string, tokens: GitHubTokens) {
	const payload: SecretPayload = {
		access_token: tokens.accessToken,
		refresh_token: tokens.refreshToken,
	};
	return encryptSecret(
		JSON.stringify(payload),
		secretOwner(userId),
		env.CREDENTIAL_ENCRYPTION_KEYS,
	);
}

/** 暗号文に結び付ける持ち主。ほかの人の行や、APIキーの行に移しても復号できないようにする */
function secretOwner(userId: string): string {
	return `${userId}:github`;
}
