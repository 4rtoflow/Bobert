/**
 * 開発者用のDiscordチャンネルに障害を知らせる(仕様: docs/spec/architecture.md「開発と運用」)。
 * 通知に失敗しても、呼び出し元の処理は止めない。
 */
export async function notifyAdmin(env: Env, message: string): Promise<void> {
	try {
		const response = await fetch(env.ALERT_WEBHOOK_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				content: `[${env.ENVIRONMENT}] ${message}`.slice(0, 2000),
				allowed_mentions: { parse: [] },
			}),
		});
		if (!response.ok) {
			console.error(
				JSON.stringify({ event: "alert_failed", status: response.status }),
			);
		}
	} catch (error) {
		console.error(
			JSON.stringify({ event: "alert_failed", error: String(error) }),
		);
	}
}
