/** エージェントのチャンネルごとのDurable Object(チャンネルのIDで1つ決まる) */
export function agentSessionStub(env: Env, channelId: string) {
	return env.AGENT_SESSION.get(env.AGENT_SESSION.idFromName(channelId));
}

/** GatewayのDurable Object。エージェントのチャンネルを作った・消したことを知らせるのに使う */
export function gatewayStub(env: Env) {
	return env.GATEWAY.get(env.GATEWAY.idFromName("gateway"));
}
