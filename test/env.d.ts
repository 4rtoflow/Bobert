import type { D1Migration } from "cloudflare:test";

declare global {
	namespace Cloudflare {
		interface Env {
			/** vitest.config.ts で渡す、D1のマイグレーション */
			TEST_MIGRATIONS: D1Migration[];
		}
	}
}
