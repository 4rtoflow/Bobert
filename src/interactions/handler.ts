import type { APIInteraction } from "discord-api-types/v10";
import {
	InteractionResponseType,
	InteractionType,
	MessageFlags,
} from "../discord/constants";
import { verifyDiscordRequest } from "./verify";

/**
 * Discord Interactions(スラッシュコマンド、モーダル、右クリックメニュー)の受け口。
 * 最初の応答は3秒以内に返す必要がある。
 *
 * これから実装すること(仕様: docs/spec/behavior.md「スラッシュコマンド」):
 * /setup、/model、/effort、/feat、/prompt、/settings、/compact、/delete、/help と、
 * 右クリックメニューの「Bobertに聞く」
 */
export async function handleInteraction(
	request: Request,
	env: Env,
): Promise<Response> {
	const body = await verifyDiscordRequest(request, env.DISCORD_PUBLIC_KEY);
	if (body === null) {
		return new Response("Bad request signature", { status: 401 });
	}

	const interaction = JSON.parse(body) as APIInteraction;
	if (interaction.type === InteractionType.Ping) {
		return Response.json({ type: InteractionResponseType.Pong });
	}

	// TODO: コマンドごとの処理
	return Response.json({
		type: InteractionResponseType.ChannelMessageWithSource,
		data: {
			content: "この機能はまだ準備中です。",
			flags: MessageFlags.Ephemeral,
		},
	});
}
