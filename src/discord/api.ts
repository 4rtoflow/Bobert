import type {
	APIMessage,
	RESTGetAPIGatewayBotResult,
	RESTPatchAPIChannelMessageJSONBody,
	RESTPatchAPIWebhookWithTokenMessageJSONBody,
	RESTPostAPIChannelMessageJSONBody,
	RESTPutAPIApplicationCommandsJSONBody,
	RESTPutAPIApplicationCommandsResult,
} from "discord-api-types/v10";

export const DISCORD_API_BASE = "https://discord.com/api/v10";

/** DiscordのAPIに送るUser-Agent。Botは「DiscordBot (URL, バージョン)」の形式にする */
export const USER_AGENT =
	"DiscordBot (https://github.com/4rtoflow/Bobert, 0.1.0)";

/** 利用制限(429)に当たったときに、待ってやり直す回数の上限 */
const MAX_RATE_LIMIT_RETRIES = 3;

/** DiscordのAPIがエラーを返した */
export class DiscordApiError extends Error {
	constructor(
		readonly status: number,
		/** Discordのエラーコード(JSONのcode) */
		readonly code: number | null,
		message: string,
	) {
		super(message);
		this.name = "DiscordApiError";
	}
}

interface RequestOptions {
	/** Botのトークン。InteractionsのWebhookは、URLに含まれるトークンで認証するので不要 */
	botToken?: string;
	body?: unknown;
}

/**
 * DiscordのAPIを呼ぶ。利用制限(429)に当たったら、指示された時間だけ待ってやり直す。
 * routeはエラーの説明に使う名前。パスにはInteractionのトークンが入ることがあるので、エラーには含めない。
 */
async function discordRequest<T>(
	route: string,
	method: string,
	path: string,
	options: RequestOptions = {},
): Promise<T> {
	const headers: Record<string, string> = { "User-Agent": USER_AGENT };
	if (options.botToken) {
		headers.Authorization = `Bot ${options.botToken}`;
	}
	if (options.body !== undefined) {
		headers["Content-Type"] = "application/json";
	}
	for (let attempt = 0; ; attempt++) {
		const response = await fetch(`${DISCORD_API_BASE}${path}`, {
			method,
			headers,
			body:
				options.body === undefined ? undefined : JSON.stringify(options.body),
		});
		if (response.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
			const data = (await response.json().catch(() => ({}))) as {
				retry_after?: number;
			};
			await sleep(Math.ceil((data.retry_after ?? 1) * 1000));
			continue;
		}
		if (!response.ok) {
			const data = (await response.json().catch(() => ({}))) as {
				code?: number;
			};
			throw new DiscordApiError(
				response.status,
				data.code ?? null,
				`${route} failed with status ${response.status}`,
			);
		}
		if (response.status === 204) {
			return undefined as T;
		}
		return (await response.json()) as T;
	}
}

/** Gatewayの接続先URLと、新規接続(Identify)の残り回数を取得する */
export function getGatewayBot(
	botToken: string,
): Promise<RESTGetAPIGatewayBotResult> {
	return discordRequest("GET /gateway/bot", "GET", "/gateway/bot", {
		botToken,
	});
}

/** チャンネルのメッセージを1件取得する(読むにはメッセージ履歴を読む権限が必要) */
export function getChannelMessage(
	botToken: string,
	channelId: string,
	messageId: string,
): Promise<APIMessage> {
	return discordRequest(
		"GET channel message",
		"GET",
		`/channels/${channelId}/messages/${messageId}`,
		{ botToken },
	);
}

/**
 * チャンネルのメッセージを、新しい順に最大limit件(100件まで)取得する。
 * beforeを指定すると、それより前のもの。afterを指定すると、それより後のもの(どちらもメッセージID)。
 * 読むにはメッセージ履歴を読む権限が必要
 */
export function getChannelMessages(
	botToken: string,
	channelId: string,
	options: { before?: string | null; after?: string | null; limit: number },
): Promise<APIMessage[]> {
	const query = new URLSearchParams({ limit: String(options.limit) });
	if (options.before) {
		query.set("before", options.before);
	}
	if (options.after) {
		query.set("after", options.after);
	}
	return discordRequest(
		"GET channel messages",
		"GET",
		`/channels/${channelId}/messages?${query}`,
		{ botToken },
	);
}

/** チャンネルにメッセージを投稿する */
export function createMessage(
	botToken: string,
	channelId: string,
	body: RESTPostAPIChannelMessageJSONBody,
): Promise<APIMessage> {
	return discordRequest(
		"POST channel message",
		"POST",
		`/channels/${channelId}/messages`,
		{ botToken, body },
	);
}

/** チャンネルのメッセージを書き換える(Bot自身のメッセージだけ) */
export async function editChannelMessage(
	botToken: string,
	channelId: string,
	messageId: string,
	body: RESTPatchAPIChannelMessageJSONBody,
): Promise<void> {
	await discordRequest(
		"PATCH channel message",
		"PATCH",
		`/channels/${channelId}/messages/${messageId}`,
		{ botToken, body },
	);
}

/** 「入力中…」を表示する。約10秒で消えるか、メッセージを投稿すると消える */
export async function triggerTyping(
	botToken: string,
	channelId: string,
): Promise<void> {
	await discordRequest("POST typing", "POST", `/channels/${channelId}/typing`, {
		botToken,
	});
}

/** Interactionの最初の応答(保留にしたもの)を書き換える。15分以内なら書き換えられる */
export async function editOriginalInteractionResponse(
	applicationId: string,
	interactionToken: string,
	body: RESTPatchAPIWebhookWithTokenMessageJSONBody,
): Promise<void> {
	await discordRequest(
		"PATCH original interaction response",
		"PATCH",
		`/webhooks/${applicationId}/${interactionToken}/messages/@original`,
		{ body },
	);
}

/** グローバルなコマンドを、渡した一覧で丸ごと置き換える */
export function overwriteGlobalCommands(
	applicationId: string,
	botToken: string,
	commands: RESTPutAPIApplicationCommandsJSONBody,
): Promise<RESTPutAPIApplicationCommandsResult> {
	return discordRequest(
		"PUT global commands",
		"PUT",
		`/applications/${applicationId}/commands`,
		{ botToken, body: commands },
	);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
