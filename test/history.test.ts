import { env } from "cloudflare:workers";
import type { APIAttachment, APIMessage } from "discord-api-types/v10";
import { describe, expect, it } from "vitest";
import {
	fromDiscord,
	type HistoryDeps,
	namesFor,
	readReplyChain,
	refreshImageUrls,
} from "../src/respond/history";
import { saveMessages } from "../src/store/messages";
import {
	ALICE,
	BOB,
	BOT,
	CHANNEL_ID,
	discordMessage,
	discordReply,
} from "./fixtures";

const GUILD_ID = "900";
const NOW = Date.parse("2026-10-27T00:00:00.000Z");

/** Discordから読んだメッセージを、保存の形にする */
function stored(message: APIMessage) {
	return fromDiscord(message, GUILD_ID);
}

/** 偽物のDiscordと保存用のQueue。Discordにはmessagesがあることにする */
function fakeHistory(
	messages: APIMessage[],
	overrides: Partial<HistoryDeps> = {},
) {
	const discord = new Map(messages.map((message) => [message.id, message]));
	const fetched: string[] = [];
	const ingested: string[] = [];
	const history: HistoryDeps = {
		db: env.DB,
		guildId: GUILD_ID,
		channelId: CHANNEL_ID,
		fetchMessage: async (_channelId, messageId) => {
			fetched.push(messageId);
			return discord.get(messageId) ?? null;
		},
		ingest: async (saved) => {
			ingested.push(...saved.map((message) => message.messageId));
		},
		knownNames: [],
		...overrides,
	};
	return { history, fetched, ingested };
}

/** DiscordのCDNのURL。期限を16進数のUNIX時間(秒)で持つ */
function cdnUrl(name: string, expiresAt: number): string {
	const ex = Math.floor(expiresAt / 1000).toString(16);
	return `https://cdn.discordapp.com/attachments/${CHANNEL_ID}/1/${name}?ex=${ex}&is=0&hm=0`;
}

function image(url: string): APIAttachment {
	return {
		id: "a1",
		filename: "cat.png",
		size: 1000,
		url,
		proxy_url: url,
		content_type: "image/png",
	};
}

describe("返信のつながりを読む", () => {
	it("保存したメッセージから読み、Discordには問い合わせない", async () => {
		const first = discordMessage("1001", ALICE, "こんにちは");
		const second = discordReply("1002", BOT, "やあ", first);
		const trigger = discordReply("1003", ALICE, "元気?", second);
		await saveMessages(env.DB, [stored(first), stored(second)]);
		const { history, fetched, ingested } = fakeHistory([]);

		const chain = await readReplyChain(stored(trigger), history);

		expect(chain.map((message) => message.messageId)).toEqual([
			"1001",
			"1002",
			"1003",
		]);
		expect(fetched).toEqual([]);
		expect(ingested).toEqual([]);
	});

	it("保存していないものはDiscordから読んで保存に回し、その先はまた保存したものから読む", async () => {
		const first = discordMessage("1101", ALICE, "こんにちは");
		const second = discordReply("1102", BOT, "やあ", first);
		const third = discordReply("1103", ALICE, "元気?", second);
		const trigger = discordReply("1104", BOT, "元気だよ", third);
		await saveMessages(env.DB, [stored(first), stored(third)]);
		const { history, fetched, ingested } = fakeHistory([second]);

		const chain = await readReplyChain(stored(trigger), history);

		expect(chain.map((message) => message.messageId)).toEqual([
			"1101",
			"1102",
			"1103",
			"1104",
		]);
		expect(fetched).toEqual(["1102"]);
		expect(ingested).toEqual(["1102"]);
	});

	it("保存したEmbedの中身と、コマンドへの返答の情報も読む", async () => {
		const ohirun = { ...BOB, id: "1050", bot: true };
		const added = {
			...stored(discordMessage("1051", ohirun, "")),
			embeds: [{ title: "✅ 店舗を追加しました" }],
			command: {
				name: "add store",
				contextMenu: false,
				userId: ALICE.id,
				userName: "Alice",
			},
		};
		await saveMessages(env.DB, [added]);
		const trigger = discordReply("1052", ALICE, "これは?", {
			...discordMessage("1051", ohirun, ""),
		});
		const { history } = fakeHistory([]);

		const [first] = await readReplyChain(stored(trigger), history);

		expect(first).toMatchObject({
			messageId: "1051",
			authorIsBot: true,
			embeds: added.embeds,
			command: added.command,
		});
	});

	it("返信先が消えていたら、そこで止める", async () => {
		const deleted = discordMessage("1201", BOB, "消えた発言");
		const trigger = discordReply("1202", ALICE, "これは?", deleted);
		const { history, ingested } = fakeHistory([]);

		const chain = await readReplyChain(stored(trigger), history);

		expect(chain.map((message) => message.messageId)).toEqual(["1202"]);
		expect(ingested).toEqual([]);
	});

	it("上限の件数までしか読まない(話しかけたメッセージに近いものから)", async () => {
		const messages: APIMessage[] = [discordMessage("1301", ALICE, "1")];
		for (let i = 2; i <= 5; i++) {
			messages.push(
				discordReply(
					`130${i}`,
					ALICE,
					String(i),
					messages.at(-1) as APIMessage,
				),
			);
		}
		await saveMessages(env.DB, messages.slice(0, -1).map(stored));
		const { history } = fakeHistory([]);

		const chain = await readReplyChain(
			stored(messages.at(-1) as APIMessage),
			history,
			3,
		);

		expect(chain.map((message) => message.messageId)).toEqual([
			"1303",
			"1304",
			"1305",
		]);
	});
});

describe("サーバーで見えている名前", () => {
	it("保存した名前に、話しかけたメッセージで分かった名前を重ねる", async () => {
		const alice = { ...ALICE, id: "1401" };
		const bob = { ...BOB, id: "1402" };
		await saveMessages(env.DB, [
			{
				...stored(discordMessage("1403", alice, "やあ")),
				members: [
					{ id: alice.id, name: "ありす" },
					{ id: bob.id, name: "ぼぶ" },
				],
			},
		]);
		const { history } = fakeHistory([], {
			knownNames: [{ id: bob.id, name: "ぼぶ(新しい名前)" }],
		});
		const message = stored(
			discordMessage("1404", alice, `<@${bob.id}> 見て`, { mentions: [bob] }),
		);

		const names = await namesFor([message], history);

		expect(names).toEqual(
			new Map([
				[alice.id, "ありす"],
				[bob.id, "ぼぶ(新しい名前)"],
			]),
		);
	});
});

describe("画像のURLの取り直し", () => {
	it("期限が近い画像のURLは、Discordから読み直して取り直し、保存にも回す", async () => {
		const oldUrl = cdnUrl("cat.png", NOW + 5 * 60_000);
		const newUrl = cdnUrl("cat.png", NOW + 24 * 3600_000);
		const before = discordMessage("1501", ALICE, "これ見て", {
			attachments: [image(oldUrl)],
		});
		const after = { ...before, attachments: [image(newUrl)] };
		const { history, fetched, ingested } = fakeHistory([after]);

		const chain = await refreshImageUrls(
			[stored(before)],
			history,
			BOT.id,
			NOW,
		);

		expect(chain[0]?.attachments[0]?.url).toBe(newUrl);
		expect(fetched).toEqual(["1501"]);
		expect(ingested).toEqual(["1501"]);
	});

	it("期限まで余裕があるURLや、期限のないURLは、そのまま使う", async () => {
		const chain = [
			stored(
				discordMessage("1601", ALICE, "これ見て", {
					attachments: [image(cdnUrl("cat.png", NOW + 2 * 3600_000))],
				}),
			),
			stored(
				discordMessage("1602", ALICE, "これも", {
					attachments: [image("https://cdn.example/cat.png")],
				}),
			),
		];
		const { history, fetched } = fakeHistory([]);

		const refreshed = await refreshImageUrls(chain, history, BOT.id, NOW);

		expect(refreshed).toEqual(chain);
		expect(fetched).toEqual([]);
	});

	it("読み直せなかった(消えていた)メッセージは、会話から外す", async () => {
		const gone = stored(
			discordMessage("1701", ALICE, "これ見て", {
				attachments: [image(cdnUrl("cat.png", NOW - 60_000))],
			}),
		);
		const trigger = stored(discordMessage("1702", ALICE, "どう?"));
		const { history } = fakeHistory([]);

		const refreshed = await refreshImageUrls(
			[gone, trigger],
			history,
			BOT.id,
			NOW,
		);

		expect(refreshed.map((message) => message.messageId)).toEqual(["1702"]);
	});
});
