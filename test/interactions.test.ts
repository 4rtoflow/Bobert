import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
	InteractionResponseType,
	InteractionType,
} from "../src/discord/constants";

// テスト専用の秘密鍵(本物の秘密ではない)。
// 対になる公開鍵は vitest.config.ts の DISCORD_PUBLIC_KEY に入れてある。
const TEST_PRIVATE_KEY_PKCS8_BASE64 =
	"MC4CAQAwBQYDK2VwBCIEIDCm1PDxudFKdgOb5AdVwFP3XmMqU9X48Eg+6hhgNNds";

async function signedRequest(
	body: string,
	options: { tamper?: boolean } = {},
): Promise<Request> {
	const key = await crypto.subtle.importKey(
		"pkcs8",
		base64ToBytes(TEST_PRIVATE_KEY_PKCS8_BASE64),
		{ name: "Ed25519" },
		false,
		["sign"],
	);
	const timestamp = String(Math.floor(Date.now() / 1000));
	const signature = new Uint8Array(
		await crypto.subtle.sign(
			{ name: "Ed25519" },
			key,
			new TextEncoder().encode(timestamp + body),
		),
	);
	return new Request("https://bobert.example/interactions", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-Signature-Ed25519": bytesToHex(signature),
			"X-Signature-Timestamp": timestamp,
		},
		// 署名の後に本文を書き換えて、改ざんされたリクエストを作る
		body: options.tamper ? `${body} ` : body,
	});
}

describe("Interactionsの受け口", () => {
	it("正しい署名のPINGにはPONGを返す", async () => {
		const request = await signedRequest(
			JSON.stringify({ type: InteractionType.Ping }),
		);
		const response = await exports.default.fetch(request);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			type: InteractionResponseType.Pong,
		});
	});

	it("署名が合わなければ401を返す", async () => {
		const request = await signedRequest(
			JSON.stringify({ type: InteractionType.Ping }),
			{ tamper: true },
		);
		const response = await exports.default.fetch(request);
		expect(response.status).toBe(401);
	});

	it("署名のヘッダーがなければ401を返す", async () => {
		const response = await exports.default.fetch(
			new Request("https://bobert.example/interactions", {
				method: "POST",
				body: JSON.stringify({ type: InteractionType.Ping }),
			}),
		);
		expect(response.status).toBe(401);
	});
});

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
		"",
	);
}
