import { describe, expect, it } from "vitest";
import {
	ApplicationCommandType,
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
		expect(lines.slice(0, 9)).toEqual([
			"**Bobertの使い方**",
			"- Bobertにメンションするか、Bobertの返答に返信すると、AIが答えます。",
			"- メッセージに返信しながらBobertにメンションすると、そのメッセージについて聞けます。",
			"- メッセージの右クリックメニュー(アプリ)の「Bobertに聞く」: そのメッセージの意味を説明します",
			"- メッセージの右クリックメニュー(アプリ)の「会話を要約」: そのメッセージまでの会話を要約します。長い会話の費用を抑えられます",
			"- 費用は、登録した本人のアカウントに請求されます。まず `/setup` でキーを登録してください。",
			"- サーバーに寄付されたクレジット(`/donate`)があれば、先にそれを使います。キーがなくても使えます。",
			"",
			"**コマンド**",
		]);
		// コマンドの一覧は、登録するスラッシュコマンドの説明から、登録する順に作る(右クリックメニューの項目は入れない)
		expect(lines.slice(9)).toHaveLength(
			COMMANDS.filter(
				(command) => command.type === ApplicationCommandType.ChatInput,
			).length,
		);
		expect(lines[9]).toBe(
			"- `/setup`: Anthropic APIキーの登録・OpenRouterへのログイン",
		);
		expect(lines).toContain(
			"- `/donate`: サーバーの全員が使えるクレジットの寄付と、残りの確認",
		);
		expect(lines.at(-1)).toBe("- `/help`: 使い方");
	});

	it("Discordの1メッセージの上限(2000文字)に収まる", () => {
		expect(helpText().length).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT);
	});
});
