import type {
	APIChannel,
	APIGuildMember,
	APIMessage,
	RESTGetAPIChannelMessagesPinsResult,
	RESTGetAPIChannelResult,
	RESTGetAPIChannelThreadsArchivedPublicResult,
	RESTGetAPIGatewayBotResult,
	RESTGetAPIGuildChannelsResult,
	RESTGetAPIGuildMessagesSearchResult,
	RESTGetAPIGuildResult,
	RESTGetAPIGuildRolesResult,
	RESTGetAPIGuildThreadsResult,
	RESTPatchAPIChannelMessageJSONBody,
	RESTPatchAPIWebhookWithTokenMessageJSONBody,
	RESTPostAPIChannelMessageJSONBody,
	RESTPostAPIGuildChannelJSONBody,
	RESTPostAPIInteractionFollowupJSONBody,
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

/** メッセージに添付するファイル。中身が文字列ならテキストのファイル、バイト列ならそのまま送る */
export interface MessageFile {
	name: string;
	content: string | Uint8Array;
	/** バイト列のときの種類(MIMEタイプ)。なければapplication/octet-stream */
	contentType?: string;
}

interface RequestOptions {
	/** Botのトークン。InteractionsのWebhookは、URLに含まれるトークンで認証するので不要 */
	botToken?: string;
	body?: unknown;
	/** 添付するファイル。あれば、本文と一緒にmultipart/form-dataで送る */
	files?: MessageFile[];
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
	const files = options.files ?? [];
	// multipart/form-dataのContent-Typeは、区切りの文字列と一緒に、fetchが付ける
	if (options.body !== undefined && files.length === 0) {
		headers["Content-Type"] = "application/json";
	}
	for (let attempt = 0; ; attempt++) {
		const response = await fetch(`${DISCORD_API_BASE}${path}`, {
			method,
			headers,
			body:
				files.length > 0
					? formDataOf(options.body, files)
					: options.body === undefined
						? undefined
						: JSON.stringify(options.body),
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

/**
 * チャンネルのピン留めされたメッセージを、新しくピン留めされた順に、最大50件取得する。
 * 読むにはメッセージ履歴を読む権限が必要
 */
export function getChannelPins(
	botToken: string,
	channelId: string,
): Promise<RESTGetAPIChannelMessagesPinsResult> {
	return discordRequest(
		"GET channel pins",
		"GET",
		`/channels/${channelId}/messages/pins?limit=50`,
		{ botToken },
	);
}

/** チャンネル(スレッドを含む)の情報を取得する */
export function getChannel(
	botToken: string,
	channelId: string,
): Promise<RESTGetAPIChannelResult> {
	return discordRequest("GET channel", "GET", `/channels/${channelId}`, {
		botToken,
	});
}

/** サーバーのチャンネルの一覧を取得する(スレッドは含まない) */
export function getGuildChannels(
	botToken: string,
	guildId: string,
): Promise<RESTGetAPIGuildChannelsResult> {
	return discordRequest(
		"GET guild channels",
		"GET",
		`/guilds/${guildId}/channels`,
		{ botToken },
	);
}

/** サーバーのロールの一覧を取得する */
export function getGuildRoles(
	botToken: string,
	guildId: string,
): Promise<RESTGetAPIGuildRolesResult> {
	return discordRequest("GET guild roles", "GET", `/guilds/${guildId}/roles`, {
		botToken,
	});
}

/** サーバーの、アーカイブされていないスレッドの一覧を取得する(Botが見られるもの) */
export function getActiveGuildThreads(
	botToken: string,
	guildId: string,
): Promise<RESTGetAPIGuildThreadsResult> {
	return discordRequest(
		"GET active guild threads",
		"GET",
		`/guilds/${guildId}/threads/active`,
		{ botToken },
	);
}

/**
 * チャンネルの、アーカイブされた公開スレッドを、新しい順に最大100件取得する。
 * beforeを指定すると、その時刻(ISO 8601)より前にアーカイブされたもの。読むにはメッセージ履歴を読む権限が必要
 */
export function getArchivedPublicThreads(
	botToken: string,
	channelId: string,
	before: string | null,
): Promise<RESTGetAPIChannelThreadsArchivedPublicResult> {
	const query = new URLSearchParams({ limit: "100" });
	if (before) {
		query.set("before", before);
	}
	return discordRequest(
		"GET archived public threads",
		"GET",
		`/channels/${channelId}/threads/archived/public?${query}`,
		{ botToken },
	);
}

/**
 * サーバーのメッセージのうち、指定したチャンネル(500個まで)のものの件数を、メッセージ検索で数える。
 * 読むにはメッセージ履歴を読む権限と、Message Contentのインテントが必要。
 * サーバーの検索の準備がまだなら(202)、nullを返す
 */
export async function countGuildMessages(
	botToken: string,
	guildId: string,
	channelIds: readonly string[],
): Promise<number | null> {
	const query = new URLSearchParams({ limit: "1" });
	// 配列は、同じ名前を繰り返して渡す
	for (const channelId of channelIds) {
		query.append("channel_id", channelId);
	}
	const result = await discordRequest<RESTGetAPIGuildMessagesSearchResult>(
		"GET guild messages search",
		"GET",
		`/guilds/${guildId}/messages/search?${query}`,
		{ botToken },
	);
	return "total_results" in result ? result.total_results : null;
}

/** サーバーのメンバーを1人取得する。サーバーにいなければ、404(コード10007)のDiscordApiErrorになる */
export function getGuildMember(
	botToken: string,
	guildId: string,
	userId: string,
): Promise<APIGuildMember> {
	return discordRequest(
		"GET guild member",
		"GET",
		`/guilds/${guildId}/members/${userId}`,
		{ botToken },
	);
}

/**
 * サーバーのメンバーを、ユーザーIDの小さい順に、最大limit人(1000人まで)取得する。afterを指定すると、そのIDより後の人。
 * 読むには、特権インテントのServer Members Intentを、Developer Portalで有効にしておく必要がある
 */
export function listGuildMembers(
	botToken: string,
	guildId: string,
	options: { after?: string | null; limit: number },
): Promise<APIGuildMember[]> {
	const query = new URLSearchParams({ limit: String(options.limit) });
	if (options.after) {
		query.set("after", options.after);
	}
	return discordRequest(
		"GET guild members",
		"GET",
		`/guilds/${guildId}/members?${query}`,
		{ botToken },
	);
}

/** チャンネルにメッセージを投稿する。filesを渡すと添付する(ファイルを添付する権限が必要) */
export function createMessage(
	botToken: string,
	channelId: string,
	body: RESTPostAPIChannelMessageJSONBody,
	files: MessageFile[] = [],
): Promise<APIMessage> {
	return discordRequest(
		"POST channel message",
		"POST",
		`/channels/${channelId}/messages`,
		{ botToken, body, files },
	);
}

/** サーバーの情報を取得する(ブーストの段階などを読むため) */
export function getGuild(
	botToken: string,
	guildId: string,
): Promise<RESTGetAPIGuildResult> {
	return discordRequest("GET guild", "GET", `/guilds/${guildId}`, {
		botToken,
	});
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

/** チャンネルのメッセージを消す。ほかの人のメッセージを消すには、メッセージの管理の権限が必要 */
export async function deleteMessage(
	botToken: string,
	channelId: string,
	messageId: string,
): Promise<void> {
	await discordRequest(
		"DELETE channel message",
		"DELETE",
		`/channels/${channelId}/messages/${messageId}`,
		{ botToken },
	);
}

/** メッセージをピン留めする(メッセージの管理の権限が必要) */
export async function pinMessage(
	botToken: string,
	channelId: string,
	messageId: string,
): Promise<void> {
	await discordRequest(
		"PUT channel pin",
		"PUT",
		`/channels/${channelId}/messages/pins/${messageId}`,
		{ botToken },
	);
}

/** サーバーにチャンネルを作る(チャンネルの管理の権限が必要) */
export function createGuildChannel(
	botToken: string,
	guildId: string,
	body: RESTPostAPIGuildChannelJSONBody,
): Promise<APIChannel> {
	return discordRequest(
		"POST guild channel",
		"POST",
		`/guilds/${guildId}/channels`,
		{ botToken, body },
	);
}

/** チャンネルを消す(チャンネルの管理の権限が必要) */
export async function deleteChannel(
	botToken: string,
	channelId: string,
): Promise<void> {
	await discordRequest("DELETE channel", "DELETE", `/channels/${channelId}`, {
		botToken,
	});
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

/**
 * Interactionの最初の応答(保留にしたもの)を書き換え、書き換えたメッセージを返す。15分以内なら書き換えられる。
 * filesを渡すと、それを添付する(前に添付していたファイルは外す)
 */
export function editOriginalInteractionResponse(
	applicationId: string,
	interactionToken: string,
	body: RESTPatchAPIWebhookWithTokenMessageJSONBody,
	files: MessageFile[] = [],
): Promise<APIMessage> {
	return discordRequest(
		"PATCH original interaction response",
		"PATCH",
		`/webhooks/${applicationId}/${interactionToken}/messages/@original`,
		{ body, files },
	);
}

/** Interactionに、続きのメッセージを送る。本人にだけ見せるなら、flagsにEphemeralを付ける。15分以内なら送れる */
export async function createFollowupMessage(
	applicationId: string,
	interactionToken: string,
	body: RESTPostAPIInteractionFollowupJSONBody,
	files: MessageFile[] = [],
): Promise<void> {
	await discordRequest(
		"POST interaction followup",
		"POST",
		`/webhooks/${applicationId}/${interactionToken}`,
		{ body, files },
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

/**
 * 本文と添付するファイルを、multipart/form-dataにする。
 * 本文はpayload_jsonに入れ、そのattachmentsで、ファイルを番号で指す(ここに挙げたファイルだけが、メッセージに残る)
 */
function formDataOf(body: unknown, files: MessageFile[]): FormData {
	const form = new FormData();
	form.append(
		"payload_json",
		JSON.stringify({
			...(typeof body === "object" && body !== null ? body : {}),
			attachments: files.map((file, index) => ({
				id: index,
				filename: file.name,
			})),
		}),
	);
	files.forEach((file, index) => {
		form.append(
			`files[${index}]`,
			typeof file.content === "string"
				? new Blob([file.content], { type: "text/plain; charset=utf-8" })
				: new Blob([file.content], {
						type: file.contentType ?? "application/octet-stream",
					}),
			file.name,
		);
	});
	return form;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
