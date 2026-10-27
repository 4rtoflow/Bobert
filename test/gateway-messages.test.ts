import type { APIMessage } from "discord-api-types/v10";
import { describe, expect, it } from "vitest";
import { MessageType } from "../src/discord/constants";
import {
	type GatewayMessage,
	shouldRespond,
	shouldStore,
	toStoredMessage,
} from "../src/gateway/messages";

const BOT_ID = "1000";

function message(overrides: Partial<GatewayMessage> = {}): GatewayMessage {
	return {
		id: "2000",
		type: MessageType.Default,
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

describe("shouldStore", () => {
	it("ふつうの発言、返信、コマンドへの返答は保存する", () => {
		expect(shouldStore(message())).toBe(true);
		expect(shouldStore(message({ type: MessageType.Reply }))).toBe(true);
		expect(shouldStore(message({ type: MessageType.ChatInputCommand }))).toBe(
			true,
		);
	});

	it("参加やピン留めの通知などのシステムのメッセージと、DMは保存しない", () => {
		// 6はピン留めの通知、7は参加の通知
		expect(shouldStore(message({ type: 6 as GatewayMessage["type"] }))).toBe(
			false,
		);
		expect(shouldStore(message({ type: 7 as GatewayMessage["type"] }))).toBe(
			false,
		);
		expect(shouldStore(message({ guild_id: undefined }))).toBe(false);
	});

	it("種類のない編集の通知は、保存する側に倒す", () => {
		expect(shouldStore({ guild_id: "4000" })).toBe(true);
	});
});

describe("toStoredMessage", () => {
	it("保存用の形に変換する", () => {
		const stored = toStoredMessage(
			message({
				type: MessageType.Reply,
				member: { nick: "ありす" },
				mentions: [
					{
						...botUser,
						member: { nick: null },
					},
					{
						id: "6000",
						username: "bob",
						global_name: "Bob",
						discriminator: "0",
						avatar: null,
						member: { nick: "ぼぶ" },
					},
					// サーバーでの情報がない人は、表示名を使い、名前の記録には入れない
					{
						id: "6100",
						username: "carol",
						global_name: null,
						discriminator: "0",
						avatar: null,
					},
				],
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
			mentions: [
				{ id: BOT_ID, name: "Bobert" },
				{ id: "6000", name: "ぼぶ" },
				{ id: "6100", name: "carol" },
			],
			attachments: [
				{
					filename: "cat.png",
					url: "https://cdn.example/cat.png",
					contentType: "image/png",
					size: 1234,
				},
			],
			members: [
				{ id: "5000", name: "ありす" },
				{ id: BOT_ID, name: "Bobert" },
				{ id: "6000", name: "ぼぶ" },
			],
			createdAt: Date.parse("2026-10-24T00:00:00.000Z"),
			editedAt: Date.parse("2026-10-24T00:01:00.000Z"),
		});
	});

	it("返信先は、返信のときだけ入れる(転送も返信先と同じ項目を持つため)", () => {
		const forwarded = toStoredMessage(
			message({
				message_reference: { channel_id: "3000", message_id: "1999" },
			}),
		);

		expect(forwarded.replyToId).toBeNull();
	});

	it("サーバーでの情報がなければ、表示名を使い、名前の記録には入れない", () => {
		const stored = toStoredMessage(message());

		expect(stored.authorName).toBe("Alice");
		expect(stored.members).toEqual([]);
	});
});
