import { logEvent } from "../log";
import { handleRespondJob } from "../respond/handler";
import type { QueueMessage } from "./messages";

/**
 * Queueに入った仕事を処理する。失敗した仕事は、Queueの設定の回数までやり直す。
 *
 * これから実装すること(仕様: docs/spec/architecture.md「会話の文脈と過去の発言の保存」):
 * - ingest / delete: D1とVectorizeへの保存と削除
 * - import: 過去ログの取り込み
 */
export async function handleQueueBatch(
	batch: MessageBatch<QueueMessage>,
	env: Env,
): Promise<void> {
	for (const message of batch.messages) {
		try {
			switch (message.body.kind) {
				case "respond":
					await handleRespondJob(message.body, env);
					break;
				case "ingest":
				case "delete":
				case "import":
					// TODO: 保存、削除、過去ログの取り込み
					break;
			}
			message.ack();
		} catch (error) {
			logEvent("queue", "job_failed", {
				kind: message.body.kind,
				attempts: message.attempts,
				error: error instanceof Error ? error.message : "unknown",
			});
			message.retry();
		}
	}
}
