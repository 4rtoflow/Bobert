import { overwriteGlobalCommands } from "./discord/api";
import { GATEWAY_LOCATION_HINT, GATEWAY_OBJECT_NAME } from "./gateway/protocol";
import { COMMANDS } from "./interactions/commands";
import type { QueueMessage } from "./queue/messages";
import { unembeddedKnowledgeFileIds } from "./store/knowledge";

/** 知識のファイルのベクトルの入れ直しで、1回に仕事を入れるファイルの数。多ければ、もう一度呼ぶ */
const KNOWLEDGE_REINDEX_BATCH = 1_000;

/**
 * 管理用エンドポイント。ADMIN_TOKENで保護する。
 * - POST /admin/gateway/start: Gatewayへの接続を始める
 * - POST /admin/gateway/stop: Gatewayへの接続を止める
 * - GET /admin/gateway/status: 接続の状態を返す
 * - POST /admin/commands/register: スラッシュコマンドをDiscordに登録する(一覧で丸ごと置き換える)。
 *   返事には、登録したWorkerの版のIDを入れる。デプロイの直後は古い版が応答することがあるため、
 *   自動デプロイ(.github/workflows/deploy.yml)は、これがデプロイした版と同じになるまで登録をやり直す
 * - POST /admin/vectors/reindex: 保存したメッセージのベクトルを、全部入れ直す(メタデータを足したときなど)
 * - POST /admin/knowledge/reindex: 知識に入ったのに、まだベクトルにしていない知識のファイル(中を探す道具を入れる前に
 *   入ったものなど)を、ベクトルにする仕事を入れる。1回で1000件まで。返事のfilesが1000なら、もう一度呼ぶ
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
	if (
		request.method === "POST" &&
		url.pathname === "/admin/commands/register"
	) {
		const registered = await overwriteGlobalCommands(
			env.DISCORD_APPLICATION_ID,
			env.DISCORD_BOT_TOKEN,
			COMMANDS,
		);
		return Response.json({
			ok: true,
			commands: registered.map((command) => command.name),
			version: env.CF_VERSION_METADATA.id,
		});
	}
	if (
		request.method === "POST" &&
		url.pathname === "/admin/knowledge/reindex"
	) {
		const ids = await unembeddedKnowledgeFileIds(
			env.DB,
			KNOWLEDGE_REINDEX_BATCH,
		);
		// Queueに1回で入れられるのは、100件まで
		for (let i = 0; i < ids.length; i += 100) {
			await env.RESPOND_QUEUE.sendBatch(
				ids.slice(i, i + 100).map((fileId) => ({
					body: { kind: "knowledge", fileId } satisfies QueueMessage,
				})),
			);
		}
		return Response.json({ ok: true, files: ids.length });
	}
	if (request.method === "POST" && url.pathname === "/admin/vectors/reindex") {
		await env.INGEST_QUEUE.send({
			kind: "reindex",
			after: null,
		} satisfies QueueMessage);
		return Response.json({ ok: true });
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
