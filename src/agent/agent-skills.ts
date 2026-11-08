import { findPluginAgentSkill, listPluginAgentSkills } from "../store/plugins";
import { findSkillByName, listSkills } from "../store/skills";
import type { AgentSkill } from "./managed";
import type { AgentSkillContent } from "./relay";

/**
 * エージェントに渡すスキル(仕様: docs/spec/behavior.md「エージェント」)。
 * サーバーのスキル(/skills)と、プラグインのスキル(/plugins)を合わせる。
 * プラグインのスキルは「<プラグイン名>:<スキル名>」の名前にするので、サーバーのスキルと名前がぶつからない
 */

/** プラグインのスキルの名前の区切り(Claude Codeと同じ) */
const PLUGIN_SEPARATOR = ":";

/** セッションを始めるときに、指示に足すスキルの一覧(サーバーのスキル、プラグインのスキルの順) */
export async function listAgentSkills(
	db: D1Database,
	guildId: string,
): Promise<AgentSkill[]> {
	const server = await listSkills(db, guildId);
	const plugins = await listPluginAgentSkills(db, guildId);
	return [
		...server.map(({ name, description }) => ({ name, description })),
		...plugins.map((skill) => ({
			name: `${skill.plugin}${PLUGIN_SEPARATOR}${skill.name}`,
			description: skill.description,
		})),
	];
}

/** read_skillの道具で、名前からスキルを読む。なければnull */
export async function readAgentSkill(
	db: D1Database,
	guildId: string,
	name: string,
): Promise<AgentSkillContent | null> {
	const separator = name.indexOf(PLUGIN_SEPARATOR);
	if (separator === -1) {
		const skill = await findSkillByName(db, guildId, name);
		return skill === null
			? null
			: {
					kind: "server",
					id: skill.id,
					name: skill.name,
					body: skill.body,
					fileCount: skill.fileCount,
					mountDir: `skills/${skill.name}`,
				};
	}
	const plugin = name.slice(0, separator);
	const skillName = name.slice(separator + 1);
	const skill = await findPluginAgentSkill(db, guildId, plugin, skillName);
	return skill === null
		? null
		: {
				kind: "plugin",
				id: skill.id,
				name: `${skill.plugin}${PLUGIN_SEPARATOR}${skill.name}`,
				body: skill.body,
				fileCount: skill.fileCount,
				mountDir: `plugins/${skill.plugin}/skills/${skill.name}`,
			};
}
