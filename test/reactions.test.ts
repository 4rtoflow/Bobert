import { env } from "cloudflare:workers";
import type { APIMessage } from "discord-api-types/v10";
import { beforeAll, describe, expect, it } from "vitest";
import { reactionJob } from "../src/gateway/reactions";
import { deleteMessages } from "../src/queue/ingest";
import type { ReactionJob, StoredMessageInput } from "../src/queue/messages";
import { applyReactions } from "../src/queue/reactions";
import { messageLine, toConversation } from "../src/respond/conversation";
import { annotationsFor, fromDiscord } from "../src/respond/history";
import { saveMessages } from "../src/store/messages";
import { loadReactions } from "../src/store/reactions";
import { ALICE, BOB, BOT, discordMessage } from "./fixtures";
import { fakeIngestDeps, recordChannels } from "./helpers";

const GUILD_ID = "980";
/** 共有チャンネルと、年齢制限のチャンネル(共有しない) */
const SHARED = "9801";
const NSFW = "9802";
/** 通知を受け取った時刻の基準。外したリアクションの印は1日で消すので、今の時刻にする */
const T = Date.now();

beforeAll(async () => {
	await recordChannels(GUILD_ID, [
		{ channelId: SHARED, name: "雑談" },
		{ channelId: NSFW, name: "大人", nsfw: true },
	]);
});

/** リアクションの付け外しの仕事 */
function job(
	action: ReactionJob["action"],
	messageId: string,
	at: number,
	extra: Partial<ReactionJob> = {},
): ReactionJob {
	return {
		kind: "reaction",
		action,
		guildId: GUILD_ID,
		channelId: SHARED,
		messageId,
		at,
		...extra,
	};
}

function add(messageId: string, userId: string, emoji: string, at: number) {
	return job("add", messageId, at, { userId, emoji, burst: false });
}

function remove(messageId: string, userId: string, emoji: string, at: number) {
	return job("remove", messageId, at, { userId, emoji, burst: false });
}

async function reactionsOf(messageId: string) {
	return (await loadReactions(env.DB, [messageId])).get(messageId) ?? [];
}

describe("リアクションの通知", () => {
	const message = {
		guild_id: GUILD_ID,
		channel_id: SHARED,
		message_id: "9810",
	};

	it("付けた通知を、付けた人の名前と一緒に、記録の仕事にする", () => {
		expect(
			reactionJob(
				"MESSAGE_REACTION_ADD",
				{
					...message,
					user_id: ALICE.id,
					emoji: { id: null, name: "👍" },
					burst: false,
					type: 0,
					member: { nick: "ありす", user: ALICE },
				},
				1000,
			),
		).toEqual({
			kind: "reaction",
			action: "add",
			guildId: GUILD_ID,
			channelId: SHARED,
			messageId: "9810",
			userId: ALICE.id,
			emoji: "👍",
			burst: false,
			member: { id: ALICE.id, name: "ありす" },
			at: 1000,
		});
	});

	it("カスタム絵文字は「名前:ID」で記録する。全部外した通知と、絵文字ごとに外した通知も仕事にする", () => {
		expect(
			reactionJob(
				"MESSAGE_REACTION_REMOVE",
				{
					...message,
					user_id: BOB.id,
					emoji: { id: "555", name: "blobcat" },
					burst: true,
					type: 1,
				},
				1000,
			),
		).toMatchObject({ action: "remove", emoji: "blobcat:555", burst: true });
		expect(
			reactionJob("MESSAGE_REACTION_REMOVE_ALL", message, 1000),
		).toMatchObject({ action: "remove_all", messageId: "9810" });
		expect(
			reactionJob(
				"MESSAGE_REACTION_REMOVE_EMOJI",
				{ ...message, emoji: { id: null, name: "🎉" } },
				1000,
			),
		).toMatchObject({ action: "remove_emoji", emoji: "🎉" });
	});

	it("サーバーの外の通知は、記録しない", () => {
		expect(
			reactionJob(
				"MESSAGE_REACTION_REMOVE_ALL",
				{ channel_id: SHARED, message_id: "9810" },
				1000,
			),
		).toBeNull();
	});
});

describe("リアクションの記録", () => {
	const deps = () => fakeIngestDeps(BOT.id).deps;

	it("付け外しを記録し、絵文字は最初に付いた順、人は付けた順に並べる。付けた人の名前も記録する", async () => {
		await applyReactions(
			[
				add("9820", BOB.id, "🎉", T + 2000),
				{
					...add("9820", ALICE.id, "👍", T + 1000),
					member: { id: ALICE.id, name: "ありす" },
				},
				add("9820", BOB.id, "👍", T + 3000),
				// スーパーリアクションも、同じ絵文字にまとめる
				{ ...add("9820", ALICE.id, "🎉", T + 4000), burst: true },
			],
			deps(),
		);

		expect(await reactionsOf("9820")).toEqual([
			{ emoji: "👍", userIds: [ALICE.id, BOB.id] },
			{ emoji: "🎉", userIds: [BOB.id, ALICE.id] },
		]);
		const names = await annotationsFor(
			[fromDiscord(discordMessage("9820", BOB, "やった"), GUILD_ID)],
			{
				db: env.DB,
				guildId: GUILD_ID,
				channelId: SHARED,
				fetchMessage: async () => null,
				listMessages: async () => [],
				searchMessages: async () => [],
				ingest: async () => {},
				knownNames: [],
			},
		);
		expect(names.names.get(ALICE.id)).toBe("ありす");
	});

	it("順番が入れ替わって届いても、古い通知で上書きしない", async () => {
		// 外した通知(新しい)が先に、付けた通知(古い)が後に届く
		await applyReactions([remove("9830", ALICE.id, "👍", T + 2000)], deps());
		await applyReactions([add("9830", ALICE.id, "👍", T + 1000)], deps());
		// 付けた通知(新しい)が先に、外した通知(古い)が後に届く
		await applyReactions([add("9830", BOB.id, "👍", T + 4000)], deps());
		await applyReactions([remove("9830", BOB.id, "👍", T + 3000)], deps());

		expect(await reactionsOf("9830")).toEqual([
			{ emoji: "👍", userIds: [BOB.id] },
		]);
	});

	it("全部外した通知と、絵文字ごとに外した通知の後には、それより古い付けた通知を反映しない", async () => {
		await applyReactions(
			[
				add("9840", ALICE.id, "👍", T + 1000),
				add("9840", ALICE.id, "🎉", T + 1000),
				add("9841", ALICE.id, "👍", T + 1000),
			],
			deps(),
		);
		await applyReactions(
			[
				job("remove_emoji", "9840", T + 2000, { emoji: "🎉" }),
				job("remove_all", "9841", T + 2000),
			],
			deps(),
		);
		// 外した通知より前に付けていた人の通知が、後から届く
		await applyReactions(
			[
				add("9840", BOB.id, "🎉", T + 1500),
				add("9841", BOB.id, "👍", T + 1500),
			],
			deps(),
		);
		// 外した後に付けたものは、記録する
		await applyReactions([add("9841", BOB.id, "😂", T + 3000)], deps());

		expect(await reactionsOf("9840")).toEqual([
			{ emoji: "👍", userIds: [ALICE.id] },
		]);
		expect(await reactionsOf("9841")).toEqual([
			{ emoji: "😂", userIds: [BOB.id] },
		]);
	});

	it("共有しないチャンネルのリアクションは、記録しない", async () => {
		await applyReactions(
			[{ ...add("9850", ALICE.id, "👍", T + 1000), channelId: NSFW }],
			deps(),
		);

		expect(await reactionsOf("9850")).toEqual([]);
	});

	it("メッセージが削除されたら、リアクションの記録も消し、後から届いた通知でも付け直さない", async () => {
		const ingest = fakeIngestDeps(BOT.id).deps;
		await applyReactions([add("9860", ALICE.id, "👍", T + 1000)], ingest);

		await deleteMessages(["9860"], ingest);
		await applyReactions([add("9860", BOB.id, "👍", T + 2000)], ingest);

		expect(await reactionsOf("9860")).toEqual([]);
	});
});

describe("リアクションの書き添え", () => {
	const names = new Map([
		[ALICE.id, "ありす"],
		[BOB.id, "ぼぶ"],
	]);

	function stored(message: APIMessage): StoredMessageInput {
		return fromDiscord(message, GUILD_ID);
	}

	it("誰がどの絵文字を付けたかを書き添える。カスタム絵文字は「:名前:」にする", () => {
		const message = stored(discordMessage("9870", BOB, "明日10時集合で!"));

		const line = messageLine(message, BOT.id, {
			names,
			reactions: new Map([
				[
					"9870",
					[
						{ emoji: "👍", userIds: [ALICE.id, BOB.id] },
						{ emoji: "blobcat:555", userIds: [ALICE.id] },
					],
				],
			]),
		});

		expect(line).toBe(
			"[2026-10-24(土) 09:00] ぼぶ: 明日10時集合で!\n[リアクション] 👍 ありす、ぼぶ / :blobcat: ありす",
		);
	});

	it("名前を出すのは1つの絵文字で10人までで、残りと名前の分からない人は、人数だけを書く", () => {
		const message = stored(discordMessage("9871", BOB, "投票してね"));
		const many = Array.from({ length: 12 }, (_, index) => `98${index + 10}`);
		const manyNames = new Map(many.map((id) => [id, `人${id}`]));

		const line = messageLine(message, BOT.id, {
			names: manyNames,
			reactions: new Map([
				[
					"9871",
					[
						{ emoji: "🙆", userIds: many },
						{ emoji: "🙅", userIds: ["9999"] },
					],
				],
			]),
		});

		expect(line).toContain(
			`🙆 ${many
				.slice(0, 10)
				.map((id) => `人${id}`)
				.join("、")} ほか2人 / 🙅 1人`,
		);
	});

	it("会話では、Bobertの発言には書き添えない。道具の結果では、Bobertの発言にも書き添える", () => {
		const reply = stored(discordMessage("9872", BOT, "10時からだよ!"));
		const reactions = new Map([
			["9872", [{ emoji: "👍", userIds: [ALICE.id] }]],
		]);

		const conversation = toConversation([reply], {
			botUserId: BOT.id,
			includeImages: false,
			names,
			reactions,
		});
		const line = messageLine(reply, BOT.id, { names, reactions });

		expect(conversation.messages.at(-1)).toEqual({
			role: "assistant",
			parts: [{ type: "text", text: "10時からだよ!" }],
		});
		expect(line).toBe(
			"[2026-10-24(土) 09:00] Bobert: 10時からだよ!\n[リアクション] 👍 ありす",
		);
	});

	it("会話の人の発言にも書き添える", async () => {
		await saveMessages(env.DB, [
			stored(
				discordMessage("9873", ALICE, "どう思う?", { channel_id: SHARED }),
			),
		]);
		await applyReactions(
			[add("9873", BOB.id, "🤔", 1000)],
			fakeIngestDeps(BOT.id).deps,
		);
		const chain = [
			stored(
				discordMessage("9873", ALICE, "どう思う?", { channel_id: SHARED }),
			),
		];
		const annotations = await annotationsFor(chain, {
			db: env.DB,
			guildId: GUILD_ID,
			channelId: SHARED,
			fetchMessage: async () => null,
			listMessages: async () => [],
			searchMessages: async () => [],
			ingest: async () => {},
			knownNames: [{ id: BOB.id, name: "ぼぶ" }],
		});

		const { messages } = toConversation(chain, {
			botUserId: BOT.id,
			includeImages: false,
			...annotations,
		});

		// Aliceの名前は、前のテストでリアクションを付けたときに「ありす」と記録した
		expect(messages[0]?.parts[0]).toEqual({
			type: "text",
			text: "[2026-10-24(土) 09:00] ありす: どう思う?\n[リアクション] 🤔 ぼぶ",
		});
	});
});
