import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

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
});
