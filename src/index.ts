/**
 * Bobertのエントリポイント。
 * - fetch: Discord Interactions、OpenRouterのOAuthコールバック、管理用エンドポイント
 * - queue: 応答の生成(LLMの呼び出し)と、メッセージの保存・ベクトル化
 *
 * 構成の仕様: docs/spec/architecture.md
 */
import { handleAdminRequest } from "./admin";
import { handleInteraction } from "./interactions/handler";
import { handleOpenRouterCallback } from "./oauth/openrouter";
import { handleQueueBatch } from "./queue/consumer";
import type { QueueMessage } from "./queue/messages";

export { Gateway } from "./gateway/gateway";

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);
		if (request.method === "POST" && url.pathname === "/interactions") {
			return handleInteraction(request, env);
		}
		if (
			request.method === "GET" &&
			url.pathname === "/oauth/openrouter/callback"
		) {
			return handleOpenRouterCallback(request, env);
		}
		if (url.pathname.startsWith("/admin/")) {
			return handleAdminRequest(request, env);
		}
		return new Response("Not Found", { status: 404 });
	},

	async queue(batch, env): Promise<void> {
		await handleQueueBatch(batch, env);
	},
} satisfies ExportedHandler<Env, QueueMessage>;
