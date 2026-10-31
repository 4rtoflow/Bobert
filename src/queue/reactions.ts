import { logEvent } from "../log";
import { saveMemberNames } from "../store/messages";
import { applyReactionJobs } from "../store/reactions";
import { type ChannelDeps, resolveSharedChannels } from "./channels";
import type { ReactionJob } from "./messages";

/**
 * リアクションの付け外しを、記録に反映する(仕様: docs/spec/architecture.md「リアクション」)。
 * 記録するのは、メッセージを保存しているチャンネル(共有チャンネル)のリアクションだけ。
 * 付けた人の、サーバーで見えている名前も記録する(会話に、付けた人の名前を書くため)
 */
export async function applyReactions(
	jobs: readonly ReactionJob[],
	deps: ChannelDeps,
): Promise<void> {
	const shared = await resolveSharedChannels(jobs, deps);
	const kept = jobs.filter((job) => shared.has(job.channelId));
	if (kept.length === 0) {
		return;
	}
	await applyReactionJobs(deps.db, kept);
	await saveMemberNames(
		deps.db,
		kept.flatMap((job) =>
			job.member === undefined
				? []
				: [{ guildId: job.guildId, member: job.member, at: job.at }],
		),
	);
	logEvent("queue", "reactions_applied", { changes: kept.length });
}
