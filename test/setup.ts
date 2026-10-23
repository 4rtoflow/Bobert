import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

// テストのファイルごとに、D1にスキーマを作る
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
