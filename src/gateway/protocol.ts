import { GatewayCloseCodes, GatewayIntentBits } from "../discord/constants";

/**
 * Bobertが使うGatewayのインテント。
 * Message Contentは必須(仕様: docs/spec/architecture.md「決定事項」)。
 * Guildsは、チャンネル・スレッド・ロールの変更を受け取り、公開チャンネルかどうかを判定するため
 * (仕様: docs/spec/architecture.md「サーバー全体の公開チャンネル」)
 */
export const BOBERT_INTENTS =
	GatewayIntentBits.Guilds |
	GatewayIntentBits.GuildMessages |
	GatewayIntentBits.MessageContent;

/** 再接続してはいけない切断コード。トークンやインテントなどの設定の誤りを表す。 */
const FATAL_CLOSE_CODES: ReadonlySet<number> = new Set([
	GatewayCloseCodes.AuthenticationFailed,
	GatewayCloseCodes.InvalidShard,
	GatewayCloseCodes.ShardingRequired,
	GatewayCloseCodes.InvalidAPIVersion,
	GatewayCloseCodes.InvalidIntents,
	GatewayCloseCodes.DisallowedIntents,
]);

export function isFatalCloseCode(code: number): boolean {
	return FATAL_CLOSE_CODES.has(code);
}

/** 接続を監視するアラームの間隔。 */
export const WATCHDOG_INTERVAL_MS = 30_000;

/** Gateway用のDurable Objectの名前。1つだけ作る。 */
export const GATEWAY_OBJECT_NAME = "gateway";

/** 位置のヒント。DiscordのGatewayがある北米東部の近くに置く(保証はない)。 */
export const GATEWAY_LOCATION_HINT = "enam";
