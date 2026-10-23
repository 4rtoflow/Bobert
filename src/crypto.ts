/**
 * 暗号まわりの小さな道具。
 * 資格情報(APIキー)の暗号化の仕様: docs/spec/llm-cost.md「資格情報の登録・保存・削除」
 */

/** 暗号化した資格情報(D1のcredentialsテーブルの1行分) */
export interface EncryptedSecret {
	/** 暗号化に使った鍵の番号 */
	keyVersion: number;
	/** AES-GCMの初期化ベクトル(Base64) */
	iv: string;
	/** 暗号文(Base64) */
	ciphertext: string;
}

/**
 * 秘密の文字列を暗号化する。
 * - 鍵は CREDENTIAL_ENCRYPTION_KEYS(「番号:鍵」のカンマ区切り)のうち、番号が最大のものを使う
 * - ownerを暗号文に結び付ける。別の持ち主の行に暗号文を移しても、復号できない
 */
export async function encryptSecret(
	plaintext: string,
	owner: string,
	keysSpec: string,
): Promise<EncryptedSecret> {
	const keys = parseEncryptionKeys(keysSpec);
	const keyVersion = Math.max(...keys.keys());
	const key = await importKey(keys, keyVersion);
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ciphertext = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv, additionalData: encode(owner) },
		key,
		encode(plaintext),
	);
	return {
		keyVersion,
		iv: toBase64(iv),
		ciphertext: toBase64(new Uint8Array(ciphertext)),
	};
}

/** encryptSecretで暗号化したものを、保存時の番号の鍵で復号する */
export async function decryptSecret(
	secret: EncryptedSecret,
	owner: string,
	keysSpec: string,
): Promise<string> {
	const keys = parseEncryptionKeys(keysSpec);
	const key = await importKey(keys, secret.keyVersion);
	const plaintext = await crypto.subtle.decrypt(
		{
			name: "AES-GCM",
			iv: fromBase64(secret.iv),
			additionalData: encode(owner),
		},
		key,
		fromBase64(secret.ciphertext),
	);
	return new TextDecoder().decode(plaintext);
}

/** 「番号:鍵」のカンマ区切りを読む。鍵は32バイト(AES-256)をBase64にしたもの */
export function parseEncryptionKeys(
	spec: string,
): Map<number, Uint8Array<ArrayBuffer>> {
	const keys = new Map<number, Uint8Array<ArrayBuffer>>();
	for (const entry of spec.split(",")) {
		const trimmed = entry.trim();
		if (trimmed === "") {
			continue;
		}
		const separator = trimmed.indexOf(":");
		const version = Number(trimmed.slice(0, separator));
		const raw = tryFromBase64(trimmed.slice(separator + 1));
		// 鍵の中身はエラーに含めない
		if (
			separator <= 0 ||
			!Number.isInteger(version) ||
			version < 1 ||
			raw?.byteLength !== 32
		) {
			throw new Error("CREDENTIAL_ENCRYPTION_KEYS is malformed");
		}
		keys.set(version, raw);
	}
	if (keys.size === 0) {
		throw new Error("CREDENTIAL_ENCRYPTION_KEYS is empty");
	}
	return keys;
}

/** 推測できないランダムな文字列(URLに入れられる形) */
export function randomToken(byteLength = 32): string {
	return toBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

/** SHA-256のハッシュを、URLに入れられるBase64にする(OAuthのPKCEで使う) */
export async function sha256Base64Url(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", encode(text));
	return toBase64Url(new Uint8Array(digest));
}

async function importKey(
	keys: Map<number, Uint8Array<ArrayBuffer>>,
	version: number,
): Promise<CryptoKey> {
	const raw = keys.get(version);
	if (!raw) {
		throw new Error(`Encryption key version ${version} is not configured`);
	}
	return crypto.subtle.importKey("raw", raw, "AES-GCM", false, [
		"encrypt",
		"decrypt",
	]);
}

function encode(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary);
}

function toBase64Url(bytes: Uint8Array): string {
	return toBase64(bytes)
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
	const binary = atob(text);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

function tryFromBase64(text: string): Uint8Array<ArrayBuffer> | null {
	try {
		return fromBase64(text);
	} catch {
		return null;
	}
}
