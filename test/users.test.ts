import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_USER_SETTINGS,
	getUserSettings,
	updateUserSettings,
} from "../src/store/users";

describe("ユーザーごとの設定", () => {
	it("行がなければ作り、渡した項目だけを変える", async () => {
		const userId = "400";

		await updateUserSettings(env.DB, userId, { modelKey: "gpt-6-luna" });
		expect(await getUserSettings(env.DB, userId)).toEqual({
			...DEFAULT_USER_SETTINGS,
			modelKey: "gpt-6-luna",
		});

		await updateUserSettings(env.DB, userId, {
			customModelId: "x-ai/grok-4.7-mini",
			featWebSearch: true,
		});
		expect(await getUserSettings(env.DB, userId)).toEqual({
			...DEFAULT_USER_SETTINGS,
			modelKey: "gpt-6-luna",
			customModelId: "x-ai/grok-4.7-mini",
			featWebSearch: true,
		});

		// nullを渡せば、空に戻す
		await updateUserSettings(env.DB, userId, { customModelId: null });
		expect((await getUserSettings(env.DB, userId)).customModelId).toBeNull();
	});
});
