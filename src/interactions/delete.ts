import type { APIInteractionResponse } from "discord-api-types/v10";
import { agentClient, retireAgentResources } from "../agent/managed";
import {
	type AgentChannel,
	type AgentResources,
	agentChannelsOf,
	deleteAgentRecordsOf,
	getAgentResources,
} from "../agent/store";
import { agentSessionStub, gatewayStub } from "../agent/stubs";
import { DELETE_AGENTS_NOTE, DELETE_GITHUB_NOTE } from "../agent/texts";
import {
	ButtonStyle,
	ComponentType,
	InteractionResponseType,
	MessageFlags,
} from "../discord/constants";
import { revokeGitHubAuthorization } from "../github/account";
import type { AnthropicCredential } from "../llm/anthropic";
import { logEvent } from "../log";
import { DELETE_MEMORY_NOTE } from "../memory/texts";
import { isDonating } from "../store/donations";
import { hasGitHubLink, loadGitHubLink } from "../store/github";
import { deleteUserMemory, hasAnyMemory } from "../store/memory";
import { deleteUserData, loadCredential } from "../store/users";

/** /delete の確認のボタンのID */
export const DELETE_CONFIRM_ID = "delete:confirm";

/**
 * /delete: 消してよいか、本人にだけ確かめる。寄付している人には、寄付も使われなくなることを書く。
 * 記憶を使ったことがある人には、記憶も消すことを、
 * エージェントのチャンネルがある人には、チャンネルとセッションも消すことを、
 * GitHubと連携している人には、連携も外すことを書く
 */
export async function deleteCommand(
	env: Env,
	userId: string,
): Promise<APIInteractionResponse> {
	const donation = (await isDonating(env.DB, userId))
		? "寄付したクレジットも、使われなくなります。"
		: "";
	const memory = (await hasAnyMemory(env.DB, userId)) ? DELETE_MEMORY_NOTE : "";
	const agents =
		(await agentChannelsOf(env.DB, userId)).length > 0
			? DELETE_AGENTS_NOTE
			: "";
	const github = (await hasGitHubLink(env.DB, userId))
		? DELETE_GITHUB_NOTE
		: "";
	return {
		type: InteractionResponseType.ChannelMessageWithSource,
		data: {
			flags: MessageFlags.Ephemeral,
			content: `登録したAPIキー(AnthropicとOpenRouter)と設定を、すべて削除します。${donation}${memory}${agents}${github}よろしいですか?`,
			components: [
				{
					type: ComponentType.ActionRow,
					components: [
						{
							type: ComponentType.Button,
							style: ButtonStyle.Danger,
							custom_id: DELETE_CONFIRM_ID,
							label: "削除する",
						},
					],
				},
			],
		},
	};
}

/**
 * 確認のボタン: キーと設定と記憶を消す(仕様: docs/spec/llm-cost.md「資格情報の登録・保存・削除」)。
 * エージェントのセッションは、本人のキーでないと消せないので、キーを読んでおき、記録を消してから、裏でセッションとチャンネルを消す。
 * GitHubとの連携も同じく、トークンを読んでおき、記録を消してから、裏でGitHubの側の承認を取り消す
 */
export async function confirmDelete(
	env: Env,
	ctx: ExecutionContext,
	userId: string,
): Promise<APIInteractionResponse> {
	const channels = await agentChannelsOf(env.DB, userId);
	const resources = await getAgentResources(env.DB, userId);
	const hasAgents = channels.length > 0 || resources !== null;
	const credential = hasAgents
		? await loadCredential(env, userId, "anthropic")
		: null;
	const github = await loadGitHubLink(env, userId);
	await deleteAgentRecordsOf(env.DB, userId);
	await deleteUserData(env.DB, userId);
	await deleteUserMemory(env.DB, userId);
	logEvent("interactions", "user_data_deleted", { userId });
	if (hasAgents) {
		ctx.waitUntil(removeAgents(env, userId, channels, resources, credential));
	}
	if (github !== null) {
		ctx.waitUntil(revokeGitHubAuthorization(env, userId, github));
	}
	return {
		type: InteractionResponseType.UpdateMessage,
		data: {
			content:
				"削除しました。OpenRouterで発行されたキーは、OpenRouterのサイトでも削除できます。また使うときは `/setup` から登録してください。",
			components: [],
		},
	};
}

/**
 * 本人のエージェントのセッションとチャンネルを消し、本人のアカウントに作った環境を消して、エージェントの設定をアーカイブする。
 * 失敗しても、キーと設定はもう消してあるので、記録を残すだけにする
 */
async function removeAgents(
	env: Env,
	userId: string,
	channels: readonly AgentChannel[],
	resources: AgentResources | null,
	credential: AnthropicCredential | null,
): Promise<void> {
	for (const channel of channels) {
		try {
			await agentSessionStub(env, channel.channelId).purge(credential);
			await gatewayStub(env).removeAgentChannel(channel.channelId);
		} catch (error) {
			logEvent("agent", "delete_cleanup_failed", {
				userId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	if (resources !== null && credential !== null) {
		await retireAgentResources(agentClient(credential), resources).catch(
			(error: unknown) => {
				logEvent("agent", "resources_cleanup_failed", {
					userId,
					error: error instanceof Error ? error.message : String(error),
				});
			},
		);
	}
}
