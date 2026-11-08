/**
 * Claude Codeのプラグインの一覧(マーケットプレイス)から、プラグインのスキルを読む
 * (仕様: docs/spec/behavior.md「スキル」、docs/spec/architecture.md「エージェント(Bobert Agent)」)。
 * 一覧は、GitHubのリポジトリの .claude-plugin/marketplace.json(Claude Codeの claude plugin install と同じもの)。
 * リポジトリは、GitHubが返すtar.gz(codeload)でまとめて読む。GitHubのAPIを使わないので、回数の制限にかからない
 */

import { USER_AGENT } from "../github/api";
import { parseSkillFile, type SkillFile } from "../interactions/skill-file";
import { logEvent } from "../log";
import { ArchiveTooLargeError, readTarGz } from "./archive";

/** GitHubのリポジトリ(持ち主/名前) */
export interface RepositoryRef {
	owner: string;
	name: string;
}

/** プラグインのスキル(skills/ の下の、SKILL.mdがあるフォルダ1つ) */
export interface PluginSkill {
	/** skills/ の下のフォルダの名前。SKILL.mdを読めないときに、名前の代わりに使う */
	directory: string;
	/** SKILL.mdの中身。読めなければnull */
	file: SkillFile | null;
	/** SKILL.md以外のファイル。位置は、スキルのフォルダから(例: scripts/nakamaba.mjs) */
	files: PluginFile[];
	/** ファイルの数か大きさが、上限を超えた(超えたスキルのファイルは残さない) */
	tooManyFiles: boolean;
}

export interface PluginFile {
	path: string;
	content: Uint8Array;
}

/** プラグインを読んだ結果 */
export type PluginLoad =
	| {
			status: "loaded";
			/** 一覧のリポジトリのコミット。置き換えるかを確かめた後に、同じものを読み直すのに使う */
			marketplaceCommit: string;
			/** スキルのファイルを読んだリポジトリのコミット(一覧と同じリポジトリなら、marketplaceCommitと同じ) */
			commit: string;
			skills: PluginSkill[];
	  }
	/** リポジトリを読めない(ない、公開されていない、tar.gzが壊れている) */
	| { status: "unreadable"; repository: RepositoryRef }
	| { status: "too-large"; repository: RepositoryRef }
	/** 一覧がないか、JSONとして読めない */
	| { status: "no-marketplace" }
	| { status: "plugin-not-found"; available: string[] }
	/** GitHubのリポジトリ以外(npmなど)から配られている */
	| { status: "unsupported-source" }
	| { status: "no-skills" }
	/** GitHubとのやり取りで、エラーが起きた(つながらない、GitHubの障害) */
	| { status: "github-error" };

/** 圧縮したままのtar.gzの大きさの上限 */
export const MAX_ARCHIVE_BYTES = 30 * 1024 * 1024;
/** 展開した大きさの上限(読み飛ばすファイルも数える)。圧縮しやすいファイルで、時間を使い切らないようにする */
const MAX_EXTRACTED_BYTES = 300 * 1024 * 1024;
/** 一覧(marketplace.json)とSKILL.mdの大きさの上限 */
export const MAX_TEXT_BYTES = 1024 * 1024;
/** 1つのスキルに付けられるファイルの数と大きさ(SKILL.mdは数えない) */
export const MAX_SKILL_FILES = 200;
export const MAX_SKILL_FILE_BYTES = 1024 * 1024;
export const MAX_SKILL_FILES_BYTES = 10 * 1024 * 1024;

const MARKETPLACE_PATH = ".claude-plugin/marketplace.json";
const SKILL_FILE_NAME = "SKILL.md";
const ARCHIVE_BASE = "https://codeload.github.com";

export function repositoryName(repository: RepositoryRef): string {
	return `${repository.owner}/${repository.name}`;
}

/**
 * 入力されたリポジトリを読む。「持ち主/名前」のほか、GitHubのURL(https://github.com/持ち主/名前)も受け付ける。
 * 形が違えばnull
 */
export function parseRepository(input: string): RepositoryRef | null {
	const text = input
		.normalize("NFKC")
		.trim()
		.replace(/^https?:\/\//i, "")
		.replace(/^(?:www\.)?github\.com\//i, "")
		.replace(/\/+$/, "")
		.replace(/\.git$/i, "");
	const match =
		/^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})$/.exec(text);
	if (match === null) {
		return null;
	}
	const [, owner, name] = match as unknown as [string, string, string];
	return name === "." || name === ".." ? null : { owner, name };
}

/**
 * 一覧のリポジトリ(marketplace)から、名前がpluginのプラグインを探し、そのスキルを読む。
 * refは、一覧のリポジトリの版(既定は、既定のブランチの最新)
 */
export async function loadPlugin(
	marketplace: RepositoryRef,
	plugin: string,
	ref = "HEAD",
): Promise<PluginLoad> {
	// 一覧を読むまでは、どのフォルダを残すか分からない。git archiveは名前の順に並ぶので、
	// .claude-plugin/ はふつう最初に来るが、それより前に来たファイルの位置は覚えておき、取りこぼしたら読み直す
	let resolution: Resolution | null = null;
	let collector: SkillCollector | null = null;
	const early: string[] = [];
	const first = await readArchive(marketplace, ref, {
		select: (path, size) => {
			if (path === MARKETPLACE_PATH) {
				return size <= MAX_TEXT_BYTES;
			}
			if (resolution === null) {
				early.push(path);
				return false;
			}
			return collector?.select(path, size) ?? false;
		},
		onFile: (path, content) => {
			if (path === MARKETPLACE_PATH) {
				resolution = resolvePlugin(content, plugin);
				collector =
					resolution.kind === "local"
						? new SkillCollector(resolution.skillsDir)
						: null;
				return;
			}
			collector?.add(path, content);
		},
	});
	if (first.status !== "ok") {
		return first;
	}
	const resolved = resolution as Resolution | null;
	if (resolved === null || resolved.kind === "invalid") {
		return { status: "no-marketplace" };
	}
	if (resolved.kind === "not-found") {
		return { status: "plugin-not-found", available: resolved.available };
	}
	if (resolved.kind === "unsupported") {
		return { status: "unsupported-source" };
	}
	const marketplaceCommit = first.commit ?? ref;
	if (resolved.kind === "local") {
		let skills = (collector as SkillCollector | null)?.skills() ?? [];
		if (early.some((path) => path.startsWith(resolved.skillsDir))) {
			// 一覧より前に、プラグインのファイルがあった。読んだコミットを、もう一度読む
			const again = await readSkills(
				marketplace,
				marketplaceCommit,
				resolved.skillsDir,
			);
			if (again.status !== "ok") {
				return again;
			}
			skills = again.skills;
		}
		return loaded(marketplaceCommit, marketplaceCommit, skills);
	}
	const external = await readSkills(
		resolved.repository,
		resolved.ref,
		resolved.skillsDir,
	);
	if (external.status !== "ok") {
		return external;
	}
	return loaded(
		marketplaceCommit,
		external.commit ?? resolved.ref,
		external.skills,
	);
}

function loaded(
	marketplaceCommit: string,
	commit: string,
	skills: PluginSkill[],
): PluginLoad {
	return skills.length === 0
		? { status: "no-skills" }
		: { status: "loaded", marketplaceCommit, commit, skills };
}

/** 一覧から探したプラグインの、スキルの置き場所 */
type Resolution =
	/** 一覧と同じリポジトリの中。skillsDirは、リポジトリの根からの位置(例: plugins/nakamaba/skills/) */
	| { kind: "local"; skillsDir: string }
	/** 別のGitHubのリポジトリ */
	| {
			kind: "github";
			repository: RepositoryRef;
			ref: string;
			skillsDir: string;
	  }
	| { kind: "not-found"; available: string[] }
	| { kind: "unsupported" }
	/** 一覧の形が違う */
	| { kind: "invalid" };

/** 一覧(marketplace.json)から、名前がpluginのプラグインを探し、スキルの置き場所を決める */
function resolvePlugin(content: Uint8Array, plugin: string): Resolution {
	let marketplace: unknown;
	try {
		// ignoreBOMをfalseにすると、先頭のBOMは外れる
		marketplace = JSON.parse(
			new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
				content,
			),
		);
	} catch {
		return { kind: "invalid" };
	}
	if (!isRecord(marketplace) || !Array.isArray(marketplace.plugins)) {
		return { kind: "invalid" };
	}
	const entries = marketplace.plugins.filter(
		(entry): entry is Record<string, unknown> & { name: string } =>
			isRecord(entry) && typeof entry.name === "string",
	);
	const entry = entries.find((candidate) => candidate.name === plugin);
	if (entry === undefined) {
		return {
			kind: "not-found",
			available: entries.map((candidate) => candidate.name),
		};
	}
	const metadata = isRecord(marketplace.metadata) ? marketplace.metadata : {};
	const pluginRoot =
		typeof metadata.pluginRoot === "string" ? metadata.pluginRoot : "";
	return sourceOf(entry.source, pluginRoot);
}

/**
 * プラグインの配り方(source)から、スキルの置き場所を決める。
 * 一覧と同じリポジトリのフォルダ(「./plugins/nakamaba」。metadata.pluginRootがあれば、「./」で始まらない位置の前に付ける)と、
 * GitHubのリポジトリ(github、GitHubのURLのurlとgit-subdir)に対応する。npmなどには対応しない
 */
function sourceOf(source: unknown, pluginRoot: string): Resolution {
	if (typeof source === "string") {
		const relative = /^(?:\.{1,2}(?:\/|$)|\/)/.test(source);
		const directory = normalizeDirectory(
			relative ? source : `${pluginRoot}/${source}`,
		);
		return directory === null
			? { kind: "unsupported" }
			: { kind: "local", skillsDir: `${directory}skills/` };
	}
	if (!isRecord(source)) {
		return { kind: "unsupported" };
	}
	const ref = refOf(source);
	switch (source.source) {
		case "github": {
			const repository =
				typeof source.repo === "string" ? parseRepository(source.repo) : null;
			return repository === null
				? { kind: "unsupported" }
				: { kind: "github", repository, ref, skillsDir: "skills/" };
		}
		case "url":
		case "git-subdir": {
			const repository =
				typeof source.url === "string" ? githubRepositoryOf(source.url) : null;
			const directory =
				source.source === "url"
					? ""
					: typeof source.path === "string"
						? normalizeDirectory(source.path)
						: null;
			return repository === null || directory === null
				? { kind: "unsupported" }
				: {
						kind: "github",
						repository,
						ref,
						skillsDir: `${directory}skills/`,
					};
		}
	}
	return { kind: "unsupported" };
}

/** 配り方に書かれた版。コミット(sha)、ブランチやタグ(ref)の順に使い、なければ既定のブランチの最新 */
function refOf(source: Record<string, unknown>): string {
	if (typeof source.sha === "string" && /^[0-9a-f]{7,40}$/i.test(source.sha)) {
		return source.sha;
	}
	return typeof source.ref === "string" && source.ref.trim() !== ""
		? source.ref.trim()
		: "HEAD";
}

/** GitHubのURL(https://github.com/持ち主/名前.git)なら、そのリポジトリ */
function githubRepositoryOf(url: string): RepositoryRef | null {
	return /^(?:https?:\/\/)?(?:www\.)?github\.com\//i.test(url.trim())
		? parseRepository(url)
		: null;
}

/**
 * リポジトリの根からのフォルダの位置を整える(「./a/../b」は「b/」、根は空)。根より上に出るならnull
 */
function normalizeDirectory(path: string): string | null {
	const parts: string[] = [];
	for (const part of path.split("/")) {
		if (part === "" || part === ".") {
			continue;
		}
		if (part === "..") {
			if (parts.pop() === undefined) {
				return null;
			}
			continue;
		}
		parts.push(part);
	}
	return parts.map((part) => `${part}/`).join("");
}

/** リポジトリの、skillsDirの下のスキルを読む(一覧と別のリポジトリのときと、読み直すとき) */
async function readSkills(
	repository: RepositoryRef,
	ref: string,
	skillsDir: string,
): Promise<
	| { status: "ok"; commit: string | null; skills: PluginSkill[] }
	| Exclude<ArchiveRead, { status: "ok" }>
> {
	const collector = new SkillCollector(skillsDir);
	const result = await readArchive(repository, ref, {
		select: (path, size) => collector.select(path, size),
		onFile: (path, content) => collector.add(path, content),
	});
	return result.status === "ok"
		? { status: "ok", commit: result.commit, skills: collector.skills() }
		: result;
}

export type ArchiveRead =
	| { status: "ok"; commit: string | null }
	| { status: "unreadable"; repository: RepositoryRef }
	| { status: "too-large"; repository: RepositoryRef }
	| { status: "github-error" };

/** リポジトリのtar.gzを読む。位置は、先頭の「リポジトリ名-版/」を除いて渡す */
export async function readArchive(
	repository: RepositoryRef,
	ref: string,
	visitor: {
		select(path: string, size: number): boolean;
		onFile(path: string, content: Uint8Array): void;
	},
): Promise<ArchiveRead> {
	let response: Response;
	try {
		response = await fetch(archiveUrl(repository, ref), {
			headers: { "User-Agent": USER_AGENT },
		});
	} catch (error) {
		log("archive_fetch_failed", repository, error);
		return { status: "github-error" };
	}
	if (response.status >= 500) {
		await response.body?.cancel();
		log("archive_fetch_failed", repository, response.status);
		return { status: "github-error" };
	}
	if (!response.ok || response.body === null) {
		await response.body?.cancel();
		return { status: "unreadable", repository };
	}
	const declared = Number(response.headers.get("Content-Length"));
	if (declared > MAX_ARCHIVE_BYTES) {
		await response.body.cancel();
		return { status: "too-large", repository };
	}
	try {
		const { commit } = await readTarGz(response.body, {
			maxCompressedBytes: MAX_ARCHIVE_BYTES,
			maxExtractedBytes: MAX_EXTRACTED_BYTES,
			select: (entry) => {
				const path = withoutRoot(entry.path);
				return path !== null && visitor.select(path, entry.size);
			},
			onFile: (entry, content) => {
				const path = withoutRoot(entry.path);
				if (path !== null) {
					visitor.onFile(path, content);
				}
			},
		});
		return { status: "ok", commit };
	} catch (error) {
		if (error instanceof ArchiveTooLargeError) {
			return { status: "too-large", repository };
		}
		log("archive_unreadable", repository, error);
		return { status: "unreadable", repository };
	}
}

function archiveUrl(repository: RepositoryRef, ref: string): string {
	const encodedRef = ref.split("/").map(encodeURIComponent).join("/");
	return `${ARCHIVE_BASE}/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/tar.gz/${encodedRef}`;
}

/** tarの位置から、先頭の「リポジトリ名-版/」を除く。根のフォルダそのものならnull */
function withoutRoot(path: string): string | null {
	const slash = path.indexOf("/");
	return slash === -1 ? null : path.slice(slash + 1);
}

/** skills/ の下のスキルを、フォルダごとに集める */
class SkillCollector {
	private readonly entries = new Map<
		string,
		PluginSkill & { hasSkillFile: boolean; count: number; bytes: number }
	>();

	constructor(private readonly skillsDir: string) {}

	/** 中身を読むファイルか。数や大きさが上限を超えたスキルは、それ以上読まない */
	select(path: string, size: number): boolean {
		const located = this.locate(path);
		if (located === null) {
			return false;
		}
		const entry = this.entry(located.directory);
		if (located.relative === SKILL_FILE_NAME) {
			entry.hasSkillFile = true;
			// 大きすぎるSKILL.mdは読まない(読めないものとして扱う)
			return size <= MAX_TEXT_BYTES;
		}
		entry.count++;
		entry.bytes += size;
		if (
			entry.count > MAX_SKILL_FILES ||
			size > MAX_SKILL_FILE_BYTES ||
			entry.bytes > MAX_SKILL_FILES_BYTES
		) {
			entry.tooManyFiles = true;
			entry.files = [];
		}
		return !entry.tooManyFiles;
	}

	add(path: string, content: Uint8Array): void {
		const located = this.locate(path);
		if (located === null) {
			return;
		}
		const entry = this.entry(located.directory);
		if (located.relative === SKILL_FILE_NAME) {
			entry.file = readSkillText(content);
		} else if (!entry.tooManyFiles) {
			entry.files.push({ path: located.relative, content });
		}
	}

	/** SKILL.mdがあったフォルダのスキル。フォルダの名前の順 */
	skills(): PluginSkill[] {
		return [...this.entries.values()]
			.filter((entry) => entry.hasSkillFile)
			.sort((a, b) => (a.directory < b.directory ? -1 : 1))
			.map(({ directory, file, files, tooManyFiles }) => ({
				directory,
				file,
				files: files.sort((a, b) => (a.path < b.path ? -1 : 1)),
				tooManyFiles,
			}));
	}

	/**
	 * skills/ の下の、スキルのフォルダの中のファイルなら、フォルダの名前と、フォルダからの位置。
	 * skills/ の直下のファイルと、「..」などを含む位置は、スキルのファイルとして扱わない
	 */
	private locate(path: string): { directory: string; relative: string } | null {
		if (!path.startsWith(this.skillsDir)) {
			return null;
		}
		const parts = path.slice(this.skillsDir.length).split("/");
		if (
			parts.length < 2 ||
			parts.some((part) => part === "" || part === "." || part === "..")
		) {
			return null;
		}
		const [directory, ...rest] = parts as [string, ...string[]];
		return { directory, relative: rest.join("/") };
	}

	private entry(directory: string) {
		let entry = this.entries.get(directory);
		if (entry === undefined) {
			entry = {
				directory,
				file: null,
				files: [],
				tooManyFiles: false,
				hasSkillFile: false,
				count: 0,
				bytes: 0,
			};
			this.entries.set(directory, entry);
		}
		return entry;
	}
}

/** SKILL.mdを読む。UTF-8でないか、名前と説明がなければnull */
export function readSkillText(content: Uint8Array): SkillFile | null {
	try {
		// ignoreBOMをfalseにすると、先頭のBOMは外れる
		const text = new TextDecoder("utf-8", {
			fatal: true,
			ignoreBOM: false,
		}).decode(content);
		return parseSkillFile(text);
	} catch {
		return null;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function log(event: string, repository: RepositoryRef, detail: unknown): void {
	logEvent("plugins", event, {
		repository: repositoryName(repository),
		detail:
			detail instanceof Error
				? detail.name
				: typeof detail === "number"
					? detail
					: "unknown",
	});
}
