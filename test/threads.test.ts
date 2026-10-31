import { env } from "cloudflare:workers";
import type { APIMessage } from "discord-api-types/v10";
import { beforeAll, describe, expect, it } from "vitest";
import { ChannelType } from "../src/discord/constants";
import type { StoredMessageInput } from "../src/queue/messages";
import { messageLine, toConversation } from "../src/respond/conversation";
import {
	fromDiscord,
	type HistoryDeps,
	threadNamesFor,
} from "../src/respond/history";
import { threadPreface } from "../src/respond/thread";
import { channelListTool } from "../src/respond/tools";
import { saveMessages } from "../src/store/messages";
import { ALICE, BOB, BOT, discordMessage } from "./fixtures";
import { recordChannels } from "./helpers";

const GUILD_ID = "970";

/** 雑談(スレッドが多い)、質問(スレッドなし)、相談(フォーラム) */
const CHAT = "9701";
const QUESTIONS = "9702";
const FORUM = "9703";
/** 雑談のスレッド。TRIP は、雑談のメッセージ(同じID)から作ったもの */
const TRIP = "9711";
const CHAT_THREADS = ["9712", "9713", "9714", "9715", "9716"];
/** 雑談の非公開スレッド(共有しない) */
const SECRET_THREAD = "9720";
/** 相談の投稿(スレッド) */
const POST = "9730";
/** スレッドの作成ボタンで作った、始めたメッセージのないスレッド */
const NO_STARTER = "9740";

function said(channelId: string, id: string, content: string, at: string) {
	return discordMessage(id, ALICE, content, {
		channel_id: channelId,
		timestamp: at,
	});
}

function stored(message: APIMessage): StoredMessageInput {
	return fromDiscord(message, GUILD_ID);
}

/** 雑談の、旅行の計画のスレッドを作ったメッセージ */
const TRIP_STARTER = said(
	CHAT,
	TRIP,
	"来月、旅行に行かない?",
	"2026-10-20T00:00:00.000Z",
);

beforeAll(async () => {
	await recordChannels(GUILD_ID, [
		{ channelId: CHAT, name: "雑談" },
		{ channelId: QUESTIONS, name: "質問" },
		{ channelId: FORUM, name: "相談", type: ChannelType.GuildForum },
		{
			channelId: TRIP,
			name: "旅行の計画",
			type: ChannelType.PublicThread,
			parentId: CHAT,
		},
		...CHAT_THREADS.map((channelId, index) => ({
			channelId,
			name: `スレッド${index + 1}`,
			type: ChannelType.PublicThread,
			parentId: CHAT,
		})),
		{
			channelId: SECRET_THREAD,
			name: "ないしょ",
			type: ChannelType.PrivateThread,
			parentId: CHAT,
		},
		{
			channelId: POST,
			name: "引っ越しの相談",
			type: ChannelType.PublicThread,
			parentId: FORUM,
		},
		{
			channelId: NO_STARTER,
			name: "雑談の続き",
			type: ChannelType.PublicThread,
			parentId: CHAT,
		},
	]);
	// 旅行の計画がいちばん新しく、スレッド1から順に古い。ほかのスレッドには、保存したメッセージがない
	await saveMessages(env.DB, [
		stored(TRIP_STARTER),
		stored(said(TRIP, "97501", "いいね", "2026-10-30T12:00:00.000Z")),
		...CHAT_THREADS.slice(0, 3).map((channelId, index) =>
			stored(
				said(
					channelId,
					`9760${index}`,
					"どうも",
					`2026-10-2${5 - index}T00:00:00.000Z`,
				),
			),
		),
	]);
});

/** 偽物のDiscord。messagesにあるメッセージだけを読める */
function fakeHistory(channelId: string, messages: APIMessage[] = []) {
	const fetched: { channelId: string; messageId: string }[] = [];
	const ingested: string[] = [];
	const deps: HistoryDeps = {
		db: env.DB,
		guildId: GUILD_ID,
		channelId,
		fetchMessage: async (target, messageId) => {
			fetched.push({ channelId: target, messageId });
			return (
				messages.find(
					(message) =>
						message.id === messageId && message.channel_id === target,
				) ?? null
			);
		},
		listMessages: async () => [],
		searchMessages: async () => [],
		ingest: async (saved) => {
			ingested.push(...saved.map((message) => message.messageId));
		},
		knownNames: [],
	};
	return { deps, fetched, ingested };
}

describe("チャンネルの一覧の道具(スレッド)", () => {
	it("チャンネルごとに、最近発言があったスレッドを5件まで返す。非公開スレッドは入れない", async () => {
		const { deps } = fakeHistory(TRIP);

		const result = await channelListTool(deps).run({});

		expect(result.split("\n")).toEqual([
			"このサーバーの、読めるチャンネルです。スレッドとフォーラムの投稿も、名前を指定して読めます。スレッドは、チャンネルごとに、最近発言があったものから5件までです。",
			"- #相談(フォーラム)",
			"  - 投稿「引っ越しの相談」",
			"- #質問",
			"- #雑談",
			"  - スレッド「旅行の計画」(最後の発言: 2026-10-30(金) 21:00。このスレッド)",
			"  - スレッド「スレッド1」(最後の発言: 2026-10-25(日) 09:00)",
			"  - スレッド「スレッド2」(最後の発言: 2026-10-24(土) 09:00)",
			"  - スレッド「スレッド3」(最後の発言: 2026-10-23(金) 09:00)",
			// 発言を保存していないスレッドは、新しく作られたものから
			"  - スレッド「雑談の続き」",
			"  - ほかに2件あります(channelに「雑談」を指定すると見られます)",
		]);
	});

	it("チャンネルを指定すると、そのチャンネルのスレッドをすべて返す", async () => {
		const { deps } = fakeHistory(QUESTIONS);

		const result = await channelListTool(deps).run({ channel: "#雑談" });

		expect(result.split("\n")).toEqual([
			"#雑談のスレッドです(最近発言があった順、7件)。名前を指定して読めます。",
			"- スレッド「旅行の計画」(最後の発言: 2026-10-30(金) 21:00)",
			"- スレッド「スレッド1」(最後の発言: 2026-10-25(日) 09:00)",
			"- スレッド「スレッド2」(最後の発言: 2026-10-24(土) 09:00)",
			"- スレッド「スレッド3」(最後の発言: 2026-10-23(金) 09:00)",
			"- スレッド「雑談の続き」",
			"- スレッド「スレッド5」",
			"- スレッド「スレッド4」",
		]);
	});

	it("スレッドのないチャンネルと、見つからないチャンネルは、そう伝える", async () => {
		const { deps } = fakeHistory(CHAT);

		const none = await channelListTool(deps).run({ channel: "質問" });
		const missing = await channelListTool(deps).run({ channel: "運営" });

		expect(none).toBe("#質問には、読めるスレッドがありません。");
		expect(missing).toBe(
			"「運営」という、読めるチャンネルは見つかりませんでした。channelを省いて、チャンネルの名前を確かめてください。",
		);
	});
});

describe("スレッドが作られたメッセージ", () => {
	it("スレッドの名前を書き添える", async () => {
		const { deps } = fakeHistory(CHAT);
		const other = stored(
			said(CHAT, "97901", "ふつうの発言", "2026-10-21T00:00:00.000Z"),
		);
		const messages = [stored(TRIP_STARTER), other];

		const threads = await threadNamesFor(messages, deps);

		expect(threads).toEqual(new Map([[TRIP, "旅行の計画"]]));
		expect(
			messageLine(stored(TRIP_STARTER), BOT.id, {
				names: new Map(),
				threads,
			}),
		).toBe(
			"[2026-10-20(火) 09:00] Alice: 来月、旅行に行かない?\n[スレッド「旅行の計画」]",
		);
		expect(
			toConversation(messages, {
				botUserId: BOT.id,
				includeImages: false,
				names: new Map(),
				threads,
			}).messages.map((message) => message.parts[0]),
		).toEqual([
			{
				type: "text",
				text: "[2026-10-20(火) 09:00] Alice: 来月、旅行に行かない?\n[スレッド「旅行の計画」]",
			},
			{ type: "text", text: "[2026-10-21(水) 09:00] Alice: ふつうの発言" },
		]);
	});
});

describe("スレッドの中での会話の前置き", () => {
	const inThread = (channelId: string, id: string) =>
		stored(
			discordMessage(id, BOB, `<@${BOT.id}> どうする?`, {
				channel_id: channelId,
				timestamp: "2026-10-31T00:00:00.000Z",
			}),
		);

	it("スレッドと親のチャンネルの名前と、スレッドを始めたメッセージを書く", async () => {
		const { deps } = fakeHistory(TRIP);

		const preface = await threadPreface(
			deps,
			[inThread(TRIP, "97801")],
			BOT.id,
		);

		expect(preface).toBe(
			[
				"(この会話は、#雑談 のスレッド「旅行の計画」の中です)",
				"スレッドを始めたメッセージです:",
				"[2026-10-20(火) 09:00] #雑談 Alice: 来月、旅行に行かない?",
			].join("\n"),
		);
	});

	it("フォーラムの投稿なら、投稿の最初のメッセージを、保存していなければDiscordから読み、保存にも回す", async () => {
		const first = said(
			POST,
			POST,
			"引っ越し先の相談です",
			"2026-10-10T00:00:00.000Z",
		);
		const { deps, fetched, ingested } = fakeHistory(POST, [first]);

		const preface = await threadPreface(
			deps,
			[inThread(POST, "97802")],
			BOT.id,
		);

		expect(fetched).toEqual([{ channelId: POST, messageId: POST }]);
		expect(ingested).toEqual([POST]);
		expect(preface).toBe(
			[
				"(この会話は、フォーラム #相談 の投稿「引っ越しの相談」の中です)",
				"投稿の最初のメッセージです:",
				"[2026-10-10(土) 09:00] Alice: 引っ越し先の相談です",
			].join("\n"),
		);
	});

	it("始めたメッセージが会話に入っているときと、始めたメッセージがないスレッドでは、名前だけを書く", async () => {
		const { deps: trip } = fakeHistory(TRIP);
		const { deps: noStarter } = fakeHistory(NO_STARTER);

		const included = await threadPreface(
			trip,
			[{ ...stored(TRIP_STARTER), channelId: TRIP }, inThread(TRIP, "97803")],
			BOT.id,
		);
		const missing = await threadPreface(
			noStarter,
			[inThread(NO_STARTER, "97804")],
			BOT.id,
		);

		expect(included).toBe(
			"(この会話は、#雑談 のスレッド「旅行の計画」の中です)",
		);
		expect(missing).toBe(
			"(この会話は、#雑談 のスレッド「雑談の続き」の中です)",
		);
	});

	it("スレッドでなければ、前置きはない", async () => {
		const { deps } = fakeHistory(CHAT);

		expect(
			await threadPreface(deps, [inThread(CHAT, "97805")], BOT.id),
		).toBeNull();
	});

	it("前置きは、会話のいちばん最初に、人の発言として渡す", () => {
		const { messages } = toConversation(
			[stored(discordMessage("97806", BOT, "こんにちは"))],
			{
				botUserId: BOT.id,
				includeImages: false,
				names: new Map(),
				preface: "(この会話は、#雑談 のスレッド「旅行の計画」の中です)",
			},
		);

		expect(messages).toEqual([
			{
				role: "user",
				parts: [
					{
						type: "text",
						text: "(この会話は、#雑談 のスレッド「旅行の計画」の中です)",
					},
				],
			},
			{
				role: "user",
				parts: [{ type: "text", text: "(これより前の会話は残っていません)" }],
			},
			{ role: "assistant", parts: [{ type: "text", text: "こんにちは" }] },
		]);
	});
});
