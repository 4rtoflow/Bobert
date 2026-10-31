import type { IncomingMessage } from "../agent/relay";
import { allAgentChannels } from "../agent/store";
import { agentSessionStub } from "../agent/stubs";
import { MessageType } from "../discord/constants";
import type { GatewayMessage } from "./messages";

/** エージェントのチャンネルの、サーバーと本人 */
export interface AgentRoute {
	guildId: string;
	ownerId: string;
}

/** D1の記録を読み直す間隔。作った・消したことの知らせを受け取り損ねても、この間隔で追いつく */
const REFRESH_MS = 5 * 60_000;
/** 読み直しに失敗したときに、次に試すまでの時間 */
const RETRY_MS = 30_000;

/** エージェントに送る発言の種類(普通の発言と返信)。参加やピン留めの通知などは送らない */
const RELAYED_TYPES: ReadonlySet<number> = new Set([
	MessageType.Default,
	MessageType.Reply,
]);

/**
 * Gatewayで受け取った、エージェントのチャンネルの発言を、チャンネルのDurable Objectに順番どおりに渡す
 * (仕様: docs/spec/architecture.md「エージェント」)。
 * どのチャンネルがエージェントのチャンネルかは、D1の記録を読んで覚えておき、作った・消したときに知らせを受ける
 */
export class AgentRouter {
	private channels: Map<string, AgentRoute> | null = null;
	private loadedAt = 0;
	private loading: Promise<void> | null = null;
	/** チャンネルごとに、渡し終わるのを待ってから次を渡す(発言の順番を保つため) */
	private chains = new Map<string, Promise<void>>();

	constructor(
		private readonly env: Env,
		private readonly log: (
			event: string,
			detail: Record<string, unknown>,
		) => void,
	) {}

	/** エージェントのチャンネルなら、そのサーバーと本人を返す */
	async find(channelId: string): Promise<AgentRoute | undefined> {
		await this.ensureLoaded();
		return this.channels?.get(channelId);
	}

	/** サーバーのエージェントのチャンネルのID */
	async inGuild(guildId: string): Promise<string[]> {
		await this.ensureLoaded();
		return [...(this.channels ?? new Map<string, AgentRoute>())]
			.filter(([, route]) => route.guildId === guildId)
			.map(([channelId]) => channelId);
	}

	add(channelId: string, route: AgentRoute): void {
		this.channels?.set(channelId, route);
	}

	remove(channelId: string): void {
		this.channels?.delete(channelId);
	}

	/**
	 * 発言をチャンネルのDurable Objectに渡す。Bobert自身の発言と、参加やピン留めの通知などは渡さない。
	 * 待たずに戻る(Gatewayの受信を止めないため)
	 */
	deliver(message: GatewayMessage, botUserId: string | null): void {
		if (message.author.id === botUserId || !RELAYED_TYPES.has(message.type)) {
			return;
		}
		const channelId = message.channel_id;
		const incoming = toIncomingMessage(message);
		const previous = this.chains.get(channelId) ?? Promise.resolve();
		const next = previous
			.then(() => agentSessionStub(this.env, channelId).receive(incoming))
			.catch((error: unknown) => {
				this.log("agent_deliver_failed", {
					channelId,
					error: error instanceof Error ? error.message : String(error),
				});
			});
		this.chains.set(channelId, next);
		void next.finally(() => {
			if (this.chains.get(channelId) === next) {
				this.chains.delete(channelId);
			}
		});
	}

	private async ensureLoaded(): Promise<void> {
		if (this.channels !== null && Date.now() - this.loadedAt < REFRESH_MS) {
			return;
		}
		this.loading ??= this.load().finally(() => {
			this.loading = null;
		});
		await this.loading;
	}

	private async load(): Promise<void> {
		try {
			const rows = await allAgentChannels(this.env.DB);
			this.channels = new Map(
				rows.map((row) => [
					row.channelId,
					{ guildId: row.guildId, ownerId: row.ownerId },
				]),
			);
			this.loadedAt = Date.now();
		} catch (error) {
			this.log("agent_channels_load_failed", {
				error: error instanceof Error ? error.message : String(error),
			});
			this.channels ??= new Map();
			// 少し待ってから、もう一度読む
			this.loadedAt = Date.now() - REFRESH_MS + RETRY_MS;
		}
	}
}

/** Gatewayのメッセージを、エージェントのチャンネルのDurable Objectに渡す形にする */
export function toIncomingMessage(message: GatewayMessage): IncomingMessage {
	return {
		id: message.id,
		authorId: message.author.id,
		fromBot: message.author.bot === true || Boolean(message.webhook_id),
		content: message.content,
		mentions: message.mentions.map((user) => ({
			id: user.id,
			name: user.member?.nick ?? user.global_name ?? user.username,
		})),
	};
}
