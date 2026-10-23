import type { QueueMessage } from "./messages";

/**
 * Queueに入った仕事を処理する。
 *
 * これから実装すること(仕様: docs/spec/architecture.md「会話の文脈と過去の発言の保存」):
 * - respond: 会話の履歴を組み立ててLLMを呼び、Discordに返信する
 * - ingest / delete: D1とVectorizeへの保存と削除
 * - import: 過去ログの取り込み
 */
export async function handleQueueBatch(
	batch: MessageBatch<QueueMessage>,
	_env: Env,
): Promise<void> {
	for (const message of batch.messages) {
		switch (message.body.kind) {
			case "respond":
				// TODO: 応答の生成
				break;
			case "ingest":
			case "delete":
			case "import":
				// TODO: 保存、削除、過去ログの取り込み
				break;
		}
		message.ack();
	}
}
