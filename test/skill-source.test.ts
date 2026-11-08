import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSkillSource, parseSkillSource } from "../src/plugins/skill-source";
import { COMMIT, tarGz } from "./archive-fixtures";
import { mockFetch } from "./helpers";

afterEach(() => {
	vi.restoreAllMocks();
});

const REPOSITORY = { owner: "vercel-labs", name: "agent-skills" };
const ARCHIVE_URL =
	"https://codeload.github.com/vercel-labs/agent-skills/tar.gz/HEAD";

function skillFile(name: string, description = "説明"): string {
	return [
		"---",
		`name: ${name}`,
		`description: ${description}`,
		"---",
		"本文",
	].join("\n");
}

function mockGitHub(archives: Record<string, Uint8Array>) {
	return mockFetch((call) => {
		const archive = archives[call.url.toString()];
		return archive === undefined
			? new Response("Not Found", { status: 404 })
			: new Response(archive);
	});
}

async function archiveOf(files: Record<string, string | Uint8Array>) {
	return tarGz(files, { root: "agent-skills-HEAD" });
}

describe("source の指定", () => {
	it("「持ち主/名前」とGitHubのURLは、既定のブランチの根を探す", () => {
		for (const input of [
			"vercel-labs/agent-skills",
			"https://github.com/vercel-labs/agent-skills",
			"https://github.com/vercel-labs/agent-skills.git",
		]) {
			expect(parseSkillSource(input)).toEqual({
				repository: REPOSITORY,
				ref: "HEAD",
				path: "",
			});
		}
	});

	it("フォルダを指すURLは、そのブランチの、そのフォルダを探す", () => {
		expect(
			parseSkillSource(
				"https://github.com/vercel-labs/agent-skills/tree/main/skills/web-design-guidelines",
			),
		).toEqual({
			repository: REPOSITORY,
			ref: "main",
			path: "skills/web-design-guidelines/",
		});
		expect(
			parseSkillSource("https://github.com/vercel-labs/agent-skills/tree/v1"),
		).toEqual({ repository: REPOSITORY, ref: "v1", path: "" });
	});

	it("形が違えばnull(GitHub以外、フォルダの「..」)", () => {
		for (const input of [
			"agent-skills",
			"https://gitlab.com/org/repo",
			"https://github.com/a/b/tree/main/../x",
		]) {
			expect(parseSkillSource(input)).toBeNull();
		}
	});
});

describe("スキルを探す", () => {
	it("skills/ の下を3段の深さまで探し、浅いところにSKILL.mdがあれば、その下は探さない", async () => {
		mockGitHub({
			[ARCHIVE_URL]: await archiveOf({
				"README.md": "# skills",
				"skills/web-design-guidelines/SKILL.md": skillFile(
					"web-design-guidelines",
				),
				"skills/web-design-guidelines/rules/a.md": "rule",
				"skills/frontend/react-best-practices/SKILL.md": skillFile(
					"react-best-practices",
				),
				"skills/a/b/c/SKILL.md": skillFile("deep"),
				"skills/a/b/c/d/SKILL.md": skillFile("too-deep"),
				// 浅いスキルの下のSKILL.mdは、そのスキルのファイル
				"skills/web-design-guidelines/nested/SKILL.md": skillFile("nested"),
				"examples/other/SKILL.md": skillFile("outside"),
			}),
		});

		const result = await loadSkillSource({
			repository: REPOSITORY,
			ref: "HEAD",
			path: "",
		});

		expect(result.status).toBe("loaded");
		if (result.status !== "loaded") {
			return;
		}
		expect(result.commit).toBe(COMMIT);
		expect(
			result.skills.map((skill) => [
				skill.file?.name,
				skill.files.map((file) => file.path),
			]),
		).toEqual([
			// 3段より深いSKILL.mdは、スキルにせず、浅いスキルのファイルにする
			["deep", ["d/SKILL.md"]],
			["react-best-practices", []],
			["web-design-guidelines", ["nested/SKILL.md", "rules/a.md"]],
		]);
	});

	it(".claude/skills と .agents/skills の下も探す。根にSKILL.mdがあれば、根が1つのスキル", async () => {
		mockGitHub({
			[ARCHIVE_URL]: await archiveOf({
				".claude/skills/one/SKILL.md": skillFile("one"),
				".agents/skills/two/SKILL.md": skillFile("two"),
			}),
		});
		const nested = await loadSkillSource({
			repository: REPOSITORY,
			ref: "HEAD",
			path: "",
		});
		expect(
			nested.status === "loaded"
				? nested.skills.map((skill) => skill.file?.name)
				: [],
		).toEqual(["two", "one"]); // フォルダの位置の順(.agents が先)

		mockGitHub({
			[ARCHIVE_URL]: await archiveOf({
				"SKILL.md": skillFile("root-skill"),
				"scripts/run.sh": "echo hi",
				"skills/other/SKILL.md": skillFile("other"),
			}),
		});
		const root = await loadSkillSource({
			repository: REPOSITORY,
			ref: "HEAD",
			path: "",
		});
		expect(root).toMatchObject({
			status: "loaded",
			skills: [
				{
					file: { name: "root-skill" },
					files: [
						{ path: "scripts/run.sh" },
						{ path: "skills/other/SKILL.md" },
					],
				},
			],
		});
	});

	it("フォルダを指定すると、その中だけを探す", async () => {
		const url =
			"https://codeload.github.com/vercel-labs/agent-skills/tar.gz/main";
		mockGitHub({
			[url]: await archiveOf({
				"skills/one/SKILL.md": skillFile("one"),
				"skills/two/SKILL.md": skillFile("two"),
			}),
		});

		const result = await loadSkillSource({
			repository: REPOSITORY,
			ref: "main",
			path: "skills/two/",
		});

		expect(result).toMatchObject({
			status: "loaded",
			skills: [{ file: { name: "two" } }],
		});
	});

	it("スキルがなければ no-skills、リポジトリを読めなければ unreadable", async () => {
		mockGitHub({ [ARCHIVE_URL]: await archiveOf({ "README.md": "x" }) });
		expect(
			await loadSkillSource({ repository: REPOSITORY, ref: "HEAD", path: "" }),
		).toEqual({ status: "no-skills" });

		mockGitHub({});
		expect(
			await loadSkillSource({ repository: REPOSITORY, ref: "HEAD", path: "" }),
		).toEqual({ status: "unreadable", repository: REPOSITORY });
	});

	it("ファイルが上限を超えたスキルは、ファイルを残さずに印を付ける", async () => {
		mockGitHub({
			[ARCHIVE_URL]: await archiveOf({
				"skills/big/SKILL.md": skillFile("big"),
				"skills/big/data.bin": new Uint8Array(1024 * 1024 + 1),
			}),
		});

		expect(
			await loadSkillSource({ repository: REPOSITORY, ref: "HEAD", path: "" }),
		).toMatchObject({
			status: "loaded",
			skills: [{ file: { name: "big" }, files: [], tooManyFiles: true }],
		});
	});
});
