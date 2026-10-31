import type { APIAllowedMentions, APIGuildMember } from "discord-api-types/v10";
import { DiscordApiError, listGuildMembers } from "../discord/api";
import type { TextTool } from "../llm/types";
import { logEvent } from "../log";
import { listRecordedMembers } from "../store/messages";

/** 1回の呼び出しで探せる名前の数の上限 */
const MAX_NAMES_PER_CALL = 10;
/** 1つの名前で見つかった人のうち、結果に出す人数の上限 */
const MAX_MATCHES_PER_NAME = 10;
/** 名前を省いたときに、一覧に出す人数の上限 */
const MAX_LISTED_MEMBERS = 100;
/** メンバーの一覧を、1回に読む人数(DiscordのAPIの上限) */
const MEMBERS_PER_PAGE = 1000;
/** メンバーの一覧を読む回数の上限(5,000人まで) */
const MAX_MEMBER_PAGES = 5;
/**
 * 1回の返答で、AIが書いたメンションで通知する人数の上限(仕様: docs/spec/behavior.md「通知」)。
 * AIの間違いや、メッセージに書かれた指示で、多くの人に通知が飛ばないようにするため
 */
export const MAX_NOTIFIED_USERS = 10;

/** メンバーを探す道具で使う、メンバーの情報 */
export interface MemberEntry {
	id: string;
	/** サーバーで見えている名前(ニックネーム、なければ表示名、それもなければユーザー名) */
	name: string;
	/** ユーザー名。記録した名前から探したときは分からない */
	username: string | null;
	/** 探すときに照らし合わせる名前(ニックネーム、表示名、ユーザー名) */
	searchNames: string[];
	bot: boolean;
}

/** メンバーを探す道具で探す、メンバーの一覧 */
export interface MemberDirectory {
	members: MemberEntry[];
	/** discordはサーバーの全員の一覧。recordedは、一覧を読めなかったので、Bobertが記録した名前を使ったもの */
	source: "discord" | "recorded";
	/** 人数が多いので、途中までしか読んでいない */
	truncated: boolean;
}

/**
 * サーバーのメンバーの一覧を読む関数を作る(メンバーを探す道具で使う)。
 * 全員の一覧は、Server Members Intentが有効なときだけ読める。読めなければ、Bobertが記録した名前
 * (発言したことのある人と、メンションされた人)を使う
 */
export function memberDirectoryLoader(
	botToken: string,
	db: D1Database,
	guildId: string,
): () => Promise<MemberDirectory> {
	return async () => {
		try {
			const { members, truncated } = await fetchGuildMembers(botToken, guildId);
			return {
				members: members.flatMap((member) => {
					const entry = fromGuildMember(member);
					return entry ? [entry] : [];
				}),
				source: "discord",
				truncated,
			};
		} catch (error) {
			if (!(error instanceof DiscordApiError)) {
				throw error;
			}
			// Server Members IntentがOFFだと、ここに来る
			logEvent("respond", "members_unavailable", {
				guildId,
				status: error.status,
				code: error.code,
			});
			const recorded = await listRecordedMembers(db, guildId);
			return {
				members: recorded.map(({ id, name }) => ({
					id,
					name,
					username: null,
					searchNames: [name],
					bot: false,
				})),
				source: "recorded",
				truncated: false,
			};
		}
	};
}

/** サーバーのメンバーを、上限の回数まで読み進めて集める */
async function fetchGuildMembers(
	botToken: string,
	guildId: string,
): Promise<{ members: APIGuildMember[]; truncated: boolean }> {
	const members: APIGuildMember[] = [];
	let after: string | null = null;
	for (let page = 0; page < MAX_MEMBER_PAGES; page++) {
		const batch = await listGuildMembers(botToken, guildId, {
			after,
			limit: MEMBERS_PER_PAGE,
		});
		members.push(...batch);
		const last = batch.at(-1)?.user.id;
		if (batch.length < MEMBERS_PER_PAGE || last === undefined) {
			return { members, truncated: false };
		}
		after = last;
	}
	return { members, truncated: true };
}

function fromGuildMember(member: APIGuildMember): MemberEntry | null {
	const { user } = member;
	if (!user) {
		return null;
	}
	return {
		id: user.id,
		name: member.nick ?? user.global_name ?? user.username,
		username: user.username,
		searchNames: [member.nick, user.global_name, user.username].filter(
			(name): name is string => typeof name === "string" && name !== "",
		),
		bot: user.bot === true,
	};
}

/**
 * メンバーを探す道具(仕様: docs/spec/architecture.md「メンバーとメンション」)。
 * 名前の一部で探し、見つかった人の名前と、メンションの書き方(<@ID>)を返す。名前を省くと、メンバーの一覧を返す
 */
export function findMembersTool(
	loadMembers: () => Promise<MemberDirectory>,
): TextTool {
	return {
		name: "find_members",
		description:
			"このサーバーのメンバーを名前で探し、メンションの書き方(<@ID>)を返します。名前を省くと、メンバーの一覧を返します。誰かにメンションするときや、サーバーにいる人を確かめるときに使ってください。",
		inputSchema: {
			type: "object",
			properties: {
				names: {
					type: "array",
					items: { type: "string" },
					description: `探す人の名前です(1回で${MAX_NAMES_PER_CALL}人分まで)。ニックネーム、表示名、ユーザー名のどれでも、名前の一部でも探せます。省くと、メンバーの一覧を返します`,
				},
			},
		},
		run: async (input) => {
			const names = namesInput(input.names);
			const directory = await loadMembers();
			const sections =
				names.length === 0
					? [listSection(directory.members)]
					: names
							.slice(0, MAX_NAMES_PER_CALL)
							.map((name) => matchSection(directory.members, name));
			return [
				"メンションするときは、<@ID>の形で書きます(例: <@123456789>)。メンションした人には通知が届きます。",
				...(directory.source === "recorded"
					? [
							"サーバーの全員の一覧を読めなかったので、Bobertが記録している名前(発言したことのある人と、メンションされた人)から探しました。ここにない人もいます。",
						]
					: []),
				...(directory.truncated
					? [
							`メンバーが多いので、${(MAX_MEMBER_PAGES * MEMBERS_PER_PAGE).toLocaleString("en-US")}人までの中から探しました。`,
						]
					: []),
				...sections,
				...(names.length > MAX_NAMES_PER_CALL
					? [
							`1回で探せるのは${MAX_NAMES_PER_CALL}人分までです。残りの名前は、もう一度呼んで探してください。`,
						]
					: []),
			].join("\n\n");
		},
	};
}

/** 名前で探した結果 */
function matchSection(members: readonly MemberEntry[], name: string): string {
	const found = findMembers(members, name);
	if (found.length === 0) {
		return `「${name}」という名前のメンバーは見つかりませんでした。`;
	}
	const shown = found.slice(0, MAX_MATCHES_PER_NAME);
	return [
		`「${name}」で見つかったメンバー(${found.length}人):`,
		...shown.map(memberLine),
		...(found.length > shown.length
			? [
					`ほかに${found.length - shown.length}人います。名前をもっと詳しく指定してください。`,
				]
			: []),
	].join("\n");
}

/** 名前を省いたときの、メンバーの一覧 */
function listSection(members: readonly MemberEntry[]): string {
	if (members.length === 0) {
		return "メンバーが見つかりませんでした。";
	}
	const sorted = [...members].sort(compareMembers);
	const shown = sorted.slice(0, MAX_LISTED_MEMBERS);
	return [
		`メンバーの一覧です(${members.length}人)。`,
		...shown.map(memberLine),
		...(sorted.length > shown.length
			? [
					`ほかに${sorted.length - shown.length}人います。名前を指定して探してください。`,
				]
			: []),
	].join("\n");
}

/**
 * 1人分の行。例: 「- Alice(ユーザー名: alice123): <@111>」。
 * ユーザー名は、見えている名前と(大文字と小文字などを除いて)同じなら書かない
 */
function memberLine(member: MemberEntry): string {
	const notes = [
		...(member.bot ? ["Bot"] : []),
		...(member.username !== null &&
		normalizeName(member.username) !== normalizeName(member.name)
			? [`ユーザー名: ${member.username}`]
			: []),
	];
	return `- ${member.name}${notes.length > 0 ? `(${notes.join("、")})` : ""}: <@${member.id}>`;
}

/**
 * 名前の一部で、メンバーを探す。ニックネーム、表示名、ユーザー名のどれかに含まれていれば見つける。
 * 完全に一致する人、先頭が一致する人、一部が一致する人の順に並べる
 */
export function findMembers(
	members: readonly MemberEntry[],
	name: string,
): MemberEntry[] {
	const query = normalizeQuery(name);
	if (query === "") {
		return [];
	}
	return members
		.flatMap((member) => {
			const rank = matchRank(member, query);
			return rank === null ? [] : [{ member, rank }];
		})
		.sort((a, b) => a.rank - b.rank || compareMembers(a.member, b.member))
		.map(({ member }) => member);
}

/** 一致の度合い。0は完全に一致、1は先頭が一致、2は一部が一致。一致しなければnull */
function matchRank(member: MemberEntry, query: string): number | null {
	let best: number | null = null;
	for (const name of member.searchNames) {
		const normalized = normalizeName(name);
		const rank =
			normalized === query
				? 0
				: normalized.startsWith(query)
					? 1
					: normalized.includes(query)
						? 2
						: null;
		if (rank !== null && (best === null || rank < best)) {
			best = rank;
		}
	}
	return best;
}

/** 名前の順(同じ名前なら、IDの順)。並びが毎回同じになるようにする */
function compareMembers(a: MemberEntry, b: MemberEntry): number {
	const nameA = normalizeName(a.name);
	const nameB = normalizeName(b.name);
	if (nameA !== nameB) {
		return nameA < nameB ? -1 : 1;
	}
	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** 照らし合わせに使う形。全角と半角、大文字と小文字を揃え、前後の空白を除く */
function normalizeName(text: string): string {
	return text.normalize("NFKC").toLowerCase().trim();
}

/** 探す名前を、照らし合わせの形にする。先頭の「@」は外す */
function normalizeQuery(text: string): string {
	return normalizeName(text).replace(/^@/, "").trim();
}

/** AIが指定した名前。1つの文字列で渡されても受け付ける。空のものは除く */
function namesInput(value: unknown): string[] {
	const values = Array.isArray(value) ? value : [value];
	return values.flatMap((item) =>
		typeof item === "string" && normalizeQuery(item) !== ""
			? [item.trim()]
			: [],
	);
}

/** 人へのメンション(<@ID>と<@!ID>)。ロールへのメンション(<@&ID>)は含まない */
const USER_MENTION = /<@!?(\d+)>/g;

/**
 * 文に書かれた、人へのメンションのID。出てきた順で、同じ人は1回だけ。
 * コードの中のメンションは、Discordでもメンションにならないので除く
 */
export function mentionedUserIds(text: string): string[] {
	const outsideCode = text
		.replace(/```[\s\S]*?```/g, "")
		.replace(/`[^`\n]*`/g, "");
	const ids: string[] = [];
	for (const match of outsideCode.matchAll(USER_MENTION)) {
		const id = match[1];
		if (id !== undefined && !ids.includes(id)) {
			ids.push(id);
		}
	}
	return ids;
}

/**
 * 返答を分けた各メッセージで、AIが書いたメンションで通知する人(仕様: docs/spec/behavior.md「通知」)。
 * 返答全体で、出てきた順に、上限の人数まで
 */
export function notifiedUsersByPart(parts: readonly string[]): string[][] {
	const notified = new Set<string>();
	return parts.map((part) =>
		mentionedUserIds(part).filter((id) => {
			if (notified.has(id)) {
				return true;
			}
			if (notified.size >= MAX_NOTIFIED_USERS) {
				return false;
			}
			notified.add(id);
			return true;
		}),
	);
}

/**
 * 返答のメッセージの、メンションの通知の設定。usersの人にだけ通知する。
 * @everyone、@here、ロールへのメンションでは通知しない。
 * repliedUserを渡すと、返信先の人(話しかけた人)に通知するかも決める(返信でないメッセージでは渡さない)
 */
export function allowedMentions(
	users: readonly string[],
	repliedUser?: boolean,
): APIAllowedMentions {
	return {
		parse: [],
		...(users.length > 0 ? { users: [...users] } : {}),
		...(repliedUser === undefined ? {} : { replied_user: repliedUser }),
	};
}
