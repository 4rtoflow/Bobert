import type { RESTPutAPIApplicationCommandsJSONBody } from "discord-api-types/v10";
import {
	AGENT_COMMAND_DESCRIPTION,
	AGENT_COMMAND_NAME,
	ENDAGENT_COMMAND_DESCRIPTION,
	ENDAGENT_COMMAND_NAME,
} from "../agent/texts";
import {
	ApplicationCommandOptionType,
	ApplicationCommandType,
	ApplicationIntegrationType,
	InteractionContextType,
	PermissionFlags,
} from "../discord/constants";
import { IMPORT_COMMAND_NAME } from "../import/progress";
import {
	JEV_COMMAND_NAME,
	JEV_QUESTION_MAX_LENGTH,
	JEV_QUESTION_OPTION,
	JEV_QUESTION_OPTION_DESCRIPTION,
	JEV_SLASH_COMMAND_DESCRIPTION,
	JEV_SLASH_COMMAND_NAME,
} from "../jev/texts";
import {
	KNOWLEDGE_CHANNEL_OPTION,
	KNOWLEDGE_CHANNEL_OPTION_DESCRIPTION,
	KNOWLEDGE_COMMAND_DESCRIPTION,
	KNOWLEDGE_COMMAND_NAME,
} from "../knowledge/texts";
import {
	MEMORY_COMMAND_DESCRIPTION,
	MEMORY_COMMAND_NAME,
} from "../memory/texts";
import { COMPACT_COMMAND_NAME } from "../respond/compact-button";
import {
	AGENT_SECRETS_COMMAND_DESCRIPTION,
	AGENT_SECRETS_COMMAND_NAME,
} from "./agent-secrets";
import {
	BOBERTMD_COMMAND_DESCRIPTION,
	BOBERTMD_COMMAND_NAME,
} from "./bobert-md";
import { EXPLAIN_COMMAND_NAME } from "./explain";
import { KNOWLEDGE_CHANNEL_TYPES } from "./knowledge";
import {
	PLUGINS_COMMAND_DESCRIPTION,
	PLUGINS_COMMAND_NAME,
	PLUGINS_MARKETPLACE_OPTION,
	PLUGINS_MARKETPLACE_OPTION_DESCRIPTION,
	PLUGINS_PLUGIN_OPTION,
	PLUGINS_PLUGIN_OPTION_DESCRIPTION,
} from "./plugins";
import {
	SKILLS_COMMAND_NAME,
	SKILLS_FILE_OPTION,
	SKILLS_SKILL_OPTION,
	SKILLS_SOURCE_OPTION,
} from "./skills";

/** サーバー内だけで使えるコマンドにする。DMでの会話は後回しにしているため */
const GUILD_ONLY = {
	type: ApplicationCommandType.ChatInput,
	contexts: [InteractionContextType.Guild],
	integration_types: [ApplicationIntegrationType.GuildInstall],
};

/** メッセージの右クリックメニュー(アプリ)の項目。サーバー内だけで使える */
const MESSAGE_MENU = {
	type: ApplicationCommandType.Message,
	contexts: [InteractionContextType.Guild],
	integration_types: [ApplicationIntegrationType.GuildInstall],
};

/**
 * Discordに登録するコマンド(仕様: docs/spec/behavior.md「スラッシュコマンド」)。名前は英語、説明は日本語。
 * 右クリックメニュー(アプリ)の項目も、ここに並べる(名前は日本語)。
 * 実装したものから足していく。登録は管理用エンドポイント(POST /admin/commands/register)から行う。
 */
export const COMMANDS: RESTPutAPIApplicationCommandsJSONBody = [
	{
		...GUILD_ONLY,
		name: "setup",
		description:
			"Anthropic APIキーの登録・OpenRouterへのログイン・TypeSafe APIキーの登録(Jev用)",
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
		description: "機能のON/OFF(Web検索、利用量の表示)",
	},
	{
		...GUILD_ONLY,
		name: "prompt",
		description: "自分用のAIへの指示の設定",
	},
	{
		...GUILD_ONLY,
		name: MEMORY_COMMAND_NAME,
		description: MEMORY_COMMAND_DESCRIPTION,
	},
	{
		...GUILD_ONLY,
		name: SKILLS_COMMAND_NAME,
		description: "このサーバーでAIが使うスキル(手順や知識)の一覧・追加・編集",
		options: [
			{
				type: ApplicationCommandOptionType.Attachment,
				name: SKILLS_FILE_OPTION,
				description: "追加するSKILL.md。添付しなければ、一覧を出す",
				required: false,
			},
			{
				type: ApplicationCommandOptionType.String,
				name: SKILLS_SOURCE_OPTION,
				description:
					"スキルを配っているGitHubのリポジトリ(例: vercel-labs/agent-skills)。npx skills add と同じ指定",
				required: false,
				max_length: 300,
			},
			{
				type: ApplicationCommandOptionType.String,
				name: SKILLS_SKILL_OPTION,
				description:
					"入れるスキルの名前(例: web-design-guidelines)。省くと、見つかったスキルから選ぶ",
				required: false,
				max_length: 100,
			},
		],
	},
	{
		...GUILD_ONLY,
		name: PLUGINS_COMMAND_NAME,
		description: PLUGINS_COMMAND_DESCRIPTION,
		options: [
			{
				type: ApplicationCommandOptionType.String,
				name: PLUGINS_PLUGIN_OPTION,
				description: PLUGINS_PLUGIN_OPTION_DESCRIPTION,
				required: false,
				max_length: 100,
			},
			{
				type: ApplicationCommandOptionType.String,
				name: PLUGINS_MARKETPLACE_OPTION,
				description: PLUGINS_MARKETPLACE_OPTION_DESCRIPTION,
				required: false,
				max_length: 200,
			},
		],
	},
	{
		...GUILD_ONLY,
		name: BOBERTMD_COMMAND_NAME,
		description: BOBERTMD_COMMAND_DESCRIPTION,
	},
	{
		...GUILD_ONLY,
		name: JEV_SLASH_COMMAND_NAME,
		description: JEV_SLASH_COMMAND_DESCRIPTION,
		options: [
			{
				type: ApplicationCommandOptionType.String,
				name: JEV_QUESTION_OPTION,
				description: JEV_QUESTION_OPTION_DESCRIPTION,
				required: true,
				min_length: 1,
				max_length: JEV_QUESTION_MAX_LENGTH,
			},
		],
	},
	{
		...GUILD_ONLY,
		name: AGENT_COMMAND_NAME,
		description: AGENT_COMMAND_DESCRIPTION,
	},
	{
		...GUILD_ONLY,
		name: ENDAGENT_COMMAND_NAME,
		description: ENDAGENT_COMMAND_DESCRIPTION,
	},
	{
		...GUILD_ONLY,
		name: AGENT_SECRETS_COMMAND_NAME,
		description: AGENT_SECRETS_COMMAND_DESCRIPTION,
	},
	{
		...GUILD_ONLY,
		name: "settings",
		description: "現在の設定の確認",
	},
	{
		...GUILD_ONLY,
		name: "donate",
		description: "サーバーの全員が使えるクレジットの寄付と、残りの確認",
	},
	{
		...GUILD_ONLY,
		name: IMPORT_COMMAND_NAME,
		description:
			"Botが見られるチャンネルの過去のメッセージの取り込みと、進み具合の確認(サーバー管理者用)",
		// 実行できるのは、サーバー管理の権限を持つ人(サーバー設定の「連携サービス」で変えられる)
		default_member_permissions: String(PermissionFlags.ManageGuild),
	},
	{
		...GUILD_ONLY,
		name: KNOWLEDGE_COMMAND_NAME,
		description: KNOWLEDGE_COMMAND_DESCRIPTION,
		// 使えるのは、サーバー管理の権限を持つ人(/import と同じく、サーバー設定の「連携サービス」で変えられる)
		default_member_permissions: String(PermissionFlags.ManageGuild),
		options: [
			{
				type: ApplicationCommandOptionType.Channel,
				name: KNOWLEDGE_CHANNEL_OPTION,
				description: KNOWLEDGE_CHANNEL_OPTION_DESCRIPTION,
				required: false,
				// テキスト、アナウンス、フォーラムだけを選べる(スレッドは、親のチャンネルに従う)
				channel_types: [...KNOWLEDGE_CHANNEL_TYPES],
			},
		],
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
	// 右クリックメニューの項目には、説明がない
	{
		...MESSAGE_MENU,
		name: EXPLAIN_COMMAND_NAME,
	},
	{
		...MESSAGE_MENU,
		name: COMPACT_COMMAND_NAME,
	},
	{
		...MESSAGE_MENU,
		name: JEV_COMMAND_NAME,
	},
];
