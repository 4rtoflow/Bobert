/**
 * OpenRouterのOAuth(PKCE)のコールバック。
 *
 * これから実装すること(仕様: docs/spec/llm-cost.md「資格情報の登録・保存・削除」):
 * 受け取ったcodeとcode_verifierでユーザー本人のキーを受け取り、暗号化してD1に保存する。
 */
export function handleOpenRouterCallback(
	_request: Request,
	_env: Env,
): Response {
	return new Response("Not Implemented", { status: 501 });
}
