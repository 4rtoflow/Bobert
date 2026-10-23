import type { APIMessage } from "discord-api-types/v10";
import { describe, expect, it } from "vitest";
import {
	type GatewayMessage,
	shouldRespond,
	toStoredMessage,
} from "../src/gateway/messages";

const BOT_ID = "1000";

function message(overrides: Partial<GatewayMessage> = {}): GatewayMessage {
	return {
		id: "2000",
		channel_id: "3000",
		guild_id: "4000",
		author: {
			id: "5000",
			username: "alice",
			global_name: "Alice",
			discriminator: "0",
			avatar: null,
		},
		content: "こんにちは",
		timestamp: "2026-10-24T00:00:00.000Z",
		edited_timestamp: null,
		mentions: [],
		attachments: [],
		...overrides,
	} as GatewayMessage;
}

const botUser = {
	id: BOT_ID,
	username: "Bobert",
	global_name: null,
	discriminator: "0",
	avatar: null,
	bot: true,
};

describe("shouldRespond", () => {
	it("Botへのメンションには応答する", () => {
		expect(shouldRespond(message({ mentions: [botUser] }), BOT_ID)).toBe(true);
	});

	it("Botのメッセージへの返信には、メンションがなくても応答する", () => {
		const reply = message({
			referenced_message: message({
				id: "1999",
				author: botUser,
			}) as APIMessage,
		});
		expect(shouldRespond(reply, BOT_ID)).toBe(true);
	});

	it("ただの発言には応答しない", () => {
		expect(shouldRespond(message(), BOT_ID)).toBe(false);
	});

	it("Bot自身やほかのBotの投稿には応答しない", () => {
		const fromBot = message({
			author: { ...botUser, id: "6000" },
			mentions: [botUser],
		});
		expect(shouldRespond(fromBot, BOT_ID)).toBe(false);
	});

	it("サーバーの外(DM)には応答しない", () => {
		expect(
			shouldRespond(
				message({ guild_id: undefined, mentions: [botUser] }),
				BOT_ID,
			),
		).toBe(false);
	});
});

describe("toStoredMessage", () => {
	it("保存用の形に変換する", () => {
		const stored = toStoredMessage(
			message({
				member: { nick: "ありす" },
				message_reference: { channel_id: "3000", message_id: "1999" },
				attachments: [
					{
						id: "7000",
						filename: "cat.png",
						size: 1234,
						url: "https://cdn.example/cat.png",
						proxy_url: "https://media.example/cat.png",
						content_type: "image/png",
					},
				],
				edited_timestamp: "2026-10-24T00:01:00.000Z",
			}),
		);

		expect(stored).toEqual({
			messageId: "2000",
			guildId: "4000",
			channelId: "3000",
			authorId: "5000",
			authorName: "ありす",
			authorIsBot: false,
			content: "こんにちは",
			replyToId: "1999",
			attachments: [
				{
					url: "https://cdn.example/cat.png",
					contentType: "image/png",
					size: 1234,
				},
			],
			createdAt: Date.parse("2026-10-24T00:00:00.000Z"),
			editedAt: Date.parse("2026-10-24T00:01:00.000Z"),
		});
	});
});
