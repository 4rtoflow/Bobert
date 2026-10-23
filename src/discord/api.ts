import type { RESTGetAPIGatewayBotResult } from "discord-api-types/v10";

export const DISCORD_API_BASE = "https://discord.com/api/v10";

/** DiscordのAPIに送るUser-Agent。Botは「DiscordBot (URL, バージョン)」の形式にする */
export const USER_AGENT =
	"DiscordBot (https://github.com/4rtoflow/Bobert, 0.1.0)";

/** Gatewayの接続先URLと、新規接続(Identify)の残り回数を取得する */
export async function getGatewayBot(
	botToken: string,
): Promise<RESTGetAPIGatewayBotResult> {
	const response = await fetch(`${DISCORD_API_BASE}/gateway/bot`, {
		headers: { Authorization: `Bot ${botToken}`, "User-Agent": USER_AGENT },
	});
	if (!response.ok) {
		throw new Error(`GET /gateway/bot failed with status ${response.status}`);
	}
	return response.json();
}
