/**
 * サーバーに入れたClaude Codeのプラグイン(#108。仕様: docs/spec/behavior.md「プラグイン」)。
 * プラグインを、入れる・更新する・消す単位にする。プラグインのスキルは、エージェントだけで使い、
 * 「<プラグイン名>:<スキル名>」の名前で渡す
 */

import type { InstallingSkill, SkillEditor } from "./skills";

/** 1サーバーに入れられるプラグインの数 */
export const MAX_PLUGINS = 10;

/** 入れたプラグイン(一覧に出す概要) */
export interface PluginSummary {
	id: number;
	name: string;
	/** 一覧(マーケットプレイス)のGitHubのリポジトリ */
	repository: string;
	/** スキルのファイルを読んだコミット */
	commit: string;
	skillCount: number;
	fileCount: number;
	installedByName: string;
	installedAt: number;
	updatedAt: number;
}

/** プラグインのスキル(本文を除く) */
export interface PluginSkillSummary {
	id: number;
	name: string;
	description: string;
	fileCount: number;
}

export interface Plugin extends PluginSummary {
	skills: PluginSkillSummary[];
}

/** エージェントに渡す、プラグインのスキル */
export interface PluginAgentSkill {
	id: number;
	/** プラグインの名前 */
	plugin: string;
	/** スキルの名前(プラグインの中での名前) */
	name: string;
	description: string;
	body: string;
	fileCount: number;
}

/** 入れるプラグイン */
export interface InstallingPlugin {
	name: string;
	repository: string;
	commit: string;
	skills: readonly InstallingSkill[];
}

interface PluginRow {
	id: number;
	name: string;
	repository: string;
	commit_sha: string;
	installed_by_name: string;
	installed_at: number;
	updated_at: number;
	skill_count: number;
	file_count: number;
}

const SUMMARY_SELECT = `SELECT plugins.id, plugins.name, plugins.repository, plugins.commit_sha,
	plugins.installed_by_name, plugins.installed_at, plugins.updated_at,
	(SELECT COUNT(*) FROM plugin_skills WHERE plugin_skills.plugin_id = plugins.id) AS skill_count,
	(SELECT COUNT(*) FROM plugin_files JOIN plugin_skills ON plugin_skills.id = plugin_files.plugin_skill_id
		WHERE plugin_skills.plugin_id = plugins.id) AS file_count
	FROM plugins`;

/** サーバーのプラグイン。名前の順 */
export async function listPlugins(
	db: D1Database,
	guildId: string,
): Promise<PluginSummary[]> {
	const { results } = await db
		.prepare(
			`${SUMMARY_SELECT} WHERE plugins.guild_id = ? ORDER BY plugins.name`,
		)
		.bind(guildId)
		.all<PluginRow>();
	return results.map(summaryFromRow);
}

/** IDでプラグインを読む(スキルの一覧も付ける)。ほかのサーバーのものや、消されたものならnull */
export async function getPlugin(
	db: D1Database,
	guildId: string,
	id: number,
): Promise<Plugin | null> {
	if (!isId(id)) {
		return null;
	}
	const row = await db
		.prepare(`${SUMMARY_SELECT} WHERE plugins.id = ? AND plugins.guild_id = ?`)
		.bind(id, guildId)
		.first<PluginRow>();
	if (row === null) {
		return null;
	}
	const { results } = await db
		.prepare(
			`SELECT id, name, description,
				(SELECT COUNT(*) FROM plugin_files WHERE plugin_files.plugin_skill_id = plugin_skills.id) AS file_count
			FROM plugin_skills WHERE plugin_id = ? ORDER BY name`,
		)
		.bind(id)
		.all<{
			id: number;
			name: string;
			description: string;
			file_count: number;
		}>();
	return {
		...summaryFromRow(row),
		skills: results.map((skill) => ({
			id: skill.id,
			name: skill.name,
			description: skill.description,
			fileCount: skill.file_count,
		})),
	};
}

/** プラグインを入れた結果。existsは同じ名前のプラグインがある、limitは数が上限に達している */
export type InstallPluginResult = "installed" | "exists" | "limit";

/** プラグインを入れる(スキルとファイルも、1つのトランザクションで) */
export async function installPlugin(
	db: D1Database,
	guildId: string,
	plugin: InstallingPlugin,
	editor: SkillEditor,
	now = Date.now(),
): Promise<InstallPluginResult> {
	const existing = await db
		.prepare("SELECT name FROM plugins WHERE guild_id = ?")
		.bind(guildId)
		.all<{ name: string }>();
	if (existing.results.some((row) => row.name === plugin.name)) {
		return "exists";
	}
	if (existing.results.length >= MAX_PLUGINS) {
		return "limit";
	}
	try {
		await db.batch([
			db
				.prepare(
					`INSERT INTO plugins (guild_id, name, repository, commit_sha, installed_by_id, installed_by_name, installed_at, updated_at)
					VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)`,
				)
				.bind(
					guildId,
					plugin.name,
					plugin.repository,
					plugin.commit,
					editor.id,
					editor.name,
					now,
				),
			...skillStatements(db, guildId, plugin),
		]);
	} catch (error) {
		// 確かめた後に、ほかの人が同じ名前で入れていた
		if (
			error instanceof Error &&
			error.message.includes("UNIQUE constraint failed")
		) {
			return "exists";
		}
		throw error;
	}
	return "installed";
}

/** プラグインを入れ直す(スキルとファイルを、新しい版に置き換える)。消されていたらfalse */
export async function updatePlugin(
	db: D1Database,
	guildId: string,
	id: number,
	plugin: Omit<InstallingPlugin, "name">,
	now = Date.now(),
): Promise<boolean> {
	const current = await db
		.prepare("SELECT name FROM plugins WHERE id = ? AND guild_id = ?")
		.bind(id, guildId)
		.first<{ name: string }>();
	if (current === null) {
		return false;
	}
	await db.batch([
		db
			.prepare(
				`UPDATE plugins SET repository = ?, commit_sha = ?, updated_at = MAX(?, updated_at + 1)
				WHERE id = ? AND guild_id = ?`,
			)
			.bind(plugin.repository, plugin.commit, now, id, guildId),
		...deleteSkillStatements(db, id),
		...skillStatements(db, guildId, { ...plugin, name: current.name }),
	]);
	return true;
}

/** プラグインを消し、消したプラグインの名前を返す。なければnull。スキルとファイルも消す */
export async function deletePlugin(
	db: D1Database,
	guildId: string,
	id: number,
): Promise<string | null> {
	if (!isId(id)) {
		return null;
	}
	const row = await db
		.prepare("SELECT name FROM plugins WHERE id = ? AND guild_id = ?")
		.bind(id, guildId)
		.first<{ name: string }>();
	if (row === null) {
		return null;
	}
	await db.batch([
		...deleteSkillStatements(db, id),
		db
			.prepare("DELETE FROM plugins WHERE id = ? AND guild_id = ?")
			.bind(id, guildId),
	]);
	return row.name;
}

/** エージェントに渡す、サーバーのプラグインのスキル(プラグインの名前、スキルの名前の順) */
export async function listPluginAgentSkills(
	db: D1Database,
	guildId: string,
): Promise<Omit<PluginAgentSkill, "body">[]> {
	const { results } = await db
		.prepare(
			`SELECT plugin_skills.id, plugins.name AS plugin, plugin_skills.name, plugin_skills.description,
				(SELECT COUNT(*) FROM plugin_files WHERE plugin_files.plugin_skill_id = plugin_skills.id) AS file_count
			FROM plugin_skills JOIN plugins ON plugins.id = plugin_skills.plugin_id
			WHERE plugins.guild_id = ? ORDER BY plugins.name, plugin_skills.name`,
		)
		.bind(guildId)
		.all<{
			id: number;
			plugin: string;
			name: string;
			description: string;
			file_count: number;
		}>();
	return results.map((row) => ({
		id: row.id,
		plugin: row.plugin,
		name: row.name,
		description: row.description,
		fileCount: row.file_count,
	}));
}

/** プラグインのスキルを、プラグインの名前とスキルの名前で読む。なければnull */
export async function findPluginAgentSkill(
	db: D1Database,
	guildId: string,
	plugin: string,
	name: string,
): Promise<PluginAgentSkill | null> {
	const row = await db
		.prepare(
			`SELECT plugin_skills.id, plugins.name AS plugin, plugin_skills.name, plugin_skills.description, plugin_skills.body,
				(SELECT COUNT(*) FROM plugin_files WHERE plugin_files.plugin_skill_id = plugin_skills.id) AS file_count
			FROM plugin_skills JOIN plugins ON plugins.id = plugin_skills.plugin_id
			WHERE plugins.guild_id = ? AND plugins.name = ? AND plugin_skills.name = ?`,
		)
		.bind(guildId, plugin, name)
		.first<{
			id: number;
			plugin: string;
			name: string;
			description: string;
			body: string;
			file_count: number;
		}>();
	return row === null
		? null
		: {
				id: row.id,
				plugin: row.plugin,
				name: row.name,
				description: row.description,
				body: row.body,
				fileCount: row.file_count,
			};
}

/** プラグインのスキルのファイル。位置の順。ほかのサーバーのものなら空 */
export async function listPluginSkillFiles(
	db: D1Database,
	guildId: string,
	pluginSkillId: number,
): Promise<{ path: string; content: Uint8Array }[]> {
	const { results } = await db
		.prepare(
			`SELECT plugin_files.path AS path, plugin_files.content AS content
			FROM plugin_files
			JOIN plugin_skills ON plugin_skills.id = plugin_files.plugin_skill_id
			JOIN plugins ON plugins.id = plugin_skills.plugin_id
			WHERE plugin_files.plugin_skill_id = ? AND plugins.guild_id = ?
			ORDER BY plugin_files.path`,
		)
		.bind(pluginSkillId, guildId)
		.all<{ path: string; content: ArrayBuffer | ArrayLike<number> }>();
	return results.map((row) => ({
		path: row.path,
		content:
			row.content instanceof ArrayBuffer
				? new Uint8Array(row.content)
				: Uint8Array.from(row.content),
	}));
}

/** プラグインのスキルとファイルを足す文 */
function skillStatements(
	db: D1Database,
	guildId: string,
	plugin: Pick<InstallingPlugin, "name" | "skills">,
): D1PreparedStatement[] {
	const pluginId = "(SELECT id FROM plugins WHERE guild_id = ? AND name = ?)";
	return plugin.skills.flatMap(({ content, files }) => [
		db
			.prepare(
				`INSERT INTO plugin_skills (plugin_id, name, description, body) VALUES (${pluginId}, ?, ?, ?)`,
			)
			.bind(
				guildId,
				plugin.name,
				content.name,
				content.description,
				content.body,
			),
		...files.map((file) =>
			db
				.prepare(
					`INSERT INTO plugin_files (plugin_skill_id, path, content)
					VALUES ((SELECT id FROM plugin_skills WHERE plugin_id = ${pluginId} AND name = ?), ?, ?)`,
				)
				.bind(guildId, plugin.name, content.name, file.path, file.content),
		),
	]);
}

/** プラグインのスキルとファイルを消す文 */
function deleteSkillStatements(
	db: D1Database,
	pluginId: number,
): D1PreparedStatement[] {
	return [
		db
			.prepare(
				"DELETE FROM plugin_files WHERE plugin_skill_id IN (SELECT id FROM plugin_skills WHERE plugin_id = ?)",
			)
			.bind(pluginId),
		db.prepare("DELETE FROM plugin_skills WHERE plugin_id = ?").bind(pluginId),
	];
}

function summaryFromRow(row: PluginRow): PluginSummary {
	return {
		id: row.id,
		name: row.name,
		repository: row.repository,
		commit: row.commit_sha,
		skillCount: row.skill_count,
		fileCount: row.file_count,
		installedByName: row.installed_by_name,
		installedAt: row.installed_at,
		updatedAt: row.updated_at,
	};
}

function isId(id: number): boolean {
	return Number.isSafeInteger(id) && id > 0;
}
