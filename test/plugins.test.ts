import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ArchiveFormatError,
	ArchiveTooLargeError,
	readTarGz,
} from "../src/plugins/archive";
import {
	loadPlugin,
	parseRepository,
	type RepositoryRef,
} from "../src/plugins/marketplace";
import {
	COMMIT,
	gzip,
	marketplaceJson,
	NAKAMABA_SKILL,
	nakamabaFiles,
	tar,
	tarGz,
} from "./archive-fixtures";
import { mockFetch } from "./helpers";

afterEach(() => {
	vi.restoreAllMocks();
});

const NAKAMABA: RepositoryRef = { owner: "4rtoflow", name: "Nakamaba" };
const ARCHIVE_URL = "https://codeload.github.com/4rtoflow/Nakamaba/tar.gz/HEAD";

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
	return new Blob([bytes]).stream();
}

/** tar.gzを読み、選んだファイルの中身(文字)とコミットを返す */
async function readAll(
	bytes: Uint8Array,
	select: (path: string) => boolean = () => true,
	limits = { maxCompressedBytes: 1024 * 1024, maxExtractedBytes: 1024 * 1024 },
) {
	const files: Record<string, string> = {};
	const { commit } = await readTarGz(streamOf(bytes), {
		...limits,
		select: (entry) => select(entry.path),
		onFile: (entry, content) => {
			files[entry.path] = new TextDecoder().decode(content);
		},
	});
	return { commit, files };
}

describe("tar.gzを読む", () => {
	it("選んだファイルの中身と、paxのヘッダーのコミットを返す(ほかのファイルは読み飛ばす)", async () => {
		const bytes = await tarGz({
			"a.txt": "A",
			"dir/b.txt": "B".repeat(600),
			"dir/c.txt": "",
		});

		const result = await readAll(bytes, (path) => !path.endsWith("a.txt"));

		expect(result).toEqual({
			commit: COMMIT,
			files: {
				"Nakamaba-HEAD/dir/b.txt": "B".repeat(600),
				"Nakamaba-HEAD/dir/c.txt": "",
			},
		});
	});

	it("100バイトを超える位置は、paxとGNUのどちらの形でも読む", async () => {
		const long = `${"d".repeat(60)}/${"e".repeat(60)}/file.txt`;
		for (const gnuLongNames of [false, true]) {
			const bytes = await tarGz(
				{ [long]: "long", short: "s" },
				{ gnuLongNames },
			);

			const { files } = await readAll(bytes);

			expect(files).toEqual({
				[`Nakamaba-HEAD/${long}`]: "long",
				"Nakamaba-HEAD/short": "s",
			});
		}
	});

	it("コミットのヘッダーがなければ、コミットはnull", async () => {
		const bytes = await tarGz({ "a.txt": "A" }, { commit: null });

		expect((await readAll(bytes)).commit).toBeNull();
	});

	it("tarの形でなければArchiveFormatError、上限を超えたらArchiveTooLargeErrorを投げる", async () => {
		await expect(
			readAll(await gzip(new Uint8Array(1024).fill(65))),
		).rejects.toBeInstanceOf(ArchiveFormatError);

		const big = await tarGz({ "big.bin": new Uint8Array(200_000) });
		// 圧縮したままの大きさ
		await expect(
			readAll(big, () => true, {
				maxCompressedBytes: 10,
				maxExtractedBytes: 1024 * 1024,
			}),
		).rejects.toBeInstanceOf(ArchiveTooLargeError);
		// 展開した大きさ(読み飛ばすファイルも数える)
		await expect(
			readAll(big, () => false, {
				maxCompressedBytes: 1024 * 1024,
				maxExtractedBytes: 100_000,
			}),
		).rejects.toBeInstanceOf(ArchiveTooLargeError);
	});

	it("途中で終わっているtarは、ArchiveFormatErrorを投げる", async () => {
		const whole = tar({ "a.txt": "A".repeat(1000) });
		const cut = await gzip(whole.subarray(0, 2048));

		await expect(readAll(cut)).rejects.toBeInstanceOf(ArchiveFormatError);
	});
});

describe("リポジトリの指定", () => {
	it("「持ち主/名前」とGitHubのURLを受け付ける", () => {
		for (const input of [
			"4rtoflow/Nakamaba",
			" 4rtoflow/Nakamaba ",
			"https://github.com/4rtoflow/Nakamaba",
			"https://github.com/4rtoflow/Nakamaba.git",
			"github.com/4rtoflow/Nakamaba/",
			"４rtoflow/Nakamaba",
		]) {
			expect(parseRepository(input)).toEqual(NAKAMABA);
		}
		expect(parseRepository("anthropics/claude-plugins.official")).toEqual({
			owner: "anthropics",
			name: "claude-plugins.official",
		});
	});

	it("形が違えばnull", () => {
		for (const input of [
			"Nakamaba",
			"4rtoflow/Nakamaba/plugins",
			"https://gitlab.com/4rtoflow/Nakamaba",
			"-bad/repo",
			"owner/..",
			"",
		]) {
			expect(parseRepository(input)).toBeNull();
		}
	});
});

/** GitHubの偽物。URLごとにtar.gzを返す(なければ404) */
function mockGitHub(archives: Record<string, Uint8Array | Response>) {
	return mockFetch((call) => {
		const archive = archives[call.url.toString()];
		if (archive === undefined) {
			return new Response("Not Found", { status: 404 });
		}
		return archive instanceof Response ? archive : new Response(archive);
	});
}

describe("プラグインを読む", () => {
	it("一覧と同じリポジトリのフォルダから、スキルのSKILL.mdと、ほかのファイルを読む", async () => {
		const calls = mockGitHub({ [ARCHIVE_URL]: await tarGz(nakamabaFiles()) });

		const result = await loadPlugin(NAKAMABA, "nakamaba");

		expect(result).toEqual({
			status: "loaded",
			marketplaceCommit: COMMIT,
			commit: COMMIT,
			skills: [
				{
					directory: "nakamaba",
					file: {
						name: "nakamaba",
						description: "Nakamabaに載せるページを作り、公開・更新する。",
						body: expect.stringContaining(
							["node ", "$", "{CLAUDE_SKILL_DIR}/scripts"].join(""),
						),
					},
					files: [
						{
							path: "scripts/nakamaba.mjs",
							content: new TextEncoder().encode("console.log('nakamaba');\n"),
						},
					],
					tooManyFiles: false,
				},
			],
		});
		expect(calls.map((call) => call.url.toString())).toEqual([ARCHIVE_URL]);
		expect(calls[0]?.headers.get("User-Agent")).toContain("Bobert");
	});

	it("版(ref)を指定すると、その版を読む", async () => {
		const url = `https://codeload.github.com/4rtoflow/Nakamaba/tar.gz/${COMMIT}`;
		mockGitHub({ [url]: await tarGz(nakamabaFiles()) });

		const result = await loadPlugin(NAKAMABA, "nakamaba", COMMIT);

		expect(result.status).toBe("loaded");
	});

	it("metadata.pluginRootがあれば、「./」で始まらない位置の前に付ける", async () => {
		mockGitHub({
			[ARCHIVE_URL]: await tarGz({
				".claude-plugin/marketplace.json": marketplaceJson(
					[{ name: "notes", source: "notes" }],
					{ metadata: { pluginRoot: "./plugins" } },
				),
				"plugins/notes/skills/meeting-notes/SKILL.md": [
					"---",
					"name: meeting-notes",
					"description: 議事録を書く",
					"---",
					"本文",
				].join("\n"),
			}),
		});

		const result = await loadPlugin(NAKAMABA, "notes");

		expect(result).toMatchObject({
			status: "loaded",
			skills: [{ directory: "meeting-notes", files: [] }],
		});
	});

	it("別のGitHubのリポジトリ(github、url、git-subdir)から配られていれば、そのリポジトリのスキルを読む", async () => {
		const skill = (name: string) =>
			["---", `name: ${name}`, "description: 説明", "---", "本文"].join("\n");
		const other = await tarGz(
			{
				"skills/from-root/SKILL.md": skill("from-root"),
				"packages/sub/skills/from-sub/SKILL.md": skill("from-sub"),
			},
			{ root: "other-abc", commit: "f".repeat(40) },
		);
		mockGitHub({
			[ARCHIVE_URL]: await tarGz({
				".claude-plugin/marketplace.json": marketplaceJson([
					{
						name: "by-repo",
						source: { source: "github", repo: "someone/other", sha: "abc1234" },
					},
					{
						name: "by-url",
						source: {
							source: "url",
							url: "https://github.com/someone/other.git",
							ref: "main",
						},
					},
					{
						name: "by-subdir",
						source: {
							source: "git-subdir",
							url: "https://github.com/someone/other",
							path: "packages/sub",
						},
					},
				]),
			}),
			"https://codeload.github.com/someone/other/tar.gz/abc1234": other,
			"https://codeload.github.com/someone/other/tar.gz/main": other,
			"https://codeload.github.com/someone/other/tar.gz/HEAD": other,
		});

		expect(await loadPlugin(NAKAMABA, "by-repo")).toMatchObject({
			status: "loaded",
			marketplaceCommit: COMMIT,
			commit: "f".repeat(40),
			skills: [{ directory: "from-root" }],
		});
		expect(await loadPlugin(NAKAMABA, "by-url")).toMatchObject({
			skills: [{ directory: "from-root" }],
		});
		expect(await loadPlugin(NAKAMABA, "by-subdir")).toMatchObject({
			skills: [{ directory: "from-sub" }],
		});
	});

	it("一覧より前にプラグインのファイルがあったら、同じコミットを読み直す", async () => {
		const files = nakamabaFiles();
		const early = await tarGz({
			"plugins/nakamaba/skills/nakamaba/SKILL.md": NAKAMABA_SKILL,
			".claude-plugin/marketplace.json": files[
				".claude-plugin/marketplace.json"
			] as string,
		});
		const calls = mockGitHub({
			[ARCHIVE_URL]: early,
			[`https://codeload.github.com/4rtoflow/Nakamaba/tar.gz/${COMMIT}`]: early,
		});

		const result = await loadPlugin(NAKAMABA, "nakamaba");

		expect(result).toMatchObject({
			status: "loaded",
			skills: [{ directory: "nakamaba", file: { name: "nakamaba" } }],
		});
		expect(calls).toHaveLength(2);
	});

	it("ファイルの数か大きさが上限を超えたスキルは、ファイルを残さずに印を付ける", async () => {
		const many: Record<string, string> = {};
		for (let index = 0; index < 201; index++) {
			many[`plugins/nakamaba/skills/nakamaba/data/${index}.txt`] = "x";
		}
		mockGitHub({ [ARCHIVE_URL]: await tarGz(nakamabaFiles(many)) });
		expect(await loadPlugin(NAKAMABA, "nakamaba")).toMatchObject({
			skills: [{ tooManyFiles: true, files: [] }],
		});

		mockGitHub({
			[ARCHIVE_URL]: await tarGz(
				nakamabaFiles({
					"plugins/nakamaba/skills/nakamaba/big.bin": new Uint8Array(
						1024 * 1024 + 1,
					),
				}),
			),
		});
		expect(await loadPlugin(NAKAMABA, "nakamaba")).toMatchObject({
			skills: [{ tooManyFiles: true, files: [] }],
		});
	});

	it("SKILL.mdを読めないスキルは、中身をnullにする。skills/ の直下のファイルと、SKILL.mdのないフォルダは、スキルにしない", async () => {
		mockGitHub({
			[ARCHIVE_URL]: await tarGz(
				nakamabaFiles({
					"plugins/nakamaba/skills/nakamaba/SKILL.md": "名前のないファイル",
					"plugins/nakamaba/skills/README.md": "# skills",
					"plugins/nakamaba/skills/no-skill/notes.txt": "x",
				}),
			),
		});

		expect(await loadPlugin(NAKAMABA, "nakamaba")).toMatchObject({
			status: "loaded",
			skills: [{ directory: "nakamaba", file: null }],
		});
	});

	it("見つからないときは、その理由を返す", async () => {
		const cases: [Record<string, string>, string, unknown][] = [
			[{ "README.md": "x" }, "nakamaba", { status: "no-marketplace" }],
			[
				{ ".claude-plugin/marketplace.json": "{not json" },
				"nakamaba",
				{ status: "no-marketplace" },
			],
			[
				nakamabaFiles() as Record<string, string>,
				"other",
				{ status: "plugin-not-found", available: ["nakamaba"] },
			],
			[
				{
					".claude-plugin/marketplace.json": marketplaceJson([
						{ name: "npm-plugin", source: { source: "npm", package: "x" } },
						{ name: "escape", source: "../outside" },
						{
							name: "gitlab",
							source: { source: "url", url: "https://gitlab.com/a/b.git" },
						},
					]),
				},
				"npm-plugin",
				{ status: "unsupported-source" },
			],
			[
				{
					".claude-plugin/marketplace.json": marketplaceJson([
						{ name: "commands-only", source: "./plugins/commands-only" },
					]),
					"plugins/commands-only/commands/hello.md": "hello",
				},
				"commands-only",
				{ status: "no-skills" },
			],
		];
		for (const [files, plugin, expected] of cases) {
			mockGitHub({ [ARCHIVE_URL]: await tarGz(files) });
			expect(await loadPlugin(NAKAMABA, plugin)).toEqual(expected);
		}
		for (const plugin of ["escape", "gitlab"]) {
			mockGitHub({ [ARCHIVE_URL]: await tarGz(cases[3]?.[0] ?? {}) });
			expect(await loadPlugin(NAKAMABA, plugin)).toEqual({
				status: "unsupported-source",
			});
		}
	});

	it("リポジトリを読めないとき、大きすぎるとき、GitHubに障害があるときは、それぞれ分けて返す", async () => {
		mockGitHub({});
		expect(await loadPlugin(NAKAMABA, "nakamaba")).toEqual({
			status: "unreadable",
			repository: NAKAMABA,
		});

		mockGitHub({ [ARCHIVE_URL]: new Uint8Array([1, 2, 3]) });
		expect(await loadPlugin(NAKAMABA, "nakamaba")).toEqual({
			status: "unreadable",
			repository: NAKAMABA,
		});

		mockGitHub({
			[ARCHIVE_URL]: new Response("x", {
				headers: { "Content-Length": String(31 * 1024 * 1024) },
			}),
		});
		expect(await loadPlugin(NAKAMABA, "nakamaba")).toEqual({
			status: "too-large",
			repository: NAKAMABA,
		});

		mockGitHub({ [ARCHIVE_URL]: new Response("error", { status: 502 }) });
		expect(await loadPlugin(NAKAMABA, "nakamaba")).toEqual({
			status: "github-error",
		});

		mockFetch(() => {
			throw new TypeError("network");
		});
		expect(await loadPlugin(NAKAMABA, "nakamaba")).toEqual({
			status: "github-error",
		});
	});
});
