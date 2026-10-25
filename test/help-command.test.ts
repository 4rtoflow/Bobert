import { describe, expect, it } from "vitest";
import {
	InteractionResponseType,
	InteractionType,
	MessageFlags,
} from "../src/discord/constants";
import { COMMANDS } from "../src/interactions/commands";
import { helpText } from "../src/interactions/help";
import { guildInteraction, sendInteraction } from "./helpers";

/** Discordの1メッセージの文字数の上限 */
const DISCORD_MESSAGE_LIMIT = 2000;

describe("/help", () => {
	it("使い方とコマンドの一覧を、本人にだけ見せる", async () => {
		const body = await sendInteraction(
			guildInteraction(InteractionType.ApplicationCommand, {
				id: "16",
				name: "help",
				type: 1,
			}),
		);

		expect(body.type).toBe(InteractionResponseType.ChannelMessageWithSource);
		expect(body.data.flags).toBe(MessageFlags.Ephemeral);
		const lines: string[] = body.data.content.split("\n");
		expect(lines.slice(0, 6)).toEqual([
			"**Bobertの使い方**",
			"- Bobertにメンションするか、Bobertの返答に返信すると、AIが答えます。",
			"- メッセージに返信しながらBobertにメンションすると、そのメッセージについて聞けます。",
			"- 費用は、登録した本人のアカウントに請求されます。まず `/setup` でキーを登録してください。",
			"",
			"**コマンド**",
		]);
		// コマンドの一覧は、登録するコマンドの説明から、登録する順に作る
		expect(lines.slice(6)).toHaveLength(COMMANDS.length);
		expect(lines[6]).toBe(
			"- `/setup`: Anthropic APIキーの登録・OpenRouterへのログイン",
		);
		expect(lines.at(-1)).toBe("- `/help`: 使い方");
	});

	it("Discordの1メッセージの上限(2000文字)に収まる", () => {
		expect(helpText().length).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT);
	});
});
