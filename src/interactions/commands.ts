import type { RESTPutAPIApplicationCommandsJSONBody } from "discord-api-types/v10";
import {
	ApplicationCommandType,
	ApplicationIntegrationType,
	InteractionContextType,
} from "../discord/constants";

/** サーバー内だけで使えるコマンドにする。DMでの会話は後回しにしているため */
const GUILD_ONLY = {
	type: ApplicationCommandType.ChatInput,
	contexts: [InteractionContextType.Guild],
	integration_types: [ApplicationIntegrationType.GuildInstall],
};

/**
 * Discordに登録するコマンド(仕様: docs/spec/behavior.md「スラッシュコマンド」)。名前は英語、説明は日本語。
 * 実装したものから足していく。登録は管理用エンドポイント(POST /admin/commands/register)から行う。
 */
export const COMMANDS: RESTPutAPIApplicationCommandsJSONBody = [
	{
		...GUILD_ONLY,
		name: "setup",
		description: "Anthropic APIキーの登録・OpenRouterへのログイン",
	},
	{
		...GUILD_ONLY,
		name: "model",
		description: "使うモデルの変更",
	},
	{
		...GUILD_ONLY,
		name: "effort",
		description: "AIの思考の深さ(effort)の変更",
	},
	{
		...GUILD_ONLY,
		name: "feat",
		description: "機能のON/OFF(Web検索、利用量の表示、画像の読み取り)",
	},
	{
		...GUILD_ONLY,
		name: "prompt",
		description: "自分用のAIへの指示の設定",
	},
	{
		...GUILD_ONLY,
		name: "settings",
		description: "現在の設定の確認",
	},
	{
		...GUILD_ONLY,
		name: "delete",
		description: "登録したキーと設定の削除",
	},
	{
		...GUILD_ONLY,
		name: "help",
		description: "使い方",
	},
];
