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
	body?: string;
}

const SUMMARY_COLUMNS =
	"id, name, description, created_by_name, created_at, edited_by_name, updated_at";

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

/** スキルを消し、消したスキルの名前を返す。なければ(ほかの人が消していたら)null */
export async function deleteSkill(
	db: D1Database,
	guildId: string,
	id: number,
): Promise<string | null> {
	if (!isSkillId(id)) {
		return null;
	}
	const row = await db
		.prepare("DELETE FROM skills WHERE id = ? AND guild_id = ? RETURNING name")
		.bind(id, guildId)
		.first<{ name: string }>();
	return row?.name ?? null;
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
	const [, inserted] = await db.batch<{ id: number }>([
		db
			.prepare("DELETE FROM pending_skills WHERE guild_id = ? AND user_id = ?")
			.bind(guildId, userId),
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
	};
}

function skillFromRow(row: SkillRow): Skill {
	return { ...summaryFromRow(row), body: row.body ?? "" };
}
