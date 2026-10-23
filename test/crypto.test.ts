import { describe, expect, it } from "vitest";
import {
	decryptSecret,
	encryptSecret,
	parseEncryptionKeys,
	randomToken,
	sha256Base64Url,
} from "../src/crypto";

// テスト用の鍵(32バイトの "a" と "b" をBase64にしたもの)
const KEY_A = btoa("a".repeat(32));
const KEY_B = btoa("b".repeat(32));

describe("資格情報の暗号化", () => {
	it("暗号化したものを復号できる", async () => {
		const secret = await encryptSecret(
			"sk-ant-test",
			"user-1:anthropic",
			`1:${KEY_A}`,
		);
		expect(secret.keyVersion).toBe(1);
		expect(secret.ciphertext).not.toContain("sk-ant-test");
		expect(await decryptSecret(secret, "user-1:anthropic", `1:${KEY_A}`)).toBe(
			"sk-ant-test",
		);
	});

	it("同じ文字列でも、暗号化するたびに違う暗号文になる", async () => {
		const first = await encryptSecret("sk-ant-test", "owner", `1:${KEY_A}`);
		const second = await encryptSecret("sk-ant-test", "owner", `1:${KEY_A}`);
		expect(first.iv).not.toBe(second.iv);
		expect(first.ciphertext).not.toBe(second.ciphertext);
	});

	it("別の持ち主としては復号できない", async () => {
		const secret = await encryptSecret(
			"sk-ant-test",
			"user-1:anthropic",
			`1:${KEY_A}`,
		);
		await expect(
			decryptSecret(secret, "user-2:anthropic", `1:${KEY_A}`),
		).rejects.toThrow();
	});

	it("鍵を入れ替えても、古い鍵で暗号化したものを復号でき、新しく暗号化するときは新しい鍵を使う", async () => {
		const old = await encryptSecret("sk-old", "owner", `1:${KEY_A}`);
		const keys = `1:${KEY_A},2:${KEY_B}`;
		expect(await decryptSecret(old, "owner", keys)).toBe("sk-old");
		const renewed = await encryptSecret("sk-new", "owner", keys);
		expect(renewed.keyVersion).toBe(2);
		expect(await decryptSecret(renewed, "owner", keys)).toBe("sk-new");
	});

	it("鍵の書き方が正しくなければ、鍵の中身を含めずにエラーにする", () => {
		expect(() => parseEncryptionKeys("")).toThrow(
			"CREDENTIAL_ENCRYPTION_KEYS is empty",
		);
		expect(() => parseEncryptionKeys(KEY_A)).toThrow(
			"CREDENTIAL_ENCRYPTION_KEYS is malformed",
		);
		expect(() => parseEncryptionKeys(`1:${btoa("short")}`)).toThrow(
			"CREDENTIAL_ENCRYPTION_KEYS is malformed",
		);
		expect(() => parseEncryptionKeys(`1:${KEY_A}`)).not.toThrow();
	});
});

describe("ランダムな文字列とハッシュ", () => {
	it("URLに入れられる文字だけのランダムな文字列を作る", () => {
		const token = randomToken();
		expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(randomToken()).not.toBe(token);
	});

	it("SHA-256をURL用のBase64にする(PKCEのcode_challenge)", async () => {
		// RFC 7636 の付録Bの例
		expect(
			await sha256Base64Url("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
		).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
	});
});
