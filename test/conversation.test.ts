import type { APIAttachment, APIMessage, APIUser } from "discord-api-types/v10";
import { describe, expect, it } from "vitest";
import type { StoredMessageInput } from "../src/queue/messages";
import { toConversation } from "../src/respond/conversation";
import { fromDiscord } from "../src/respond/history";
import { ALICE, at, BOB, BOT, discordMessage } from "./fixtures";

const OPTIONS = {
	botUserId: BOT.id,
	includeImages: true,
	names: new Map<string, string>(),
};

/** Discordから読んだメッセージを、会話の組み立てに使う形にする */
function stored(...messages: APIMessage[]) {
	return messages.map((message) => fromDiscord(message, "900"));
}

const CAT_IMAGE: APIAttachment = {
	id: "a1",
	filename: "cat.png",
	size: 1000,
	url: "https://cdn.example/cat.png",
	proxy_url: "https://media.example/cat.png",
	content_type: "image/png",
};

const MEMO: APIAttachment = {
	id: "a2",
	filename: "memo.txt",
	size: 100,
	url: "https://cdn.example/memo.txt",
	proxy_url: "https://media.example/memo.txt",
	content_type: "text/plain; charset=utf-8",
};

describe("AIに渡す会話への変換", () => {
	it("Bobertの発言はAIの発言に、それ以外は名前付きの人の発言にする", () => {
		const chain = stored(
			discordMessage("1", BOB, "<@100> これ見て", { mentions: [ALICE] }),
			discordMessage("2", ALICE, `<@${BOT.id}> どういう意味?`, {
				mentions: [BOT],
			}),
			discordMessage("3", BOT, "それはね…\n-# このモデルは画像を読めません"),
			discordMessage("4", ALICE, "ありがとう <:smile:123>"),
		);

		expect(toConversation(chain, OPTIONS).messages).toEqual([
			{
				role: "user",
				parts: [{ type: "text", text: at("bob: @Alice これ見て") }],
			},
			{
				role: "user",
				parts: [{ type: "text", text: at("Alice: @Bobert どういう意味?") }],
			},
			{ role: "assistant", parts: [{ type: "text", text: "それはね…" }] },
			{
				role: "user",
				parts: [{ type: "text", text: at("Alice: ありがとう :smile:") }],
			},
		]);
	});

	it("Bobertの過去の返答の先頭に付いた「[時刻] Bobert: 」は、AIに渡す前に外す(AIがまたまねないように)", () => {
		const chain = stored(
			discordMessage("1", ALICE, `<@${BOT.id}> こんにちは`, {
				mentions: [BOT],
			}),
			discordMessage(
				"2",
				BOT,
				"[2026-10-30(金) 00:01] Bobert: こんにちは！\n-# 入力 10 / 出力 5",
			),
		);

		expect(toConversation(chain, OPTIONS).messages[1]).toEqual({
			role: "assistant",
			parts: [{ type: "text", text: "こんにちは！" }],
		});
	});

	it("名前は、サーバーで見えている名前に揃える(発言者も、メンションされた人も)", () => {
		const chain = stored(
			discordMessage("1", BOB, "<@100> これ見て", { mentions: [ALICE] }),
		);

		const { messages } = toConversation(chain, {
			...OPTIONS,
			names: new Map([
				[ALICE.id, "ありす"],
				[BOB.id, "ぼぶ"],
			]),
		});

		expect(messages[0]?.parts).toEqual([
			{ type: "text", text: at("ぼぶ: @ありす これ見て") },
		]);
	});

	it("画像はAIに渡し、画像以外の添付はファイル名だけを書き添える", () => {
		const chain = stored(
			discordMessage("1", ALICE, "これ何?", { attachments: [CAT_IMAGE, MEMO] }),
		);

		const conversation = toConversation(chain, OPTIONS);

		expect(conversation.messages).toEqual([
			{
				role: "user",
				parts: [
					{
						type: "text",
						text: at("Alice: これ何?\n[添付ファイル: memo.txt]"),
					},
					{ type: "image", url: "https://cdn.example/cat.png" },
				],
			},
		]);
		expect(conversation.imagesSkipped).toBe(false);
	});

	it("画像を渡さないときは、ファイル名を書き添え、渡さなかったことを知らせる", () => {
		const chain = stored(
			discordMessage("1", ALICE, "これ何?", { attachments: [CAT_IMAGE, MEMO] }),
		);

		const conversation = toConversation(chain, {
			...OPTIONS,
			includeImages: false,
		});

		expect(conversation.messages[0]?.parts).toEqual([
			{
				type: "text",
				text: at("Alice: これ何?\n[画像: cat.png]\n[添付ファイル: memo.txt]"),
			},
		]);
		expect(conversation.imagesSkipped).toBe(true);
	});

	it("「/」と英数字で始まる人の発言には、コマンドの実行ではないと書き添える", () => {
		const bot: APIUser = { ...BOB, id: "301", bot: true };
		const chain = stored(
			discordMessage("1", ALICE, "/ohiru"),
			discordMessage("2", ALICE, "1/2はいくつ?"),
			// ほかのBotの発言には添えない
			discordMessage("3", bot, "/help で使い方を見られます"),
		);

		const { messages } = toConversation(chain, OPTIONS);

		expect(messages.map((message) => message.parts[0])).toEqual([
			{
				type: "text",
				text: at("Alice: /ohiru(文字の発言で、コマンドの実行ではありません)"),
			},
			{ type: "text", text: at("Alice: 1/2はいくつ?") },
			{ type: "text", text: at("bob(Bot): /help で使い方を見られます") },
		]);
	});

	it("会話がBobertの発言から始まるときは、前に人の発言を補う", () => {
		const chain = stored(
			discordMessage("1", BOT, "こんにちは"),
			discordMessage("2", ALICE, "やあ"),
		);

		const { messages } = toConversation(chain, OPTIONS);

		expect(messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"user",
		]);
	});

	it("ほかのBotの発言は、Botであることと、どのコマンドへの返答かを書き添え、Embedの中身も渡す", () => {
		const ohirun: APIUser = {
			id: "300",
			username: "ohirun",
			global_name: "おひるん！",
			discriminator: "0",
			avatar: null,
			bot: true,
		};
		const [added, pong] = stored(
			discordMessage("1", ohirun, ""),
			discordMessage("2", ohirun, "Pong!"),
		);
		const chain = [
			{
				...(added as StoredMessageInput),
				embeds: [
					{
						title: "✅ 店舗を追加しました",
						fields: [{ name: "店舗名", value: "aaa" }],
					},
				],
				command: {
					name: "add store",
					contextMenu: false,
					userId: ALICE.id,
					userName: "Alice",
				},
			},
			pong as StoredMessageInput,
		];

		const { messages } = toConversation(chain, {
			...OPTIONS,
			names: new Map([[ALICE.id, "ありす"]]),
		});

		expect(messages.map((message) => message.parts)).toEqual([
			[
				{
					type: "text",
					text: [
						at(
							"おひるん！(Bot。ありすが使った /add store への返答): [Embed] ✅ 店舗を追加しました",
						),
						"店舗名: aaa",
					].join("\n"),
				},
			],
			[{ type: "text", text: at("おひるん！(Bot): Pong!") }],
		]);
	});
});
