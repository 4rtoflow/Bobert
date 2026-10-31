import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// テスト専用の値(本物の秘密ではない)。テストの実行環境は、wrangler.jsonc の
// secrets.required に挙げた値をプロセスの環境変数から読む。
// DISCORD_PUBLIC_KEY は test/helpers.ts の秘密鍵と対になっている。
const TEST_SECRETS = {
	DISCORD_APPLICATION_ID: "000000000000000000",
	DISCORD_PUBLIC_KEY:
		"788759601e1018c14a593ef46fd6388c7f708ff42a64eadbd23fb3426b65f700",
	DISCORD_BOT_TOKEN: "test-bot-token",
	ADMIN_TOKEN: "test-admin-token",
	ALERT_WEBHOOK_URL: "https://example.com/webhook",
	CREDENTIAL_ENCRYPTION_KEYS: "1:f/c7FM3v50Onh6WplBC9yO3q8t0dNXYWShjedzOvU5g=",
	GITHUB_APP_CLIENT_ID: "Iv23test",
	GITHUB_APP_CLIENT_SECRET: "test-github-client-secret",
	GITHUB_APP_SLUG: "bobert-test",
};
Object.assign(process.env, TEST_SECRETS);

export default defineConfig({
	plugins: [
		cloudflareTest(async () => ({
			wrangler: { configPath: "./wrangler.jsonc" },
			// テストでは本物のVectorizeやWorkers AIにつながない
			remoteBindings: false,
			miniflare: {
				// D1のスキーマは、test/setup.ts でテストの前に作る
				bindings: { TEST_MIGRATIONS: await readD1Migrations("./migrations") },
			},
		})),
	],
	test: {
		setupFiles: ["./test/setup.ts"],
		// テストのファイルごとにworkerdを起動する。同時に起動しすぎると、メモリが足りずに落ちることがあるため
		maxWorkers: 4,
	},
});
