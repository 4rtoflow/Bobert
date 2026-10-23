import { GATEWAY_LOCATION_HINT, GATEWAY_OBJECT_NAME } from "./gateway/protocol";

/**
 * 管理用エンドポイント。ADMIN_TOKENで保護する。
 * - POST /admin/gateway/start: Gatewayへの接続を始める
 * - POST /admin/gateway/stop: Gatewayへの接続を止める
 * - GET /admin/gateway/status: 接続の状態を返す
 */
export async function handleAdminRequest(
	request: Request,
	env: Env,
): Promise<Response> {
	if (!isAuthorized(request, env.ADMIN_TOKEN)) {
		return new Response("Unauthorized", { status: 401 });
	}

	const gateway = env.GATEWAY.get(env.GATEWAY.idFromName(GATEWAY_OBJECT_NAME), {
		locationHint: GATEWAY_LOCATION_HINT,
	});
	const url = new URL(request.url);

	if (request.method === "POST" && url.pathname === "/admin/gateway/start") {
		await gateway.start();
		return Response.json({ ok: true });
	}
	if (request.method === "POST" && url.pathname === "/admin/gateway/stop") {
		await gateway.stop();
		return Response.json({ ok: true });
	}
	if (request.method === "GET" && url.pathname === "/admin/gateway/status") {
		return Response.json(await gateway.status());
	}
	return new Response("Not Found", { status: 404 });
}

function isAuthorized(request: Request, token: string): boolean {
	if (!token) {
		return false;
	}
	const encoder = new TextEncoder();
	const actual = encoder.encode(request.headers.get("Authorization") ?? "");
	const expected = encoder.encode(`Bearer ${token}`);
	// 比較にかかる時間から中身を推測されないよう、一定時間で比較する
	return (
		actual.byteLength === expected.byteLength &&
		crypto.subtle.timingSafeEqual(actual, expected)
	);
}
