import type {
	ApplicationCommandOptionType as DiscordApplicationCommandOptionType,
	ApplicationCommandType as DiscordApplicationCommandType,
	ApplicationIntegrationType as DiscordApplicationIntegrationType,
	ButtonStyle as DiscordButtonStyle,
	ChannelType as DiscordChannelType,
	ComponentType as DiscordComponentType,
	GatewayCloseCodes as DiscordGatewayCloseCodes,
	GatewayIntentBits as DiscordGatewayIntentBits,
	GatewayOpcodes as DiscordGatewayOpcodes,
	InteractionContextType as DiscordInteractionContextType,
	InteractionResponseType as DiscordInteractionResponseType,
	InteractionType as DiscordInteractionType,
	MessageFlags as DiscordMessageFlags,
	MessageType as DiscordMessageType,
	TextInputStyle as DiscordTextInputStyle,
} from "discord-api-types/v10";

/*
 * Discord APIの定数。
 * discord-api-types は型だけを使い、値はここで持つ。discord-api-types の実行時の値は
 * CommonJS形式で、Workers用のテスト環境では読み込めないため。
 * 各値は discord-api-types の型に当てはめているので、値を間違えると型チェックで気づける。
 */

export const GatewayOpcodes = {
	Dispatch: 0 as DiscordGatewayOpcodes.Dispatch,
	Heartbeat: 1 as DiscordGatewayOpcodes.Heartbeat,
	Identify: 2 as DiscordGatewayOpcodes.Identify,
	Resume: 6 as DiscordGatewayOpcodes.Resume,
	Reconnect: 7 as DiscordGatewayOpcodes.Reconnect,
	InvalidSession: 9 as DiscordGatewayOpcodes.InvalidSession,
	Hello: 10 as DiscordGatewayOpcodes.Hello,
	HeartbeatAck: 11 as DiscordGatewayOpcodes.HeartbeatAck,
} as const;

export const GatewayIntentBits = {
	Guilds: 1 as DiscordGatewayIntentBits.Guilds,
	GuildMessages: 512 as DiscordGatewayIntentBits.GuildMessages,
	DirectMessages: 4096 as DiscordGatewayIntentBits.DirectMessages,
	MessageContent: 32768 as DiscordGatewayIntentBits.MessageContent,
} as const;

export const GatewayCloseCodes = {
	AuthenticationFailed: 4004 as DiscordGatewayCloseCodes.AuthenticationFailed,
	InvalidShard: 4010 as DiscordGatewayCloseCodes.InvalidShard,
	ShardingRequired: 4011 as DiscordGatewayCloseCodes.ShardingRequired,
	InvalidAPIVersion: 4012 as DiscordGatewayCloseCodes.InvalidAPIVersion,
	InvalidIntents: 4013 as DiscordGatewayCloseCodes.InvalidIntents,
	DisallowedIntents: 4014 as DiscordGatewayCloseCodes.DisallowedIntents,
} as const;

export const InteractionType = {
	Ping: 1 as DiscordInteractionType.Ping,
	ApplicationCommand: 2 as DiscordInteractionType.ApplicationCommand,
	MessageComponent: 3 as DiscordInteractionType.MessageComponent,
	ModalSubmit: 5 as DiscordInteractionType.ModalSubmit,
} as const;

export const InteractionResponseType = {
	Pong: 1 as DiscordInteractionResponseType.Pong,
	ChannelMessageWithSource:
		4 as DiscordInteractionResponseType.ChannelMessageWithSource,
	DeferredChannelMessageWithSource:
		5 as DiscordInteractionResponseType.DeferredChannelMessageWithSource,
	DeferredMessageUpdate:
		6 as DiscordInteractionResponseType.DeferredMessageUpdate,
	UpdateMessage: 7 as DiscordInteractionResponseType.UpdateMessage,
	Modal: 9 as DiscordInteractionResponseType.Modal,
} as const;

export const MessageFlags = {
	Ephemeral: 64 as DiscordMessageFlags.Ephemeral,
} as const;

export const MessageType = {
	Default: 0 as DiscordMessageType.Default,
	Reply: 19 as DiscordMessageType.Reply,
	ChatInputCommand: 20 as DiscordMessageType.ChatInputCommand,
	ContextMenuCommand: 23 as DiscordMessageType.ContextMenuCommand,
} as const;

export const ComponentType = {
	ActionRow: 1 as DiscordComponentType.ActionRow,
	Button: 2 as DiscordComponentType.Button,
	StringSelect: 3 as DiscordComponentType.StringSelect,
	TextInput: 4 as DiscordComponentType.TextInput,
	Label: 18 as DiscordComponentType.Label,
	FileUpload: 19 as DiscordComponentType.FileUpload,
} as const;

export const ButtonStyle = {
	Primary: 1 as DiscordButtonStyle.Primary,
	Secondary: 2 as DiscordButtonStyle.Secondary,
	Success: 3 as DiscordButtonStyle.Success,
	Danger: 4 as DiscordButtonStyle.Danger,
	Link: 5 as DiscordButtonStyle.Link,
} as const;

export const TextInputStyle = {
	Short: 1 as DiscordTextInputStyle.Short,
	Paragraph: 2 as DiscordTextInputStyle.Paragraph,
} as const;

export const ApplicationCommandType = {
	ChatInput: 1 as DiscordApplicationCommandType.ChatInput,
	Message: 3 as DiscordApplicationCommandType.Message,
} as const;

export const ApplicationCommandOptionType = {
	Attachment: 11 as DiscordApplicationCommandOptionType.Attachment,
} as const;

export const InteractionContextType = {
	Guild: 0 as DiscordInteractionContextType.Guild,
} as const;

export const ApplicationIntegrationType = {
	GuildInstall: 0 as DiscordApplicationIntegrationType.GuildInstall,
} as const;

export const ChannelType = {
	GuildText: 0 as DiscordChannelType.GuildText,
	GuildVoice: 2 as DiscordChannelType.GuildVoice,
	GuildCategory: 4 as DiscordChannelType.GuildCategory,
	GuildAnnouncement: 5 as DiscordChannelType.GuildAnnouncement,
	AnnouncementThread: 10 as DiscordChannelType.AnnouncementThread,
	PublicThread: 11 as DiscordChannelType.PublicThread,
	PrivateThread: 12 as DiscordChannelType.PrivateThread,
	GuildStageVoice: 13 as DiscordChannelType.GuildStageVoice,
	GuildForum: 15 as DiscordChannelType.GuildForum,
	GuildMedia: 16 as DiscordChannelType.GuildMedia,
} as const;

/** 権限のビット。discord-api-types の PermissionFlagsBits は実行時の値なので、ここで持つ */
export const PermissionFlags = {
	Administrator: 1n << 3n,
	ManageChannels: 1n << 4n,
	ManageGuild: 1n << 5n,
	ViewChannel: 1n << 10n,
	SendMessages: 1n << 11n,
	ManageMessages: 1n << 13n,
	EmbedLinks: 1n << 14n,
	AttachFiles: 1n << 15n,
	ReadMessageHistory: 1n << 16n,
} as const;

/** チャンネルの権限の上書きの種類 */
export const OverwriteType = {
	Role: 0,
	Member: 1,
} as const;
