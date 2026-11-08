/**
 * `npx skills add` と同じ指定(GitHubのリポジトリ)から、スキルを探して読む(#107。仕様: docs/spec/behavior.md「スキル」)。
 * 探す場所は、npx skills(vercel-labs/skills)の決まりのうち、一般的なものに合わせる。
 * - リポジトリ(か、指定したフォルダ)の根の SKILL.md
 * - skills/、.claude/skills/、.agents/skills/ の下(3段の深さまで。浅いところにSKILL.mdがあれば、その下は探さない)
 * リポジトリは、プラグインと同じく、GitHubのtar.gzで読む
 */

import {
	MAX_SKILL_FILE_BYTES,
	MAX_SKILL_FILES,
	MAX_SKILL_FILES_BYTES,
	MAX_TEXT_BYTES,
	type PluginSkill,
	parseRepository,
	type RepositoryRef,
	readArchive,
	readSkillText,
} from "./marketplace";

/** スキルを探すリポジトリと、版とフォルダ */
export interface SkillSource {
	repository: RepositoryRef;
	/** 版(ブランチ、タグ、コミット)。指定がなければ既定のブランチの最新(HEAD) */
	ref: string;
	/** 探すフォルダ(リポジトリの根からの位置。末尾は「/」)。根なら空 */
	path: string;
}

/** スキルを探した結果 */
export type SkillSourceLoad =
	| { status: "loaded"; commit: string; skills: PluginSkill[] }
	| { status: "unreadable"; repository: RepositoryRef }
	| { status: "too-large"; repository: RepositoryRef }
	| { status: "no-skills" }
	| { status: "github-error" };

/** スキルを置くフォルダ(npx skills の探す場所のうち、一般的なもの) */
const CONTAINERS = ["skills/", ".claude/skills/", ".agents/skills/"];
/** フォルダの中を探す深さ(npx skills と同じ) */
const MAX_DEPTH = 3;
/** 読んで残すファイルの合計。根のSKILL.mdはリポジトリ全体がスキルになるので、メモリーに収める */
const MAX_COLLECTED_BYTES = 50 * 1024 * 1024;
const SKILL_FILE_NAME = "SKILL.md";

/**
 * 入力された source を読む。「持ち主/名前」、GitHubのURL、フォルダを指すURL
 * (https://github.com/持ち主/名前/tree/ブランチ/フォルダ)を受け付ける。形が違えばnull
 */
export function parseSkillSource(input: string): SkillSource | null {
	const text = input.normalize("NFKC").trim();
	const tree =
		/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)(?:\/(.*?))?\/?$/i.exec(
			text,
		);
	if (tree !== null) {
		const [, owner = "", name = "", ref = "", path = ""] = tree;
		const repository = parseRepository(`${owner}/${name}`);
		const folder = normalizeFolder(decodeURIComponent(path));
		return repository === null || folder === null
			? null
			: { repository, ref: decodeURIComponent(ref), path: folder };
	}
	const repository = parseRepository(text);
	return repository === null ? null : { repository, ref: "HEAD", path: "" };
}

/** 「a/b」を「a/b/」に整える。「..」などを含めばnull */
function normalizeFolder(path: string): string | null {
	const parts = path.split("/").filter((part) => part !== "");
	if (parts.some((part) => part === "." || part === "..")) {
		return null;
	}
	return parts.map((part) => `${part}/`).join("");
}

/** source のスキルを探して読む。refを渡すと、その版(確かめた後の読み直しでは、コミット)を読む */
export async function loadSkillSource(
	source: SkillSource,
	ref = source.ref,
): Promise<SkillSourceLoad> {
	const files = new Map<string, { size: number; content: Uint8Array | null }>();
	let collected = 0;
	let tooLarge = false;
	const result = await readArchive(source.repository, ref, {
		select: (path, size) => {
			if (!path.startsWith(source.path)) {
				return false;
			}
			const relative = path.slice(source.path.length);
			const readable =
				size <=
				(relative.endsWith(SKILL_FILE_NAME)
					? MAX_TEXT_BYTES
					: MAX_SKILL_FILE_BYTES);
			if (readable && collected + size > MAX_COLLECTED_BYTES) {
				tooLarge = true;
			}
			const keep = readable && !tooLarge;
			if (keep) {
				collected += size;
			}
			files.set(relative, { size, content: null });
			return keep;
		},
		onFile: (path, content) => {
			const entry = files.get(path.slice(source.path.length));
			if (entry !== undefined) {
				entry.content = content;
			}
		},
	});
	if (result.status !== "ok") {
		return result;
	}
	if (tooLarge) {
		return { status: "too-large", repository: source.repository };
	}
	const skills = discover(files);
	return skills.length === 0
		? { status: "no-skills" }
		: { status: "loaded", commit: result.commit ?? ref, skills };
}

/**
 * 読んだファイルから、スキルのフォルダを見つけ、スキルにする。
 * 根にSKILL.mdがあれば、根が1つのスキル。なければ、決まったフォルダの下を、浅い順に探す
 */
function discover(
	files: Map<string, { size: number; content: Uint8Array | null }>,
): PluginSkill[] {
	const directories: string[] = [];
	if (files.has(SKILL_FILE_NAME)) {
		directories.push("");
	} else {
		for (const container of CONTAINERS) {
			const found = [...files.keys()]
				.filter(
					(path) =>
						path.startsWith(container) && path.endsWith(`/${SKILL_FILE_NAME}`),
				)
				.map((path) => path.slice(0, -SKILL_FILE_NAME.length))
				.filter((directory) => {
					const depth = directory.slice(container.length).split("/").length - 1;
					return depth >= 1 && depth <= MAX_DEPTH;
				})
				.sort((a, b) => a.length - b.length || (a < b ? -1 : 1));
			for (const directory of found) {
				// 浅いところにSKILL.mdがあれば、その下のSKILL.mdは、そのスキルのファイルとして扱う
				if (
					!directories.some(
						(parent) => directory.startsWith(parent) && parent !== "",
					)
				) {
					directories.push(directory);
				}
			}
		}
	}
	return directories
		.sort((a, b) => (a < b ? -1 : 1))
		.map((directory) => skillAt(files, directory));
}

function skillAt(
	files: Map<string, { size: number; content: Uint8Array | null }>,
	directory: string,
): PluginSkill {
	const skillFile = files.get(`${directory}${SKILL_FILE_NAME}`);
	const others = [...files.entries()]
		.filter(
			([path]) =>
				path.startsWith(directory) && path !== `${directory}${SKILL_FILE_NAME}`,
		)
		.sort(([a], [b]) => (a < b ? -1 : 1));
	const bytes = others.reduce((sum, [, entry]) => sum + entry.size, 0);
	const tooManyFiles =
		others.length > MAX_SKILL_FILES ||
		bytes > MAX_SKILL_FILES_BYTES ||
		others.some(([, entry]) => entry.content === null);
	const name =
		directory === "" ? "" : (directory.slice(0, -1).split("/").at(-1) ?? "");
	return {
		directory: name,
		file:
			skillFile?.content === null || skillFile === undefined
				? null
				: readSkillText(skillFile.content),
		files: tooManyFiles
			? []
			: others.map(([path, entry]) => ({
					path: path.slice(directory.length),
					content: entry.content as Uint8Array,
				})),
		tooManyFiles,
	};
}
