import { describe, expect, it } from "vitest";
import { GatewayIntentBits } from "../src/discord/constants";
import { BOBERT_INTENTS, isFatalCloseCode } from "../src/gateway/protocol";

describe("Gatewayの設定", () => {
	it("Message Contentインテントを必ず含む", () => {
		expect(BOBERT_INTENTS & GatewayIntentBits.MessageContent).toBe(
			GatewayIntentBits.MessageContent,
		);
	});

	it("設定の誤りを表す切断コードでは再接続しない", () => {
		for (const code of [4004, 4010, 4011, 4012, 4013, 4014]) {
			expect(isFatalCloseCode(code)).toBe(true);
		}
		for (const code of [1000, 4000, 4007, 4009]) {
			expect(isFatalCloseCode(code)).toBe(false);
		}
	});
});
