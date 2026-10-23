import type { APIAttachment } from "discord-api-types/v10";
import { describe, expect, it } from "vitest";
import { fetchReplyChain, toConversation } from "../src/respond/conversation";
import { ALICE, BOB, BOT, discordMessage, discordReply } from "./fixtures";

const OPTIONS = { botUserId: BOT.id, includeImages: true };

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

describe("返信のつながりをたどる", () => {
	it("古い順に並べる。メッセージに含まれている返信先は、読み直さない", async () => {
		const first = discordMessage("1", ALICE, "こんにちは");
		const second = discordReply("2", BOT, "やあ", first);
		const third = discordReply("3", ALICE, "元気?", second, {
			referenced_message: second,
		});
		const stored = new Map([first, second, third].map((m) => [m.id, m]));
		const fetched: string[] = [];

		const chain = await fetchReplyChain(third, async (_channelId, id) => {
			fetched.push(id);
			return stored.get(id) ?? null;
		});

		expect(chain.map((message) => message.id)).toEqual(["1", "2", "3"]);
		expect(fetched).toEqual(["1"]);
	});

	it("返信先が消えていたら、そこで止める", async () => {
		const deleted = discordMessage("1", BOB, "消えた発言");
		const orphan = discordReply("2", ALICE, "これは?", deleted, {
			referenced_message: null,
		});

		const chain = await fetchReplyChain(orphan, async () => {
			throw new Error("読まないはず");
		});

		expect(chain.map((message) => message.id)).toEqual(["2"]);
	});
});

describe("AIに渡す会話への変換", () => {
	it("Bobertの発言はAIの発言に、それ以外は名前付きの人の発言にする", () => {
		const chain = [
			discordMessage("1", BOB, "<@100> これ見て", { mentions: [ALICE] }),
			discordMessage("2", ALICE, `<@${BOT.id}> どういう意味?`, {
				mentions: [BOT],
			}),
			discordMessage("3", BOT, "それはね…\n-# このモデルは画像を読めません"),
			discordMessage("4", ALICE, "ありがとう <:smile:123>"),
		];

		expect(toConversation(chain, OPTIONS).messages).toEqual([
			{ role: "user", parts: [{ type: "text", text: "bob: @Alice これ見て" }] },
			{
				role: "user",
				parts: [{ type: "text", text: "Alice: @Bobert どういう意味?" }],
			},
			{ role: "assistant", parts: [{ type: "text", text: "それはね…" }] },
			{
				role: "user",
				parts: [{ type: "text", text: "Alice: ありがとう :smile:" }],
			},
		]);
	});

	it("画像はAIに渡し、画像以外の添付はファイル名だけを書き添える", () => {
		const chain = [
			discordMessage("1", ALICE, "これ何?", { attachments: [CAT_IMAGE, MEMO] }),
		];

		const conversation = toConversation(chain, OPTIONS);

		expect(conversation.messages).toEqual([
			{
				role: "user",
				parts: [
					{ type: "text", text: "Alice: これ何?\n[添付ファイル: memo.txt]" },
					{ type: "image", url: "https://cdn.example/cat.png" },
				],
			},
		]);
		expect(conversation.imagesSkipped).toBe(false);
	});

	it("画像を渡さないときは、ファイル名を書き添え、渡さなかったことを知らせる", () => {
		const chain = [
			discordMessage("1", ALICE, "これ何?", { attachments: [CAT_IMAGE, MEMO] }),
		];

		const conversation = toConversation(chain, {
			...OPTIONS,
			includeImages: false,
		});

		expect(conversation.messages[0]?.parts).toEqual([
			{
				type: "text",
				text: "Alice: これ何?\n[画像: cat.png]\n[添付ファイル: memo.txt]",
			},
		]);
		expect(conversation.imagesSkipped).toBe(true);
	});

	it("会話がBobertの発言から始まるときは、前に人の発言を補う", () => {
		const chain = [
			discordMessage("1", BOT, "こんにちは"),
			discordMessage("2", ALICE, "やあ"),
		];

		const { messages } = toConversation(chain, OPTIONS);

		expect(messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"user",
		]);
	});
});
