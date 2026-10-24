import { decryptSecret, encryptSecret } from "../crypto";

/**
 * ユーザーごとの設定と資格情報(D1)。
 * 仕様: docs/spec/llm-cost.md「資格情報の登録・保存・削除」「ユーザーごとの設定」
 */

export type Provider = "anthropic" | "openrouter";

export interface UserSettings {
	/** NULLなら既定のモデル */
	modelKey: string | null;
	/** その他で入力されたモデルID(modelKeyが "custom" のとき) */
	customModelId: string | null;
	/** NULLならモデルの既定の思考の深さ */
	effort: string | null;
	/** /prompt で設定した自分用の指示 */
	customPrompt: string | null;
	featWebSearch: boolean;
	featUsageDisplay: boolean;
	featImageInput: boolean;
}

/** まだ設定を変えていない人の設定 */
export const DEFAULT_USER_SETTINGS: UserSettings = {
	modelKey: null,
	customModelId: null,
	effort: null,
	customPrompt: null,
	featWebSearch: false,
	featUsageDisplay: false,
	featImageInput: true,
};

interface UserRow {
	model_key: string | null;
	custom_model_id: string | null;
	effort: string | null;
	custom_prompt: string | null;
	feat_web_search: number;
	feat_usage_display: number;
	feat_image_input: number;
}

export async function getUserSettings(
	db: D1Database,
	userId: string,
): Promise<UserSettings> {
	const row = await db
		.prepare(
			`SELECT model_key, custom_model_id, effort, custom_prompt,
				feat_web_search, feat_usage_display, feat_image_input
			FROM users WHERE user_id = ?`,
		)
		.bind(userId)
		.first<UserRow>();
	if (row === null) {
		return DEFAULT_USER_SETTINGS;
	}
	return {
		modelKey: row.model_key,
		customModelId: row.custom_model_id,
		effort: row.effort,
		customPrompt: row.custom_prompt,
		featWebSearch: row.feat_web_search === 1,
		featUsageDisplay: row.feat_usage_display === 1,
		featImageInput: row.feat_image_input === 1,
	};
}

/** 設定の項目と、usersの列 */
const SETTING_COLUMNS = {
	modelKey: "model_key",
	customModelId: "custom_model_id",
	effort: "effort",
	customPrompt: "custom_prompt",
	featWebSearch: "feat_web_search",
	featUsageDisplay: "feat_usage_display",
	featImageInput: "feat_image_input",
} as const satisfies Record<keyof UserSettings, string>;

/** 設定を保存する。渡した項目だけを変える。usersの行がなければ作り、ほかの項目は既定のままにする */
export async function updateUserSettings(
	db: D1Database,
	userId: string,
	changes: Partial<UserSettings>,
	now = Date.now(),
): Promise<void> {
	const keys = (Object.keys(SETTING_COLUMNS) as (keyof UserSettings)[]).filter(
		(key) => changes[key] !== undefined,
	);
	if (keys.length === 0) {
		return;
	}
	// 列の名前はSETTING_COLUMNSのものだけを使う(入力をSQLに入れない)
	const columns = keys.map((key) => SETTING_COLUMNS[key]);
	const values = keys.map((key) => {
		const value = changes[key];
		return typeof value === "boolean" ? Number(value) : (value ?? null);
	});
	await db
		.prepare(
			`INSERT INTO users (user_id, ${columns.join(", ")}, created_at, updated_at)
			VALUES (?, ${columns.map(() => "?").join(", ")}, ?, ?)
			ON CONFLICT (user_id) DO UPDATE SET
				${columns.map((column) => `${column} = excluded.${column}`).join(", ")},
				updated_at = excluded.updated_at`,
		)
		.bind(userId, ...values, now, now)
		.run();
}

/** 資格情報を登録済みのプロバイダ */
export async function getRegisteredProviders(
	db: D1Database,
	userId: string,
): Promise<Set<Provider>> {
	const { results } = await db
		.prepare("SELECT provider FROM credentials WHERE user_id = ?")
		.bind(userId)
		.all<{ provider: Provider }>();
	return new Set(results.map((row) => row.provider));
}

/** 登録した資格情報 */
export interface Credential {
	apiKey: string;
	/**
	 * Anthropicのキーがワークスペースに属さないとき(個人キーなど)に使うワークスペースのID。
	 * リクエストのたびに anthropic-workspace-id ヘッダーで送る。ワークスペースに属するキーではnull
	 */
	workspaceId: string | null;
}

/** 資格情報を保存する。APIキーは暗号化する。登録し直したときは上書きする */
export async function saveCredential(
	env: Env,
	userId: string,
	provider: Provider,
	credential: Credential,
	now = Date.now(),
): Promise<void> {
	const secret = await encryptSecret(
		credential.apiKey,
		credentialOwner(userId, provider),
		env.CREDENTIAL_ENCRYPTION_KEYS,
	);
	await env.DB.prepare(
		`INSERT INTO credentials (user_id, provider, key_version, iv, ciphertext, workspace_id, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (user_id, provider) DO UPDATE SET
			key_version = excluded.key_version,
			iv = excluded.iv,
			ciphertext = excluded.ciphertext,
			workspace_id = excluded.workspace_id,
			updated_at = excluded.updated_at`,
	)
		.bind(
			userId,
			provider,
			secret.keyVersion,
			secret.iv,
			secret.ciphertext,
			credential.workspaceId,
			now,
			now,
		)
		.run();
}

/** 保存した資格情報を、APIキーを復号して返す。登録がなければnull */
export async function loadCredential(
	env: Env,
	userId: string,
	provider: Provider,
): Promise<Credential | null> {
	const row = await env.DB.prepare(
		"SELECT key_version, iv, ciphertext, workspace_id FROM credentials WHERE user_id = ? AND provider = ?",
	)
		.bind(userId, provider)
		.first<{
			key_version: number;
			iv: string;
			ciphertext: string;
			workspace_id: string | null;
		}>();
	if (row === null) {
		return null;
	}
	const apiKey = await decryptSecret(
		{ keyVersion: row.key_version, iv: row.iv, ciphertext: row.ciphertext },
		credentialOwner(userId, provider),
		env.CREDENTIAL_ENCRYPTION_KEYS,
	);
	return { apiKey, workspaceId: row.workspace_id };
}

/** 登録したキーと設定をすべて消す(/delete) */
export async function deleteUserData(
	db: D1Database,
	userId: string,
): Promise<void> {
	await db.batch([
		db.prepare("DELETE FROM credentials WHERE user_id = ?").bind(userId),
		db.prepare("DELETE FROM users WHERE user_id = ?").bind(userId),
		db.prepare("DELETE FROM oauth_states WHERE user_id = ?").bind(userId),
	]);
}

/** 暗号文に結び付ける持ち主。ほかの人やプロバイダの行に移しても復号できないようにする */
function credentialOwner(userId: string, provider: Provider): string {
	return `${userId}:${provider}`;
}
