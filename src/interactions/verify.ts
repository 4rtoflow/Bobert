/**
 * Discordから届いたInteractionの署名(Ed25519)を確かめる。
 * 正しければリクエストの本文を、正しくなければnullを返す。
 */
export async function verifyDiscordRequest(
	request: Request,
	publicKeyHex: string,
): Promise<string | null> {
	const signature = request.headers.get("X-Signature-Ed25519");
	const timestamp = request.headers.get("X-Signature-Timestamp");
	const body = await request.text();
	if (!signature || !timestamp) {
		return null;
	}

	try {
		const key = await crypto.subtle.importKey(
			"raw",
			hexToBytes(publicKeyHex),
			{ name: "Ed25519" },
			false,
			["verify"],
		);
		const valid = await crypto.subtle.verify(
			{ name: "Ed25519" },
			key,
			hexToBytes(signature),
			new TextEncoder().encode(timestamp + body),
		);
		return valid ? body : null;
	} catch {
		// 鍵や署名の形式が不正な場合も、署名が正しくないものとして扱う
		return null;
	}
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
	if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) {
		throw new Error("Invalid hex string");
	}
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < bytes.length; i++) {
		bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	}
	return bytes;
}
