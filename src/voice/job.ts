import { logEvent } from "../log";
import { ingestDeps } from "../queue/deps";
import { embedMessages } from "../queue/ingest";
import type { TranscribeJob } from "../queue/messages";
import { historyFor } from "../respond/handler";
import { loadMessagesByIds } from "../store/messages";
import { downloadAudio, VoiceReader } from "./reader";
import { isVoiceAttachment, MAX_VOICE_SECS, transcribeAudio } from "./voice";

/**
 * 保存した音声メッセージを文字にして、文字にした内容でベクトルを入れる(仕様: docs/spec/architecture.md「音声メッセージ」)。
 * - 届いたばかりの音声メッセージを保存したとき(前もって文字にする)と、返答の中で文字にしたとき(ベクトルを入れるだけ)に動く
 * - 保存していないメッセージ(共有しないチャンネルの分や、消されたもの)は、何もしない
 * - 文字にした内容を保存してあれば、文字にし直さない
 * - 文字にできなければ、Queueでやり直す
 */
export async function handleTranscribeJob(
	job: TranscribeJob,
	env: Env,
): Promise<void> {
	const [message] = await loadMessagesByIds(env.DB, [job.messageId]);
	const attachment = message?.attachments.find(isVoiceAttachment);
	if (message === undefined || attachment === undefined) {
		logEvent("voice", "transcribe_job_skipped", {
			reason: message === undefined ? "not_stored" : "not_voice",
		});
		return;
	}
	const history = historyFor(env, {
		guildId: message.guildId,
		channelId: message.channelId,
		knownNames: [],
	});
	// 1つの仕事で文字にするのは、この音声メッセージだけ
	const reader = new VoiceReader(
		{
			db: env.DB,
			history,
			transcribe: (audio) => transcribeAudio(env.AI, audio),
			download: downloadAudio,
		},
		MAX_VOICE_SECS,
	);
	const text = await reader.read(message, attachment, "job");
	if (text.kind !== "text") {
		throw new Error("音声メッセージを文字にできませんでした");
	}
	await embedMessages([message.messageId], ingestDeps(env));
}
