/**
 * サーバー共通のスキル(仕様: docs/spec/behavior.md「スキル」)。
 * サーバーの中で、名前ごとに1行。誰でも登録・編集・削除できるので、登録した人と最後に編集した人を残す
 */

/** 1サーバーに登録できるスキルの数。AnthropicのAPIで1回に使えるスキルの数と同じ */
export const MAX_SKILLS = 20;
/** 名前の長さの上限(Agent Skillsの規則) */
export const MAX_SKILL_NAME_LENGTH = 64;
/** 説明の長さの上限(Agent Skillsの上限と同じ) */
export const MAX_DESCRIPTION_LENGTH = 1024;
/** 本文の長さの上限(ファイルで登録するとき。入力画面からは、Discordの入力欄の上限まで) */
export const MAX_BODY_LENGTH = 20_000;

/** 名前の規則(Agent Skillsと同じ)。英小文字、数字、ハイフンだけ */
const NAME_PATTERN = /^[a-z0-9-]+$/;

/** スキルの中身 */
export interface SkillContent {
	name: string;
	description: string;
	body: string;
}

/** 一覧に出す、スキルの概要(本文を除く) */
export interface SkillSummary {
	id: number;
	name: string;
	description: string;
	/** 登録した人の、そのときにサーバーで見えていた名前 */
	createdByName: string;
	createdAt: number;
	/** 最後に編集した人の、そのときにサーバーで見えていた名前。編集されていなければnull */
	editedByName: string | null;
	/** 最後に登録か編集をした日時 */
	updatedAt: number;
	/** 付いているファイル(スクリプトなど)の数。ファイルが付いたスキルは、エージェントだけで使う */
	fileCount: number;
	/** プラグインから入れたスキルの入手元。手で登録したスキルはnull */
	source: SkillSource | null;
}

/** プラグインから入れたスキルの入手元 */
export interface SkillSource {
	/** プラグインの一覧(マーケットプレイス)のGitHubのリポジトリ(例: 4rtoflow/Nakamaba) */
	repository: string;
	/** プラグインの名前 */
	plugin: string;
	/** スキルのファイルを読んだコミット */
	commit: string;
}

/** スキルに付いたファイル。位置は、スキルのフォルダから(例: scripts/nakamaba.mjs) */
export interface SkillFileData {
	path: string;
	content: Uint8Array;
}

export interface Skill extends SkillSummary {
	body: string;
}

/** スキルを登録・編集した人。名前は、サーバーで見えている名前 */
export interface SkillEditor {
	id: string;
	name: string;
}

interface SkillRow {
	id: number;
	name: string;
	description: string;
	created_by_name: string;
	created_at: number;
	edited_by_name: string | null;
	updated_at: number;
	source_repository: string | null;
	source_plugin: string | null;
	source_commit: string | null;
	file_count: number;
	body?: string;
}

const SUMMARY_COLUMNS = `id, name, description, created_by_name, created_at, edited_by_name, updated_at,
	source_repository, source_plugin, source_commit,
	(SELECT COUNT(*) FROM skill_files WHERE skill_files.skill_id = skills.id) AS file_count`;

/** 文字数。絵文字のようにUTF-16で2つになる文字も、1文字と数える */
export function countCharacters(text: string): number {
	return [...text].length;
}

/** 名前が、Agent Skillsの規則(英小文字、数字、ハイフンで64文字まで)に合っているか */
export function isValidSkillName(name: string): boolean {
	return name.length <= MAX_SKILL_NAME_LENGTH && NAME_PATTERN.test(name);
}

/** サーバーのスキルの概要。名前の順に並べる(AIに渡す一覧が毎回同じ並びになるように) */
export async function listSkills(
	db: D1Database,
	guildId: string,
): Promise<SkillSummary[]> {
	const { results } = await db
		.prepare(
			`SELECT ${SUMMARY_COLUMNS} FROM skills WHERE guild_id = ? ORDER BY name`,
		)
		.bind(guildId)
		.all<SkillRow>();
	return results.map(summaryFromRow);
}

/** サーバーのスキルの数 */
export async function countSkills(
	db: D1Database,
	guildId: string,
): Promise<number> {
	const row = await db
		.prepare("SELECT COUNT(*) AS count FROM skills WHERE guild_id = ?")
		.bind(guildId)
		.first<{ count: number }>();
	return row?.count ?? 0;
}

/** IDでスキルを読む。ほかのサーバーのスキルや、消されたスキルならnull */
export async function getSkill(
	db: D1Database,
	guildId: string,
	id: number,
): Promise<Skill | null> {
	if (!isSkillId(id)) {
		return null;
	}
	const row = await db
		.prepare(
			`SELECT ${SUMMARY_COLUMNS}, body FROM skills WHERE id = ? AND guild_id = ?`,
		)
		.bind(id, guildId)
		.first<SkillRow>();
	return row === null ? null : skillFromRow(row);
}

/** 名前でスキルを読む。なければnull */
export async function findSkillByName(
	db: D1Database,
	guildId: string,
	name: string,
): Promise<Skill | null> {
	const row = await db
		.prepare(
			`SELECT ${SUMMARY_COLUMNS}, body FROM skills WHERE guild_id = ? AND name = ?`,
		)
		.bind(guildId, name)
		.first<SkillRow>();
	return row === null ? null : skillFromRow(row);
}

/** スキルを足した結果。duplicateは同じ名前のスキルがある、limitは数が上限に達している */
export type AddSkillResult = "added" | "duplicate" | "limit";

/** スキルを足す。数の上限は、足すときにも確かめる(同時に足されることがあるため) */
export async function addSkill(
	db: D1Database,
	guildId: string,
	content: SkillContent,
	editor: SkillEditor,
	now = Date.now(),
): Promise<AddSkillResult> {
	try {
		const result = await db
			.prepare(
				`INSERT INTO skills
				(guild_id, name, description, body, created_by_id, created_by_name, created_at, updated_at)
				SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7
				WHERE (SELECT COUNT(*) FROM skills WHERE guild_id = ?1) < ?8`,
			)
			.bind(
				guildId,
				content.name,
				content.description,
				content.body,
				editor.id,
				editor.name,
				now,
				MAX_SKILLS,
			)
			.run();
		return result.meta.changes > 0 ? "added" : "limit";
	} catch (error) {
		if (isUniqueViolation(error)) {
			return "duplicate";
		}
		throw error;
	}
}

/**
 * スキルの編集の結果。conflictは、編集の画面を開いた後に、ほかの人が変更か削除をしていた。
 * duplicateは、新しい名前のスキルがほかにある
 */
export type UpdateSkillResult = "saved" | "conflict" | "duplicate";

/**
 * スキルを書き換える。編集の画面を開いたときの更新日時(expectedUpdatedAt)から変わっていたら、書き換えない。
 * 更新日時は、前の値より必ず進める(同じ時刻に2回書き換えても、重なりを見つけられるように)
 */
export async function updateSkill(
	db: D1Database,
	guildId: string,
	target: { id: number; expectedUpdatedAt: number },
	content: SkillContent,
	editor: SkillEditor,
	now = Date.now(),
): Promise<UpdateSkillResult> {
	if (
		!isSkillId(target.id) ||
		!Number.isSafeInteger(target.expectedUpdatedAt)
	) {
		return "conflict";
	}
	try {
		const result = await db
			.prepare(
				`UPDATE skills SET
					name = ?, description = ?, body = ?,
					edited_by_id = ?, edited_by_name = ?,
					updated_at = MAX(?, updated_at + 1)
				WHERE id = ? AND guild_id = ? AND updated_at = ?`,
			)
			.bind(
				content.name,
				content.description,
				content.body,
				editor.id,
				editor.name,
				now,
				target.id,
				guildId,
				target.expectedUpdatedAt,
			)
			.run();
		return result.meta.changes > 0 ? "saved" : "conflict";
	} catch (error) {
		if (isUniqueViolation(error)) {
			return "duplicate";
		}
		throw error;
	}
}

/** スキルを消し、消したスキルの名前を返す。なければ(ほかの人が消していたら)null。付いていたファイルも消す */
export async function deleteSkill(
	db: D1Database,
	guildId: string,
	id: number,
): Promise<string | null> {
	if (!isSkillId(id)) {
		return null;
	}
	const [, deleted] = await db.batch<{ name: string }>([
		db
			.prepare(
				"DELETE FROM skill_files WHERE skill_id = (SELECT id FROM skills WHERE id = ? AND guild_id = ?)",
			)
			.bind(id, guildId),
		db
			.prepare(
				"DELETE FROM skills WHERE id = ? AND guild_id = ? RETURNING name",
			)
			.bind(id, guildId),
	]);
	return deleted?.results[0]?.name ?? null;
}

/** プラグインから入れるスキル(SKILL.mdの中身と、付いているファイル) */
export interface InstallingSkill {
	content: SkillContent;
	files: SkillFileData[];
}

/**
 * プラグインからスキルを入れた結果。
 * installedは、added(新しく足した名前)とreplaced(置き換えた名前)を返す。
 * duplicateは、置き換えずに入れようとして、同じ名前のスキルがあった(names)。
 * limitは、新しく足すスキル(adding個)で、数の上限を超える
 */
export type InstallSkillsResult =
	| { result: "installed"; added: string[]; replaced: string[] }
	| { result: "duplicate"; names: string[] }
	| { result: "limit"; adding: number };

/**
 * プラグインのスキルを、まとめて入れる(1つのトランザクション)。同じ名前のスキルは、overwriteなら説明・本文・入手元・ファイルを
 * 置き換え、そうでなければ何もせずにduplicateを返す。数の上限は、新しく足すスキルで確かめる。
 * 確かめた後に、ほかの人が同じ名前で足したり消したりしていたら、失敗する(書き込みはすべて取り消す)
 */
export async function installSkills(
	db: D1Database,
	guildId: string,
	skills: readonly InstallingSkill[],
	source: SkillSource,
	editor: SkillEditor,
	options: { overwrite: boolean },
	now = Date.now(),
): Promise<InstallSkillsResult> {
	const { results } = await db
		.prepare("SELECT name FROM skills WHERE guild_id = ?")
		.bind(guildId)
		.all<{ name: string }>();
	const existing = new Set(results.map((row) => row.name));
	const replaced = skills
		.map((skill) => skill.content.name)
		.filter((name) => existing.has(name));
	const added = skills
		.map((skill) => skill.content.name)
		.filter((name) => !existing.has(name));
	if (existing.size + added.length > MAX_SKILLS) {
		return { result: "limit", adding: added.length };
	}
	if (replaced.length > 0 && !options.overwrite) {
		return { result: "duplicate", names: replaced };
	}
	const statements: D1PreparedStatement[] = [];
	for (const { content, files } of skills) {
		statements.push(
			existing.has(content.name)
				? db
						.prepare(
							`UPDATE skills SET
								description = ?, body = ?,
								edited_by_id = ?, edited_by_name = ?,
								updated_at = MAX(?, updated_at + 1),
								source_repository = ?, source_plugin = ?, source_commit = ?
							WHERE guild_id = ? AND name = ?`,
						)
						.bind(
							content.description,
							content.body,
							editor.id,
							editor.name,
							now,
							source.repository,
							source.plugin,
							source.commit,
							guildId,
							content.name,
						)
				: db
						.prepare(
							`INSERT INTO skills
							(guild_id, name, description, body, created_by_id, created_by_name, created_at, updated_at,
								source_repository, source_plugin, source_commit)
							VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8, ?9, ?10)`,
						)
						.bind(
							guildId,
							content.name,
							content.description,
							content.body,
							editor.id,
							editor.name,
							now,
							source.repository,
							source.plugin,
							source.commit,
						),
			db
				.prepare(
					"DELETE FROM skill_files WHERE skill_id = (SELECT id FROM skills WHERE guild_id = ? AND name = ?)",
				)
				.bind(guildId, content.name),
			...files.map((file) =>
				db
					.prepare(
						`INSERT INTO skill_files (skill_id, path, content)
						VALUES ((SELECT id FROM skills WHERE guild_id = ? AND name = ?), ?, ?)`,
					)
					.bind(guildId, content.name, file.path, file.content),
			),
		);
	}
	await db.batch(statements);
	return { result: "installed", added, replaced };
}

/** スキルに付いたファイル。位置の順。ほかのサーバーのスキルなら空 */
export async function listSkillFiles(
	db: D1Database,
	guildId: string,
	skillId: number,
): Promise<SkillFileData[]> {
	const { results } = await db
		.prepare(
			`SELECT skill_files.path AS path, skill_files.content AS content
			FROM skill_files JOIN skills ON skills.id = skill_files.skill_id
			WHERE skill_files.skill_id = ? AND skills.guild_id = ?
			ORDER BY skill_files.path`,
		)
		.bind(skillId, guildId)
		.all<{ path: string; content: ArrayBuffer | ArrayLike<number> }>();
	return results.map((row) => ({
		path: row.path,
		content: bytesOf(row.content),
	}));
}

/** D1から読んだBLOB。ArrayBufferか、数の並びで返ってくる */
function bytesOf(value: ArrayBuffer | ArrayLike<number>): Uint8Array {
	return value instanceof ArrayBuffer
		? new Uint8Array(value)
		: Uint8Array.from(value);
}

/** 名前でスキルの中身を置き換えた結果。addedは、確かめている間に消されていたので、新しく足した */
export type OverwriteSkillResult = "saved" | "added" | "limit";

/**
 * 名前で、スキルの説明と本文を置き換える(/regskills で、置き換えると確かめたとき)。
 * 確かめている間に消されていたら、新しく足す(数の上限は確かめる)
 */
export async function overwriteSkill(
	db: D1Database,
	guildId: string,
	content: SkillContent,
	editor: SkillEditor,
	now = Date.now(),
): Promise<OverwriteSkillResult> {
	const overwrite = async () => {
		const result = await db
			.prepare(
				`UPDATE skills SET
					description = ?, body = ?,
					edited_by_id = ?, edited_by_name = ?,
					updated_at = MAX(?, updated_at + 1)
				WHERE guild_id = ? AND name = ?`,
			)
			.bind(
				content.description,
				content.body,
				editor.id,
				editor.name,
				now,
				guildId,
				content.name,
			)
			.run();
		return result.meta.changes > 0;
	};
	if (await overwrite()) {
		return "saved";
	}
	const added = await addSkill(db, guildId, content, editor, now);
	if (added !== "duplicate") {
		return added;
	}
	// 同じ名前のスキルが、ちょうど足されていた。それを置き換える
	await overwrite();
	return "saved";
}

/**
 * 置き換えるかを確かめている間の内容を保存し、そのIDを返す。
 * 同じ人が同じサーバーで確かめていた、前の内容は消す(人ごと・サーバーごとに1つだけ残す)
 */
export async function savePendingSkill(
	db: D1Database,
	guildId: string,
	userId: string,
	content: SkillContent,
	now = Date.now(),
): Promise<number> {
	const [, , inserted] = await db.batch<{ id: number }>([
		...deletePendingStatements(db, guildId, userId),
		db
			.prepare(
				`INSERT INTO pending_skills (guild_id, user_id, name, description, body, created_at)
				VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
			)
			.bind(
				guildId,
				userId,
				content.name,
				content.description,
				content.body,
				now,
			),
	]);
	const id = inserted?.results[0]?.id;
	if (id === undefined) {
		throw new Error("pending skill was not saved");
	}
	return id;
}

/** 置き換えるかを確かめている間の内容。消えていたら(置き換えたか、次に確かめたら)、またはほかの人のものならnull */
export async function getPendingSkill(
	db: D1Database,
	guildId: string,
	userId: string,
	id: number,
): Promise<SkillContent | null> {
	if (!isSkillId(id)) {
		return null;
	}
	return db
		.prepare(
			"SELECT name, description, body FROM pending_skills WHERE id = ? AND guild_id = ? AND user_id = ?",
		)
		.bind(id, guildId, userId)
		.first<SkillContent>();
}

/** 置き換えを済ませた内容を消す */
export async function deletePendingSkill(
	db: D1Database,
	id: number,
): Promise<void> {
	await db.prepare("DELETE FROM pending_skills WHERE id = ?").bind(id).run();
}

/** プラグインから入れるときに、置き換えるかを確かめている間の入手元(読み直すコミット) */
export interface PendingPlugin {
	repository: string;
	plugin: string;
	commit: string;
}

/**
 * プラグインから入れるスキルを置き換えるかを確かめている間の入手元を保存し、そのIDを返す。
 * 同じ人が同じサーバーで確かめていた、前の内容は消す(SKILL.mdの置き換えと合わせて、1つだけ残す)
 */
export async function savePendingPlugin(
	db: D1Database,
	guildId: string,
	userId: string,
	pending: PendingPlugin,
	now = Date.now(),
): Promise<number> {
	const [, , inserted] = await db.batch<{ id: number }>([
		...deletePendingStatements(db, guildId, userId),
		db
			.prepare(
				`INSERT INTO pending_plugin_skills (guild_id, user_id, repository, plugin, commit_sha, created_at)
				VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
			)
			.bind(
				guildId,
				userId,
				pending.repository,
				pending.plugin,
				pending.commit,
				now,
			),
	]);
	const id = inserted?.results[0]?.id;
	if (id === undefined) {
		throw new Error("pending plugin was not saved");
	}
	return id;
}

/** プラグインから入れるときに、確かめている間の入手元。消えていたら、またはほかの人のものならnull */
export async function getPendingPlugin(
	db: D1Database,
	guildId: string,
	userId: string,
	id: number,
): Promise<PendingPlugin | null> {
	if (!isSkillId(id)) {
		return null;
	}
	const row = await db
		.prepare(
			"SELECT repository, plugin, commit_sha FROM pending_plugin_skills WHERE id = ? AND guild_id = ? AND user_id = ?",
		)
		.bind(id, guildId, userId)
		.first<{ repository: string; plugin: string; commit_sha: string }>();
	return row === null
		? null
		: {
				repository: row.repository,
				plugin: row.plugin,
				commit: row.commit_sha,
			};
}

/** 置き換えを済ませた、プラグインの入手元を消す */
export async function deletePendingPlugin(
	db: D1Database,
	id: number,
): Promise<void> {
	await db
		.prepare("DELETE FROM pending_plugin_skills WHERE id = ?")
		.bind(id)
		.run();
}

/** 同じ人が同じサーバーで、置き換えるかを確かめていた内容を消す文(SKILL.mdとプラグインの両方) */
function deletePendingStatements(
	db: D1Database,
	guildId: string,
	userId: string,
): D1PreparedStatement[] {
	return [
		db
			.prepare("DELETE FROM pending_skills WHERE guild_id = ? AND user_id = ?")
			.bind(guildId, userId),
		db
			.prepare(
				"DELETE FROM pending_plugin_skills WHERE guild_id = ? AND user_id = ?",
			)
			.bind(guildId, userId),
	];
}

/** スキル(と、置き換えを確かめている間の内容)のIDとして使える数か。ボタンなどのIDから読んだ値が壊れていたら、使わない */
function isSkillId(id: number): boolean {
	return Number.isSafeInteger(id) && id > 0;
}

/** 同じサーバーに、同じ名前のスキルを入れようとした失敗か */
function isUniqueViolation(error: unknown): boolean {
	return (
		error instanceof Error && error.message.includes("UNIQUE constraint failed")
	);
}

function summaryFromRow(row: SkillRow): SkillSummary {
	return {
		id: row.id,
		name: row.name,
		description: row.description,
		createdByName: row.created_by_name,
		createdAt: row.created_at,
		editedByName: row.edited_by_name,
		updatedAt: row.updated_at,
		fileCount: row.file_count,
		source:
			row.source_repository !== null &&
			row.source_plugin !== null &&
			row.source_commit !== null
				? {
						repository: row.source_repository,
						plugin: row.source_plugin,
						commit: row.source_commit,
					}
				: null,
	};
}

function skillFromRow(row: SkillRow): Skill {
	return { ...summaryFromRow(row), body: row.body ?? "" };
}
