/**
 * 1行のJSONでログを出す。
 * 会話の本文とキーは渡さない。記録するのは、ユーザーID、モデル、トークン数、エラーの種類など
 * (仕様: docs/spec/architecture.md「開発と運用」)。
 */
export function logEvent(
	component: string,
	event: string,
	detail: Record<string, unknown> = {},
): void {
	console.log(JSON.stringify({ component, event, ...detail }));
}
