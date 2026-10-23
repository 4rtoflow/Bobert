/** OpenRouterとの連携(OAuth PKCE)の途中の状態(D1のoauth_statesテーブル) */
export interface OAuthState {
	/** /setup を実行した人 */
	userId: string;
	codeVerifier: string;
}

/** 連携のリンクを作るときに保存する。ついでに期限切れの行を消す */
export async function saveOAuthState(
	db: D1Database,
	state: string,
	value: OAuthState,
	expiresAt: number,
	now = Date.now(),
): Promise<void> {
	await db.batch([
		db.prepare("DELETE FROM oauth_states WHERE expires_at < ?").bind(now),
		db
			.prepare(
				"INSERT INTO oauth_states (state, user_id, code_verifier, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
			)
			.bind(state, value.userId, value.codeVerifier, expiresAt, now),
	]);
}

/** 保存した状態を取り出して消す(1回しか使えない)。見つからないか期限切れならnull */
export async function takeOAuthState(
	db: D1Database,
	state: string,
	now = Date.now(),
): Promise<OAuthState | null> {
	const row = await db
		.prepare(
			"DELETE FROM oauth_states WHERE state = ? RETURNING user_id, code_verifier, expires_at",
		)
		.bind(state)
		.first<{ user_id: string; code_verifier: string; expires_at: number }>();
	if (row === null || row.expires_at < now) {
		return null;
	}
	return { userId: row.user_id, codeVerifier: row.code_verifier };
}
