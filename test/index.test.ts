import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DISCORD_API_BASE } from "../src/discord/api";
import { COMMANDS } from "../src/interactions/commands";
import { mockFetch } from "./helpers";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("Worker", () => {
	it("知らないパスには404を返す", async () => {
		const response = await exports.default.fetch(
			"https://bobert.example/unknown",
		);
		expect(response.status).toBe(404);
	});

	it("管理用エンドポイントは、トークンがないと401を返す", async () => {
		const response = await exports.default.fetch(
			"https://bobert.example/admin/gateway/status",
		);
		expect(response.status).toBe(401);
	});

	it("管理用エンドポイントは、トークンが違うと401を返す", async () => {
		const response = await exports.default.fetch(
			"https://bobert.example/admin/gateway/status",
			{ headers: { Authorization: "Bearer wrong-token" } },
		);
		expect(response.status).toBe(401);
	});

	it("管理用エンドポイントで、Gatewayを止められる", async () => {
		const response = await exports.default.fetch(
			"https://bobert.example/admin/gateway/stop",
			{ method: "POST", headers: { Authorization: "Bearer test-admin-token" } },
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
	});

	it("管理用エンドポイントは、正しいトークンなら状態を返す", async () => {
		const response = await exports.default.fetch(
			"https://bobert.example/admin/gateway/status",
			{ headers: { Authorization: "Bearer test-admin-token" } },
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ started: false });
	});

	it("管理用エンドポイントで、コマンドを登録すると、登録した名前と、Workerの版のIDを返す", async () => {
		// Discordは、受け取った一覧に、IDを付けて返す
		const calls = mockFetch((call) =>
			Response.json(
				(call.body as { name: string }[]).map((command, index) => ({
					...command,
					id: String(index),
				})),
			),
		);

		const response = await exports.default.fetch(
			"https://bobert.example/admin/commands/register",
			{ method: "POST", headers: { Authorization: "Bearer test-admin-token" } },
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			ok: true,
			commands: COMMANDS.map((command) => command.name),
			version: env.CF_VERSION_METADATA.id,
		});
		expect(env.CF_VERSION_METADATA.id).not.toBe("");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.method).toBe("PUT");
		expect(calls[0]?.url.href).toBe(
			`${DISCORD_API_BASE}/applications/${env.DISCORD_APPLICATION_ID}/commands`,
		);
	});
});
