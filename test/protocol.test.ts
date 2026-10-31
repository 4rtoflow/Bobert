import { describe, expect, it } from "vitest";
import { GatewayIntentBits } from "../src/discord/constants";
import { BOBERT_INTENTS, isFatalCloseCode } from "../src/gateway/protocol";

describe("Gatewayの設定", () => {
	it("Message Contentインテントを必ず含む", () => {
		expect(BOBERT_INTENTS & GatewayIntentBits.MessageContent).toBe(
			GatewayIntentBits.MessageContent,
		);
	});

	it("リアクションの付け外しを受け取る。特権インテントのServer Membersは含まない", () => {
		expect(BOBERT_INTENTS & GatewayIntentBits.GuildMessageReactions).toBe(
			GatewayIntentBits.GuildMessageReactions,
		);
		// Server Members(2)は、メンバーの一覧をAPIで読むために、Developer Portalで有効にするだけ
		expect(BOBERT_INTENTS & 2).toBe(0);
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
