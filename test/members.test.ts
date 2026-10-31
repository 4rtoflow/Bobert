import { env } from "cloudflare:workers";
import type { APIGuildMember } from "discord-api-types/v10";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	allowedMentions,
	findMembersTool,
	MAX_NOTIFIED_USERS,
	type MemberDirectory,
	type MemberEntry,
	memberDirectoryLoader,
	mentionedUserIds,
	notifiedUsersByPart,
} from "../src/respond/members";
import { mockFetch } from "./helpers";

afterEach(() => {
	vi.restoreAllMocks();
});

const GUILD_ID = "960";

/** Discordのメンバーの一覧から読んだメンバー */
function member(
	id: string,
	nick: string | null,
	globalName: string | null,
	username: string,
	bot = false,
): MemberEntry {
	return {
		id,
		name: nick ?? globalName ?? username,
		username,
		searchNames: [nick, globalName, username].filter(
			(name): name is string => name !== null,
		),
		bot,
	};
}

/** 偽のメンバーの一覧を渡した、メンバーを探す道具 */
function toolWith(
	members: MemberEntry[],
	source: MemberDirectory["source"] = "discord",
) {
	return findMembersTool(async () => ({ members, source, truncated: false }));
}

const AMA = member("1001", "あま", "Kyota", "kyota_01");
const BOB = member("1002", null, "Bob", "bob");
const BOBBY = member("1003", "Bobby", null, "bobby_z");
const HELPER = member("1004", null, "Helper", "helper_bot", true);

describe("メンバーを探す道具", () => {
	it("ニックネーム、表示名、ユーザー名の一部で探し、メンションの書き方を返す", async () => {
		const tool = toolWith([AMA, BOB, BOBBY]);

		const result = await tool.run({ names: ["kyota"] });

		expect(result).toContain("メンションするときは、<@ID>の形で書きます");
		expect(result).toContain(
			"「kyota」で見つかったメンバー(1人):\n- あま(ユーザー名: kyota_01): <@1001>",
		);
	});

	it("大文字と小文字、全角と半角を区別せず、先頭の@を外す。完全に一致する人を先に並べる", async () => {
		const tool = toolWith([BOBBY, BOB, AMA]);

		const result = await tool.run({ names: ["＠ＢＯＢ"] });

		expect(result).toContain(
			[
				"「＠ＢＯＢ」で見つかったメンバー(2人):",
				"- Bob: <@1002>",
				"- Bobby(ユーザー名: bobby_z): <@1003>",
			].join("\n"),
		);
	});

	it("1回で何人分も探せる。見つからない名前は、そう伝える", async () => {
		const tool = toolWith([AMA, BOB]);

		const result = await tool.run({ names: ["あま", "carol"] });

		expect(result).toContain("「あま」で見つかったメンバー(1人):");
		expect(result).toContain(
			"「carol」という名前のメンバーは見つかりませんでした。",
		);
	});

	it("名前を1つの文字列で渡されても探す", async () => {
		const tool = toolWith([AMA, BOB]);

		const result = await tool.run({ names: "bob" });

		expect(result).toContain(
			"「bob」で見つかったメンバー(1人):\n- Bob: <@1002>",
		);
	});

	it("1つの名前で出すのは10人までで、残りの人数を書く", async () => {
		const members = Array.from({ length: 12 }, (_, index) =>
			member(String(2000 + index), null, null, `user${index + 10}`),
		);
		const tool = toolWith(members);

		const result = await tool.run({ names: ["user"] });

		expect(result).toContain("「user」で見つかったメンバー(12人):");
		// 先頭の書き方の例(<@123456789>)は数えない
		expect(result.match(/<@20\d\d>/g)).toHaveLength(10);
		expect(result).toContain(
			"ほかに2人います。名前をもっと詳しく指定してください。",
		);
	});

	it("名前を省くと、メンバーの一覧を名前の順に返す。Botには(Bot)と書き添える", async () => {
		const tool = toolWith([HELPER, BOB, AMA]);

		const result = await tool.run({});

		expect(result).toContain(
			[
				"メンバーの一覧です(3人)。",
				"- Bob: <@1002>",
				"- Helper(Bot、ユーザー名: helper_bot): <@1004>",
				"- あま(ユーザー名: kyota_01): <@1001>",
			].join("\n"),
		);
	});

	it("全員の一覧を読めず、記録した名前から探したときは、そう書く", async () => {
		const tool = toolWith(
			[
				{
					id: "1001",
					name: "あま",
					username: null,
					searchNames: ["あま"],
					bot: false,
				},
			],
			"recorded",
		);

		const result = await tool.run({ names: ["あま"] });

		expect(result).toContain(
			"サーバーの全員の一覧を読めなかったので、Bobertが記録している名前",
		);
		expect(result).toContain("- あま: <@1001>");
	});
});

describe("メンバーの一覧の読み方", () => {
	function apiMember(
		id: string,
		username: string,
		nick: string | null = null,
	): APIGuildMember {
		return {
			user: {
				id,
				username,
				global_name: null,
				discriminator: "0",
				avatar: null,
			},
			nick,
			roles: [],
			joined_at: "2026-10-01T00:00:00.000Z",
			deaf: false,
			mute: false,
		} as unknown as APIGuildMember;
	}

	it("Discordのメンバーの一覧を読む", async () => {
		const calls = mockFetch(() =>
			Response.json([apiMember("3001", "alice", "ありす")]),
		);

		const directory = await memberDirectoryLoader(
			"bot-token",
			env.DB,
			GUILD_ID,
		)();

		expect(directory.source).toBe("discord");
		expect(directory.members).toEqual([
			{
				id: "3001",
				name: "ありす",
				username: "alice",
				searchNames: ["ありす", "alice"],
				bot: false,
			},
		]);
		expect(calls[0]?.url.pathname).toBe(`/api/v10/guilds/${GUILD_ID}/members`);
		expect(calls[0]?.url.searchParams.get("limit")).toBe("1000");
		expect(calls[0]?.headers.get("Authorization")).toBe("Bot bot-token");
	});

	it("1000人を超えるときは、続きを読む", async () => {
		const first = Array.from({ length: 1000 }, (_, index) =>
			apiMember(String(10_000 + index), `user${index}`),
		);
		const calls = mockFetch((call) =>
			call.url.searchParams.get("after") === null
				? Response.json(first)
				: Response.json([apiMember("20000", "last")]),
		);

		const directory = await memberDirectoryLoader(
			"bot-token",
			env.DB,
			GUILD_ID,
		)();

		expect(directory.members).toHaveLength(1001);
		expect(directory.truncated).toBe(false);
		expect(calls[1]?.url.searchParams.get("after")).toBe("10999");
	});

	it("一覧を読めないとき(Server Members IntentがOFFなど)は、記録した名前を使う", async () => {
		await env.DB.prepare(
			"INSERT INTO guild_members (guild_id, user_id, name, updated_at) VALUES (?, ?, ?, ?)",
		)
			.bind(GUILD_ID, "3002", "ぼぶ", 1)
			.run();
		mockFetch(() =>
			Response.json(
				{ message: "Missing Access", code: 50001 },
				{ status: 403 },
			),
		);

		const directory = await memberDirectoryLoader(
			"bot-token",
			env.DB,
			GUILD_ID,
		)();

		expect(directory).toEqual({
			members: [
				{
					id: "3002",
					name: "ぼぶ",
					username: null,
					searchNames: ["ぼぶ"],
					bot: false,
				},
			],
			source: "recorded",
			truncated: false,
		});
	});
});

describe("AIが書いたメンションの通知", () => {
	it("人へのメンションのIDを、出てきた順に1回ずつ取り出す。ロールは含めない", () => {
		expect(mentionedUserIds("<@1> と <@!2> と <@&3> と <@1>")).toEqual([
			"1",
			"2",
		]);
	});

	it("コードの中のメンションは含めない", () => {
		expect(
			mentionedUserIds("`<@4>` の形で書く\n```\n<@5>\n```\n<@6> さん"),
		).toEqual(["6"]);
	});

	it("分けた返答の全体で、出てきた順に上限の人数まで通知する", () => {
		const ids = Array.from({ length: 12 }, (_, index) => String(100 + index));
		const parts = [
			ids
				.slice(0, 8)
				.map((id) => `<@${id}>`)
				.join(" "),
			// 2通目は、1通目と同じ人(100)と、新しい4人
			["100", ...ids.slice(8)].map((id) => `<@${id}>`).join(" "),
		];

		const notified = notifiedUsersByPart(parts);

		expect(MAX_NOTIFIED_USERS).toBe(10);
		expect(notified[0]).toEqual(ids.slice(0, 8));
		expect(notified[1]).toEqual(["100", "108", "109"]);
	});

	it("通知する人がいなければ、usersを付けない", () => {
		expect(allowedMentions([], true)).toEqual({
			parse: [],
			replied_user: true,
		});
		expect(allowedMentions(["1"])).toEqual({ parse: [], users: ["1"] });
	});
});
