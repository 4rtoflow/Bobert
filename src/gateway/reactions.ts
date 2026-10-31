import type {
	APIEmoji,
	APIGuildMember,
	GatewayMessageReactionAddDispatchData,
	GatewayMessageReactionRemoveAllDispatchData,
	GatewayMessageReactionRemoveEmojiDispatchData,
} from "discord-api-types/v10";
import type { ReactionJob } from "../queue/messages";

/** リアクションの付け外しの通知 */
export const REACTION_EVENTS: ReadonlySet<string> = new Set([
	"MESSAGE_REACTION_ADD",
	"MESSAGE_REACTION_REMOVE",
	"MESSAGE_REACTION_REMOVE_ALL",
	"MESSAGE_REACTION_REMOVE_EMOJI",
]);

/**
 * リアクションの付け外しの通知を、記録に反映する仕事にする(仕様: docs/spec/architecture.md「リアクション」)。
 * サーバーの外のものと、絵文字が分からないものはnull。atは、通知を受け取った時刻
 */
export function reactionJob(
	event: string,
	data: unknown,
	at: number,
): ReactionJob | null {
	const base = data as GatewayMessageReactionRemoveAllDispatchData;
	if (!base.guild_id) {
		return null;
	}
	const target = {
		kind: "reaction" as const,
		guildId: base.guild_id,
		channelId: base.channel_id,
		messageId: base.message_id,
		at,
	};
	if (event === "MESSAGE_REACTION_REMOVE_ALL") {
		return { ...target, action: "remove_all" };
	}
	const emoji = emojiKey(
		(data as GatewayMessageReactionRemoveEmojiDispatchData).emoji,
	);
	if (emoji === null) {
		return null;
	}
	if (event === "MESSAGE_REACTION_REMOVE_EMOJI") {
		return { ...target, action: "remove_emoji", emoji };
	}
	const reaction = data as GatewayMessageReactionAddDispatchData;
	const add = event === "MESSAGE_REACTION_ADD";
	return {
		...target,
		action: add ? "add" : "remove",
		userId: reaction.user_id,
		emoji,
		burst: reaction.burst === true,
		...(add && reaction.member
			? { member: { id: reaction.user_id, name: memberName(reaction.member) } }
			: {}),
	};
}

/** 絵文字の記録の形。Unicodeの絵文字はその文字、カスタム絵文字は「名前:ID」。分からなければnull */
export function emojiKey(emoji: Pick<APIEmoji, "id" | "name">): string | null {
	if (emoji.id) {
		return `${emoji.name ?? ""}:${emoji.id}`;
	}
	return emoji.name || null;
}

/** サーバーで見えている名前。ニックネーム、なければ表示名、それもなければユーザー名 */
function memberName(member: APIGuildMember): string {
	return member.nick ?? member.user.global_name ?? member.user.username;
}
