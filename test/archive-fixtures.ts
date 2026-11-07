/**
 * テスト用の、GitHubが返すのと同じ形(git archive)のtar.gzを作る。
 * 先頭にpaxのグローバルヘッダー(comment=コミットのID)を置き、ファイルは「リポジトリ名-版/」の下に入れる
 */

/** テストで使うコミットのID */
export const COMMIT = "5e13cf2090027e710b6fb5bbb1a3247753217636";

const encoder = new TextEncoder();

export interface ArchiveSpec {
	/** 先頭のフォルダの名前(既定は Nakamaba-HEAD) */
	root?: string;
	/** paxのグローバルヘッダーに入れるコミット。nullなら、ヘッダーを入れない */
	commit?: string | null;
	/** 長い位置を、GNUの形(L)で書く(既定はpaxの形) */
	gnuLongNames?: boolean;
}

/** ファイルの位置(先頭のフォルダから)と中身から、tar.gzを作る。中身の順に並べる */
export async function tarGz(
	files: Record<string, string | Uint8Array>,
	spec: ArchiveSpec = {},
): Promise<Uint8Array> {
	return gzip(tar(files, spec));
}

/** 圧縮していないtar */
export function tar(
	files: Record<string, string | Uint8Array>,
	spec: ArchiveSpec = {},
): Uint8Array {
	const root = spec.root ?? "Nakamaba-HEAD";
	const blocks: Uint8Array[] = [];
	const commit = spec.commit === undefined ? COMMIT : spec.commit;
	if (commit !== null) {
		blocks.push(...extended("pax_global_header", "g", { comment: commit }));
	}
	blocks.push(header(`${root}/`, 0, "5"));
	for (const [path, content] of Object.entries(files)) {
		const bytes =
			typeof content === "string" ? encoder.encode(content) : content;
		const fullPath = `${root}/${path}`;
		let name = fullPath;
		if (encoder.encode(fullPath).length > 100) {
			if (spec.gnuLongNames) {
				const longName = encoder.encode(`${fullPath}\0`);
				blocks.push(header("././@LongLink", longName.length, "L"));
				blocks.push(padded(longName));
			} else {
				blocks.push(...extended("PaxHeader", "x", { path: fullPath }));
			}
			name = "long-name";
		}
		blocks.push(header(name, bytes.length, "0"));
		blocks.push(padded(bytes));
	}
	blocks.push(new Uint8Array(1024));
	return concat(blocks);
}

export async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
	const stream = new Blob([bytes])
		.stream()
		.pipeThrough(new CompressionStream("gzip"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** ustarのヘッダー */
function header(name: string, size: number, type: string): Uint8Array {
	const block = new Uint8Array(512);
	block.set(encoder.encode(name).subarray(0, 100), 0);
	writeOctal(block, 100, 8, 0o644);
	writeOctal(block, 108, 8, 0);
	writeOctal(block, 116, 8, 0);
	writeOctal(block, 124, 12, size);
	writeOctal(block, 136, 12, 0);
	block[156] = type.charCodeAt(0);
	block.set(encoder.encode("ustar\0"), 257);
	block.set(encoder.encode("00"), 263);
	// チェックサムは、その欄を空白にして数える
	block.fill(0x20, 148, 156);
	const sum = block.reduce((total, byte) => total + byte, 0);
	writeOctal(block, 148, 7, sum);
	return block;
}

/** paxのヘッダー(gはグローバル、xは次のファイルだけ)と、その中身 */
function extended(
	name: string,
	type: "g" | "x",
	records: Record<string, string>,
): Uint8Array[] {
	const body = encoder.encode(
		Object.entries(records)
			.map(([key, value]) => paxRecord(key, value))
			.join(""),
	);
	return [header(name, body.length, type), padded(body)];
}

/** 「長さ 名前=値\n」。長さは、長さの桁も含めたバイト数 */
function paxRecord(key: string, value: string): string {
	const rest = ` ${key}=${value}\n`;
	let length = encoder.encode(rest).length;
	while (String(length).length + encoder.encode(rest).length !== length) {
		length = String(length).length + encoder.encode(rest).length;
	}
	return `${length}${rest}`;
}

function writeOctal(
	block: Uint8Array,
	offset: number,
	length: number,
	value: number,
): void {
	const text = value.toString(8).padStart(length - 1, "0");
	block.set(encoder.encode(`${text}\0`), offset);
}

/** 512バイトにそろえる */
function padded(bytes: Uint8Array): Uint8Array {
	const size = Math.ceil(bytes.length / 512) * 512;
	const out = new Uint8Array(size);
	out.set(bytes);
	return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

/** NakamabaのSKILL.md(短くしたもの)。本文は、スキルのフォルダを${CLAUDE_SKILL_DIR}で指す */
export const NAKAMABA_SKILL = [
	"---",
	"name: nakamaba",
	"description: Nakamabaに載せるページを作り、公開・更新する。",
	`allowed-tools: Bash(node ${"$"}{CLAUDE_SKILL_DIR}/scripts/nakamaba.mjs *)`,
	"---",
	"",
	"# Nakamaba",
	"",
	`node ${"$"}{CLAUDE_SKILL_DIR}/scripts/nakamaba.mjs publish <フォルダ>`,
	"",
].join("\n");

/** Nakamabaと同じ形の、プラグインの一覧(marketplace.json) */
export function marketplaceJson(
	plugins: unknown[] = [
		{ name: "nakamaba", source: "./plugins/nakamaba", description: "公開" },
	],
	extra: Record<string, unknown> = {},
): string {
	return JSON.stringify({
		name: "nakamaba",
		owner: { name: "4rtoflow" },
		...extra,
		plugins,
	});
}

/** Nakamabaのリポジトリと同じ形の、ファイルの並び(一覧が先、プラグインのスキルが後) */
export function nakamabaFiles(
	overrides: Record<string, string | Uint8Array> = {},
): Record<string, string | Uint8Array> {
	return {
		".claude-plugin/marketplace.json": marketplaceJson(),
		"README.md": "# Nakamaba",
		"plugins/nakamaba/.claude-plugin/plugin.json": '{"name":"nakamaba"}',
		"plugins/nakamaba/skills/nakamaba/SKILL.md": NAKAMABA_SKILL,
		"plugins/nakamaba/skills/nakamaba/scripts/nakamaba.mjs":
			"console.log('nakamaba');\n",
		"src/app/handler.ts": "export {};\n",
		...overrides,
	};
}
