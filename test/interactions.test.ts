import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
	InteractionResponseType,
	InteractionType,
} from "../src/discord/constants";
import { signedInteractionRequest } from "./helpers";

describe("Interactionsの受け口", () => {
	it("正しい署名のPINGにはPONGを返す", async () => {
		const request = await signedInteractionRequest({
			type: InteractionType.Ping,
		});
		const response = await exports.default.fetch(request);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			type: InteractionResponseType.Pong,
		});
	});

	it("署名が合わなければ401を返す", async () => {
		const request = await signedInteractionRequest(
			{ type: InteractionType.Ping },
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
