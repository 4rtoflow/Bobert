/**
 * エージェントの記録(D1)。仕様: docs/spec/architecture.md「エージェント」
 * - agent_users: 利用者ごとに、本人のAnthropicのアカウントに作ったエージェントの設定と環境
 * - agent_channels: エージェントのチャンネル(セッションを終えても、チャンネルを消すまで残す)
 * - agent_counters: 人ごと・サーバーごとの、チャンネルの番号
 */

/** 本人のAnthropicのアカウントに作った、Managed Agentsのエージェントの設定と環境 */
export interface AgentResources {
	agentId: string;
	environmentId: string;
}

/** エージェントのチャンネル */
export interface AgentChannel {
	channelId: string;
	guildId: string;
	ownerId: string;
	number: number;
	/** Managed Agentsのセッション。終えたらnull */
	sessionId: string | null;
	firstMessageId: string | null;
	createdAt: number;
	endedAt: number | null;
}

interface AgentChannelRow {
	channel_id: string;
	guild_id: string;
	owner_id: string;
	number: number;
	session_id: string | null;
	first_message_id: string | null;
	created_at: number;
	ended_at: number | null;
}

function fromRow(row: AgentChannelRow): AgentChannel {
	return {
		channelId: row.channel_id,
		guildId: row.guild_id,
		ownerId: row.owner_id,
		number: row.number,
		sessionId: row.session_id,
		firstMessageId: row.first_message_id,
		createdAt: row.created_at,
		endedAt: row.ended_at,
	};
}

export async function getAgentResources(
	db: D1Database,
	userId: string,
): Promise<AgentResources | null> {
	const row = await db
		.prepare(
			"SELECT agent_id, environment_id FROM agent_users WHERE user_id = ?",
		)
		.bind(userId)
		.first<{ agent_id: string; environment_id: string }>();
	return row === null
		? null
		: { agentId: row.agent_id, environmentId: row.environment_id };
}

export async function saveAgentResources(
	db: D1Database,
	userId: string,
	resources: AgentResources,
	now = Date.now(),
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO agent_users (user_id, agent_id, environment_id, created_at) VALUES (?, ?, ?, ?)
			ON CONFLICT (user_id) DO UPDATE SET agent_id = excluded.agent_id,
				environment_id = excluded.environment_id, created_at = excluded.created_at`,
		)
		.bind(userId, resources.agentId, resources.environmentId, now)
		.run();
}

export async function deleteAgentResources(
	db: D1Database,
	userId: string,
): Promise<void> {
	await db
		.prepare("DELETE FROM agent_users WHERE user_id = ?")
		.bind(userId)
		.run();
}

export async function getAgentChannel(
	db: D1Database,
	channelId: string,
): Promise<AgentChannel | null> {
	const row = await db
		.prepare("SELECT * FROM agent_channels WHERE channel_id = ?")
		.bind(channelId)
		.first<AgentChannelRow>();
	return row === null ? null : fromRow(row);
}

/** 本人が、そのサーバーで終えていないセッションのチャンネル。古い順 */
export async function activeAgentChannels(
	db: D1Database,
	guildId: string,
	ownerId: string,
): Promise<AgentChannel[]> {
	const { results } = await db
		.prepare(
			`SELECT * FROM agent_channels
			WHERE guild_id = ? AND owner_id = ? AND session_id IS NOT NULL
			ORDER BY created_at, channel_id`,
		)
		.bind(guildId, ownerId)
		.all<AgentChannelRow>();
	return results.map(fromRow);
}

/** 本人の、すべてのサーバーのエージェントのチャンネル(終えたものも含む) */
export async function agentChannelsOf(
	db: D1Database,
	ownerId: string,
): Promise<AgentChannel[]> {
	const { results } = await db
		.prepare("SELECT * FROM agent_channels WHERE owner_id = ?")
		.bind(ownerId)
		.all<AgentChannelRow>();
	return results.map(fromRow);
}

/** すべてのエージェントのチャンネルの、IDとサーバーと本人。Gatewayが、本人の発言をセッションに送るのに使う */
export async function allAgentChannels(
	db: D1Database,
): Promise<Pick<AgentChannel, "channelId" | "guildId" | "ownerId">[]> {
	const { results } = await db
		.prepare("SELECT channel_id, guild_id, owner_id FROM agent_channels")
		.all<Pick<AgentChannelRow, "channel_id" | "guild_id" | "owner_id">>();
	return results.map((row) => ({
		channelId: row.channel_id,
		guildId: row.guild_id,
		ownerId: row.owner_id,
	}));
}

/** 渡したIDのうち、エージェントのチャンネルのもの */
export async function agentChannelIdsAmong(
	db: D1Database,
	channelIds: readonly string[],
): Promise<Set<string>> {
	const found = new Set<string>();
	// D1の1文のパラメーターの上限(100)に収まるよう、分けて調べる
	for (let start = 0; start < channelIds.length; start += 90) {
		const chunk = channelIds.slice(start, start + 90);
		const { results } = await db
			.prepare(
				`SELECT channel_id FROM agent_channels WHERE channel_id IN (${chunk.map(() => "?").join(", ")})`,
			)
			.bind(...chunk)
			.all<{ channel_id: string }>();
		for (const row of results) {
			found.add(row.channel_id);
		}
	}
	return found;
}

/** サーバーのエージェントのチャンネルのID */
export async function agentChannelIdsOfGuild(
	db: D1Database,
	guildId: string,
): Promise<Set<string>> {
	const { results } = await db
		.prepare("SELECT channel_id FROM agent_channels WHERE guild_id = ?")
		.bind(guildId)
		.all<{ channel_id: string }>();
	return new Set(results.map((row) => row.channel_id));
}

/** 本人がそのサーバーで作る、次のチャンネルの番号(1から) */
export async function nextAgentNumber(
	db: D1Database,
	guildId: string,
	userId: string,
): Promise<number> {
	const row = await db
		.prepare(
			`INSERT INTO agent_counters (guild_id, user_id, last_number) VALUES (?, ?, 1)
			ON CONFLICT (guild_id, user_id) DO UPDATE SET last_number = last_number + 1
			RETURNING last_number`,
		)
		.bind(guildId, userId)
		.first<{ last_number: number }>();
	if (row === null) {
		throw new Error("Failed to count the agent channel number");
	}
	return row.last_number;
}

/**
 * エージェントのチャンネルを記録する。チャンネルの記録が先にあれば、共有しない印も付ける
 * (チャンネルを作ったときの通知で、共有チャンネルと記録されていることがあるため)
 */
export async function insertAgentChannel(
	db: D1Database,
	channel: Omit<AgentChannel, "endedAt" | "firstMessageId">,
): Promise<void> {
	await db.batch([
		db
			.prepare(
				`INSERT INTO agent_channels (channel_id, guild_id, owner_id, number, session_id, created_at)
				VALUES (?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				channel.channelId,
				channel.guildId,
				channel.ownerId,
				channel.number,
				channel.sessionId,
				channel.createdAt,
			),
		db
			.prepare("UPDATE channels SET shared = 0 WHERE channel_id = ?")
			.bind(channel.channelId),
	]);
}

export async function setFirstMessage(
	db: D1Database,
	channelId: string,
	messageId: string,
): Promise<void> {
	await db
		.prepare(
			"UPDATE agent_channels SET first_message_id = ? WHERE channel_id = ?",
		)
		.bind(messageId, channelId)
		.run();
}

/** セッションを終えた印を付ける(チャンネルの記録は残す) */
export async function markAgentChannelEnded(
	db: D1Database,
	channelId: string,
	now = Date.now(),
): Promise<void> {
	await db
		.prepare(
			"UPDATE agent_channels SET session_id = NULL, ended_at = ? WHERE channel_id = ?",
		)
		.bind(now, channelId)
		.run();
}

export async function deleteAgentChannel(
	db: D1Database,
	channelId: string,
): Promise<void> {
	await db
		.prepare("DELETE FROM agent_channels WHERE channel_id = ?")
		.bind(channelId)
		.run();
}

/** 本人の、エージェントの記録をすべて消す(/delete) */
export async function deleteAgentRecordsOf(
	db: D1Database,
	userId: string,
): Promise<void> {
	await db.batch([
		db.prepare("DELETE FROM agent_channels WHERE owner_id = ?").bind(userId),
		db.prepare("DELETE FROM agent_users WHERE user_id = ?").bind(userId),
		db.prepare("DELETE FROM agent_counters WHERE user_id = ?").bind(userId),
	]);
}
