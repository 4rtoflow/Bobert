// mainへのpushで、デプロイの後に、What's NewをDiscordに送り、版のタグを付ける(.github/workflows/deploy.yml)。
// 使い方: node scripts/whats-new.ts [--dry-run]
//   --dry-run: Discordに送らず、タグも作らず、次の版と送る内容を表示するだけにする
// 環境変数: GITHUB_TOKEN、GITHUB_REPOSITORY、GITHUB_SHA、GITHUB_REF_NAME、GITHUB_API_URL(GitHub Actionsが入れる)、
//           WHATS_NEW_WEBHOOK_URL(送り先のDiscordのWebhook。--dry-run では要らない)
// 版の上げ方とラベルの付け方: README「版とWhat's New」

import { parseArgs } from "node:util";
import { releaseWhatsNew } from "./whats-new-lib.ts";

const { values } = parseArgs({
	options: { "dry-run": { type: "boolean", default: false } },
	strict: true,
});

function requiredEnv(name: string): string {
	const value = process.env[name];
	if (!value) {
		console.error(`::error::環境変数 ${name} がありません。`);
		process.exit(1);
	}
	return value;
}

try {
	await releaseWhatsNew({
		repository: requiredEnv("GITHUB_REPOSITORY"),
		sha: requiredEnv("GITHUB_SHA"),
		branch: process.env.GITHUB_REF_NAME || "main",
		githubApiUrl: process.env.GITHUB_API_URL || "https://api.github.com",
		githubToken: requiredEnv("GITHUB_TOKEN"),
		webhookUrl: process.env.WHATS_NEW_WEBHOOK_URL || undefined,
		dryRun: values["dry-run"] ?? false,
		now: new Date(),
		fetch: (url, init) => fetch(url, init),
		sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
		log: (line) => console.log(line),
	});
} catch (error) {
	console.error(
		`::error::${error instanceof Error ? error.message : String(error)}`,
	);
	process.exit(1);
}
