import { decryptSecret, encryptSecret } from "../crypto";

/**
 * TypeSafeのAPIキー(D1)。右クリックメニューの「Jevに聞く」で、本人のJevの呼び出しにだけ使う。
 * AIのキーと同じく、Workerのシークレットにある鍵で暗号化して保存する
 * (仕様: docs/spec/llm-cost.md「資格情報の登録・保存・削除」)。
 * /delete では、ほかのキーと一緒に消す(store/users.tsのdeleteUserData)
 */

/** TypeSafeのキーを保存する。登録し直したときは上書きする */
export async function saveTypeSafeKey(
	env: Env,
	userId: string,
	apiKey: string,
	now = Date.now(),
): Promise<void> {
	const secret = await encryptSecret(
		apiKey,
		owner(userId),
		env.CREDENTIAL_ENCRYPTION_KEYS,
	);
	await env.DB.prepare(
		`INSERT INTO typesafe_credentials (user_id, key_version, iv, ciphertext, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT (user_id) DO UPDATE SET
			key_version = excluded.key_version,
			iv = excluded.iv,
			ciphertext = excluded.ciphertext,
			updated_at = excluded.updated_at`,
	)
		.bind(userId, secret.keyVersion, secret.iv, secret.ciphertext, now, now)
		.run();
}

/** 保存したTypeSafeのキーを、復号して返す。登録がなければnull */
export async function loadTypeSafeKey(
	env: Env,
	userId: string,
): Promise<string | null> {
	const row = await env.DB.prepare(
		"SELECT key_version, iv, ciphertext FROM typesafe_credentials WHERE user_id = ?",
	)
		.bind(userId)
		.first<{ key_version: number; iv: string; ciphertext: string }>();
	if (row === null) {
		return null;
	}
	return decryptSecret(
		{ keyVersion: row.key_version, iv: row.iv, ciphertext: row.ciphertext },
		owner(userId),
		env.CREDENTIAL_ENCRYPTION_KEYS,
	);
}

/** TypeSafeのキーを登録しているか */
export async function hasTypeSafeKey(
	db: D1Database,
	userId: string,
): Promise<boolean> {
	const row = await db
		.prepare("SELECT 1 AS found FROM typesafe_credentials WHERE user_id = ?")
		.bind(userId)
		.first<{ found: number }>();
	return row !== null;
}

/** 暗号文に結び付ける持ち主。AIのキー(store/users.ts)と同じく「ユーザーID:プロバイダ」にする */
function owner(userId: string): string {
	return `${userId}:typesafe`;
}
