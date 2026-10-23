import { vi } from "vitest";

// テスト専用の秘密鍵(本物の秘密ではない)。
// 対になる公開鍵は vitest.config.ts の DISCORD_PUBLIC_KEY に入れてある。
const TEST_PRIVATE_KEY_PKCS8_BASE64 =
	"MC4CAQAwBQYDK2VwBCIEIDCm1PDxudFKdgOb5AdVwFP3XmMqU9X48Eg+6hhgNNds";

/** Discordから届くのと同じ形の、署名付きのInteractionsのリクエストを作る */
export async function signedInteractionRequest(
	payload: unknown,
	options: { tamper?: boolean } = {},
): Promise<Request> {
	const body = JSON.stringify(payload);
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

/** 偽のfetchが受け取ったリクエスト */
export interface FetchCall {
	method: string;
	url: URL;
	headers: Headers;
	/** JSONなら読んだもの、それ以外は文字列 */
	body: unknown;
}

/**
 * fetchを偽物に置き換える。呼び出しを記録し、handlerの返す応答を返す。
 * テストの中のWorkerのコードも同じ実行環境で動くので、Workerからの外向きの通信も置き換わる。
 */
export function mockFetch(
	handler: (call: FetchCall) => Response | Promise<Response>,
): FetchCall[] {
	const calls: FetchCall[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const request = new Request(input, init);
		const text = await request.text();
		const call: FetchCall = {
			method: request.method,
			url: new URL(request.url),
			headers: request.headers,
			body: parseBody(text),
		};
		calls.push(call);
		return handler(call);
	});
	return calls;
}

function parseBody(text: string): unknown {
	if (text === "") {
		return null;
	}
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

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
