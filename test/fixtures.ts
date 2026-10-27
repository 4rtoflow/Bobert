import type { APIMessage, APIUser } from "discord-api-types/v10";
import { MessageType } from "../src/discord/constants";

/** テスト用のBobert。IDは vitest.config.ts の DISCORD_APPLICATION_ID と同じ */
export const BOT: APIUser = {
	id: "000000000000000000",
	username: "Bobert",
	global_name: null,
	discriminator: "0",
	avatar: null,
	bot: true,
};

export const ALICE: APIUser = {
	id: "100",
	username: "alice",
	global_name: "Alice",
	discriminator: "0",
	avatar: null,
};

export const BOB: APIUser = {
	id: "200",
	username: "bob",
	global_name: null,
	discriminator: "0",
	avatar: null,
};

export const CHANNEL_ID = "800";

/** Discordから読んだのと同じ形のメッセージ */
export function discordMessage(
	id: string,
	author: APIUser,
	content: string,
	extra: Partial<APIMessage> = {},
): APIMessage {
	return {
		id,
		channel_id: CHANNEL_ID,
		author,
		content,
		timestamp: "2026-10-24T00:00:00.000Z",
		edited_timestamp: null,
		tts: false,
		mention_everyone: false,
		mentions: [],
		mention_roles: [],
		attachments: [],
		embeds: [],
		pinned: false,
		type: MessageType.Default,
		...extra,
	};
}

/** parentへの返信 */
export function discordReply(
	id: string,
	author: APIUser,
	content: string,
	parent: APIMessage,
	extra: Partial<APIMessage> = {},
): APIMessage {
	return discordMessage(id, author, content, {
		type: MessageType.Reply,
		message_reference: { message_id: parent.id, channel_id: CHANNEL_ID },
		...extra,
	});
}

/** fixturesのメッセージをAIに渡すときに、頭に付く時刻(投稿時刻を日本時間にしたもの) */
export const POSTED_AT = "[2026-10-24(土) 09:00]";

/** AIに渡す発言の形。頭に、fixturesのメッセージの投稿時刻を付ける */
export function at(line: string): string {
	return `${POSTED_AT} ${line}`;
}
