import type {
	GatewayCloseCodes as DiscordGatewayCloseCodes,
	GatewayIntentBits as DiscordGatewayIntentBits,
	GatewayOpcodes as DiscordGatewayOpcodes,
	InteractionResponseType as DiscordInteractionResponseType,
	InteractionType as DiscordInteractionType,
	MessageFlags as DiscordMessageFlags,
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
} as const;

export const InteractionResponseType = {
	Pong: 1 as DiscordInteractionResponseType.Pong,
	ChannelMessageWithSource:
		4 as DiscordInteractionResponseType.ChannelMessageWithSource,
	DeferredChannelMessageWithSource:
		5 as DiscordInteractionResponseType.DeferredChannelMessageWithSource,
	Modal: 9 as DiscordInteractionResponseType.Modal,
} as const;

export const MessageFlags = {
	Ephemeral: 64 as DiscordMessageFlags.Ephemeral,
} as const;
