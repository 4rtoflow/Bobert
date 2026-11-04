// Cloudflareへのデプロイ。Cloudflare側のリソースを作り、マイグレーションとシークレットを入れてから、Workerをdeployする。
// 使い方: node scripts/deploy.ts --env dev|production [--secrets-file .env.production] [--dry-run]
// Discord側の設定(Interactions URLやコマンドの登録)は、このスクリプトではまだ扱わない。
// 仕様: docs/spec/architecture.md、準備: docs/setup.md

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

const root = resolve(import.meta.dirname, "..");
const wranglerBin = resolve(root, "node_modules/.bin/wrangler");

// Vectorizeの索引。埋め込みモデル @cf/baai/bge-m3 の次元数(src/store/embedding.ts)と合わせる
const VECTOR_DIMENSIONS = 1024;
const VECTOR_METRIC = "cosine";
// 検索の絞り込みに使うメタデータ(src/store/search.ts、src/queue/ingest.ts と合わせる)
const VECTOR_METADATA_INDEXES = [
	{ propertyName: "author_id", type: "string" },
	{ propertyName: "guild_id", type: "string" },
	{ propertyName: "created_at", type: "number" },
] as const;
// 新しいD1の作成場所。wrangler.jsonc の既存のDBに合わせる(北米東部)
const D1_LOCATION = "enam";

type Env = "dev" | "production";

const { values } = parseArgs({
	options: {
		env: { type: "string" },
		"secrets-file": { type: "string" },
		"dry-run": { type: "boolean", default: false },
	},
	strict: true,
});

const envName = values.env;
if (envName !== "dev" && envName !== "production") {
	fail("--env には dev か production を指定してください");
}
const env: Env = envName;
const dryRun = values["dry-run"] ?? false;
const secretsFile = values["secrets-file"];

// wrangler.jsonc を読む。JSONC の行コメントだけを取り除いて JSON として読む
const rawConfig = readFileSync(resolve(root, "wrangler.jsonc"), "utf8");
const jsonText = rawConfig.replace(/^\s*\/\/.*$/gm, "");
const topConfig = JSON.parse(jsonText) as WranglerConfig;
const config: WranglerConfig =
	env === "production"
		? (topConfig.env?.production ??
			fail("wrangler.jsonc に env.production がありません"))
		: topConfig;
// 開発用は既定の環境なので --env を付けない。本番用は --env production を付ける
const envArgs = env === "production" ? ["--env", "production"] : [];

interface WranglerConfig {
	name: string;
	secrets: { required: string[] };
	queues: {
		producers: { binding: string; queue: string }[];
		consumers: { queue: string }[];
	};
	d1_databases: {
		binding: string;
		database_name: string;
		database_id: string;
	}[];
	vectorize: { binding: string; index_name: string }[];
	env?: { production?: WranglerConfig };
}

const d1 = config.d1_databases[0] ?? fail("d1_databases が設定されていません");
const vectorIndex =
	config.vectorize[0] ?? fail("vectorize が設定されていません");
const queueNames = [
	...new Set([
		...config.queues.producers.map((q) => q.queue),
		...config.queues.consumers.map((q) => q.queue),
	]),
];

// 秘密の値は、引数に入れず、ファイルから読んで標準入力で渡す
const secrets = secretsFile
	? readSecretsFile(resolve(root, secretsFile))
	: null;
if (secrets) {
	const missing = config.secrets.required.filter((name) => !secrets.get(name));
	if (missing.length > 0) {
		fail(`シークレットが足りません: ${missing.join(", ")}`);
	}
}

log(
	`対象: ${config.name}(${env})${dryRun ? "  [ドライラン: 変更はしません]" : ""}`,
);

try {
	await ensureD1();
	await ensureQueues();
	await ensureVectorize();
	await applyMigrations();
	await putSecrets();
	await deployWorker();
} catch (error) {
	fail(error instanceof Error ? error.message : String(error));
}

log("完了しました。");

// --- 各段階 ---

async function ensureD1(): Promise<void> {
	step(`D1データベース ${d1.database_name}`);
	const list = (await runJson(["d1", "list", "--json"])) as {
		name: string;
		uuid?: string;
		id?: string;
	}[];
	const found = list.find((db) => db.name === d1.database_name);
	if (!found) {
		await run(["d1", "create", d1.database_name, "--location", D1_LOCATION], {
			mutating: true,
		});
		// 作成されたIDは、wrangler.jsonc に書き込んでから、もう一度実行してもらう
		fail(
			`作成しました。表示されたIDを wrangler.jsonc の database_id に書いてから、もう一度実行してください`,
		);
	}
	const id = found.uuid ?? found.id;
	if (id !== d1.database_id) {
		fail(
			`wrangler.jsonc の database_id(${d1.database_id})が、既存のDB(${id})と違います`,
		);
	}
	log("  既にあります");
}

async function ensureQueues(): Promise<void> {
	step("Queue");
	const list = (await runJson(["queues", "list", "--json"])) as {
		queue_name: string;
	}[];
	const existing = new Set(list.map((q) => q.queue_name));
	for (const name of queueNames) {
		if (existing.has(name)) {
			log(`  ${name}: 既にあります`);
		} else {
			await run(["queues", "create", name], { mutating: true });
			log(`  ${name}: 作成しました`);
		}
	}
}

async function ensureVectorize(): Promise<void> {
	step(`Vectorize ${vectorIndex.index_name}`);
	const list = (await runJson(["vectorize", "list", "--json"])) as {
		name: string;
	}[];
	if (list.some((index) => index.name === vectorIndex.index_name)) {
		log("  索引: 既にあります");
	} else {
		await run(
			[
				"vectorize",
				"create",
				vectorIndex.index_name,
				`--dimensions=${VECTOR_DIMENSIONS}`,
				`--metric=${VECTOR_METRIC}`,
			],
			{ mutating: true },
		);
		log("  索引: 作成しました");
	}

	// メタデータの索引は、データを入れる前に作っておく必要がある(Vectorizeの制約)
	const metadata = (await runJson([
		"vectorize",
		"list-metadata-index",
		vectorIndex.index_name,
		"--json",
	])) as {
		propertyName?: string;
		property_name?: string;
	}[];
	const indexed = new Set(
		metadata.map((m) => m.propertyName ?? m.property_name),
	);
	for (const { propertyName, type } of VECTOR_METADATA_INDEXES) {
		if (indexed.has(propertyName)) {
			continue;
		}
		await run(
			[
				"vectorize",
				"create-metadata-index",
				vectorIndex.index_name,
				`--propertyName=${propertyName}`,
				`--type=${type}`,
			],
			{ mutating: true },
		);
		log(`  メタデータ索引 ${propertyName}: 作成しました`);
	}
}

async function applyMigrations(): Promise<void> {
	step("D1のマイグレーション");
	await run(["d1", "migrations", "apply", d1.binding, "--remote", ...envArgs], {
		mutating: true,
	});
}

async function putSecrets(): Promise<void> {
	step("シークレット");
	if (!secrets) {
		log("  --secrets-file がないので、設定しません(既存の値はそのまま)");
		return;
	}
	for (const name of config.secrets.required) {
		const value = secrets.get(name) ?? "";
		if (dryRun) {
			log(`  ${name}: 設定します(値は表示しません)`);
			continue;
		}
		await run(["secret", "put", name, ...envArgs], {
			mutating: true,
			input: value,
		});
		log(`  ${name}: 設定しました`);
	}
}

async function deployWorker(): Promise<void> {
	step("Worker のデプロイ");
	await run(["deploy", ...envArgs], { mutating: true });
}

// --- 補助 ---

/** 変更を伴うコマンドは、ドライランのときは表示だけにする。読み取りのコマンドは、ドライランでも実行する */
async function run(
	args: string[],
	options: { mutating: boolean; input?: string },
): Promise<string> {
	const shown = `wrangler ${args.join(" ")}`;
	if (dryRun && options.mutating) {
		log(`  [予定] ${shown}`);
		return "";
	}
	log(`  $ ${shown}`);
	return new Promise((resolvePromise, reject) => {
		const child = spawn(wranglerBin, args, {
			cwd: root,
			// 変更のコマンドは、進みを利用者に見せるため、標準出力もそのまま流す
			stdio: ["pipe", options.mutating ? "inherit" : "pipe", "inherit"],
		});
		let stdout = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) {
				resolvePromise(stdout);
			} else {
				reject(
					new Error(`コマンドが失敗しました(終了コード ${code}): ${shown}`),
				);
			}
		});
		child.stdin.end(options.input ?? "");
	});
}

async function runJson(args: string[]): Promise<unknown> {
	const stdout = await run(args, { mutating: false });
	// wrangler の出力の中で、JSONは行頭の [ か { から始まる
	const start = stdout.search(/^[[{]/m);
	if (start < 0) {
		throw new Error(`JSONの出力が見つかりません: wrangler ${args.join(" ")}`);
	}
	return JSON.parse(stdout.slice(start));
}

function readSecretsFile(path: string): Map<string, string> {
	if (!existsSync(path)) {
		fail(`シークレットのファイルがありません: ${path}`);
	}
	const map = new Map<string, string>();
	for (const line of readFileSync(path, "utf8").split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "" || trimmed.startsWith("#")) {
			continue;
		}
		const eq = trimmed.indexOf("=");
		if (eq < 0) {
			continue;
		}
		const key = trimmed.slice(0, eq).trim();
		const value = trimmed
			.slice(eq + 1)
			.trim()
			.replace(/^(["'])(.*)\1$/, "$2");
		map.set(key, value);
	}
	return map;
}

function step(title: string): void {
	log(`\n== ${title}`);
}

function log(message: string): void {
	console.log(message);
}

function fail(message: string): never {
	console.error(`エラー: ${message}`);
	process.exit(1);
}
