import { logEvent } from "../log";
import type {
	AttachmentInfo,
	QueueMessage,
	StoredMessageInput,
} from "../queue/messages";
import { freshAttachment, type HistoryDeps } from "../respond/history";
import { loadVoiceTranscripts, saveVoiceTranscript } from "../store/voice";
import {
	isVoiceAttachment,
	MAX_VOICE_BYTES,
	MAX_VOICE_SECS,
	TRANSCRIPTION_MODEL,
	type Transcription,
	transcribeAudio,
	VOICE_BUDGET_SECS,
	type VoiceText,
	voiceSeconds,
} from "./voice";

/** どこで文字にしたか(ログに書く) */
export type VoiceSource =
	/** 返答の会話(返信のつながり)の中 */
	| "conversation"
	/** ファイルを読む道具 */
	| "read_file"
	/** 届いたばかりの音声メッセージを、前もって文字にする仕事 */
	| "job";

export interface VoiceReaderDeps {
	db: D1Database;
	/** メッセージを読み直して、添付ファイルのURLを取り直すのに使う */
	history: Pick<HistoryDeps, "fetchMessage" | "ingest" | "guildId">;
	/** 音声を文字にする(Workers AI) */
	transcribe: (audio: Uint8Array) => Promise<Transcription>;
	/** 音声のファイルを読む。読めないか、大きすぎればnull */
	download: (url: string) => Promise<Uint8Array | null>;
	/**
	 * 新しく文字にして保存した後に呼ぶ。返答の中では、ベクトルを入れる仕事を入れる
	 * (保存したメッセージなら、文字にした内容で探せるようにするため)
	 */
	saved?: (location: { channelId: string; messageId: string }) => Promise<void>;
}

/**
 * 音声メッセージを文字にする(仕様: docs/spec/architecture.md「音声メッセージ」)。1回の返答(または1つの仕事)ごとに作る。
 * - 文字にした内容を保存してあれば、それを使う(文字にし直さない)
 * - 新しく文字にする長さには、合わせて上限がある(既定は、1回の返答で20分)。超えたものは、この返答では文字にしない
 * - 文字にした内容は保存し、同じメッセージは、同じ返答の中で二度文字にしない
 */
export class VoiceReader {
	private remainingSecs: number;
	private readonly results = new Map<string, Promise<VoiceText>>();

	constructor(
		private readonly deps: VoiceReaderDeps,
		budgetSecs = VOICE_BUDGET_SECS,
	) {
		this.remainingSecs = budgetSecs;
	}

	/**
	 * 会話の音声メッセージを、新しいものから順に文字にする。保存した内容があれば、それを使う。
	 * 結果をメッセージIDごとに返す(音声メッセージのないメッセージは入らない)
	 */
	async prepare(
		messages: readonly StoredMessageInput[],
	): Promise<Map<string, VoiceText>> {
		const targets = messages.filter((message) =>
			message.attachments.some(isVoiceAttachment),
		);
		if (targets.length === 0) {
			return new Map();
		}
		await this.loadStored(targets.map((message) => message.messageId));
		const texts = new Map<string, VoiceText>();
		for (const message of [...targets].reverse()) {
			const attachment = message.attachments.find(isVoiceAttachment);
			if (attachment !== undefined) {
				texts.set(
					message.messageId,
					await this.read(message, attachment, "conversation"),
				);
			}
		}
		return texts;
	}

	/** 音声メッセージを1つ文字にする。保存した内容があれば、それを使う */
	read(
		message: Pick<StoredMessageInput, "messageId" | "channelId">,
		attachment: AttachmentInfo,
		source: VoiceSource,
	): Promise<VoiceText> {
		const known = this.results.get(message.messageId);
		if (known !== undefined) {
			return known;
		}
		const result = this.readNew(message, attachment, source);
		this.results.set(message.messageId, result);
		return result;
	}

	/** 保存した内容を読んでおく(まとめて1回で読むため) */
	private async loadStored(messageIds: readonly string[]): Promise<void> {
		const unknown = messageIds.filter((id) => !this.results.has(id));
		if (unknown.length === 0) {
			return;
		}
		const stored = await loadVoiceTranscripts(this.deps.db, unknown);
		for (const [messageId, transcript] of stored) {
			this.results.set(
				messageId,
				Promise.resolve({ kind: "text", text: transcript.text }),
			);
		}
	}

	private async readNew(
		message: Pick<StoredMessageInput, "messageId" | "channelId">,
		attachment: AttachmentInfo,
		source: VoiceSource,
	): Promise<VoiceText> {
		const [stored] = (
			await loadVoiceTranscripts(this.deps.db, [message.messageId])
		).values();
		if (stored !== undefined) {
			return { kind: "text", text: stored.text };
		}
		const secs = voiceSeconds(attachment);
		if (secs > MAX_VOICE_SECS || attachment.size > MAX_VOICE_BYTES) {
			log("transcribe_failed", {
				source,
				durationSecs: secs,
				reason: "too_long",
			});
			return { kind: "failed" };
		}
		if (secs > this.remainingSecs) {
			log("transcribe_skipped", {
				source,
				durationSecs: secs,
				reason: "budget",
			});
			return { kind: "over_budget" };
		}
		// 同じ返答の中で同時に読まれても、上限を超えないよう、先に差し引く
		this.remainingSecs -= secs;
		return this.transcribe(message, attachment, secs, source);
	}

	private async transcribe(
		message: Pick<StoredMessageInput, "messageId" | "channelId">,
		attachment: AttachmentInfo,
		secs: number,
		source: VoiceSource,
	): Promise<VoiceText> {
		const startedAt = Date.now();
		const fail = (reason: string, error?: unknown): VoiceText => {
			log("transcribe_failed", {
				source,
				durationSecs: secs,
				durationMs: Date.now() - startedAt,
				reason,
				...(error === undefined
					? {}
					: { error: error instanceof Error ? error.message : "unknown" }),
			});
			return { kind: "failed" };
		};
		let transcription: Transcription;
		try {
			const fresh = await freshAttachment(
				message,
				attachment,
				this.deps.history,
			);
			if (fresh === null) {
				return fail("unavailable");
			}
			const audio = await this.deps.download(fresh.url);
			if (audio === null) {
				return fail("download");
			}
			transcription = await this.deps.transcribe(audio);
		} catch (error) {
			return fail("error", error);
		}
		// 文字にした内容は残さない(長さと、声が入っていたかだけ)
		log("transcribed", {
			source,
			durationSecs: secs,
			durationMs: Date.now() - startedAt,
			language: transcription.language,
			empty: transcription.text === "",
		});
		try {
			await saveVoiceTranscript(this.deps.db, {
				messageId: message.messageId,
				channelId: message.channelId,
				text: transcription.text,
				language: transcription.language,
				durationSecs: secs,
				model: TRANSCRIPTION_MODEL,
			});
		} catch (error) {
			// 保存できなくても、この返答では文字にした内容を使う
			log("transcript_save_failed", {
				source,
				error: error instanceof Error ? error.message : "unknown",
			});
			return { kind: "text", text: transcription.text };
		}
		try {
			await this.deps.saved?.({
				channelId: message.channelId,
				messageId: message.messageId,
			});
		} catch (error) {
			log("embed_enqueue_failed", {
				source,
				error: error instanceof Error ? error.message : "unknown",
			});
		}
		return { kind: "text", text: transcription.text };
	}
}

/**
 * 返答の中で使う、音声メッセージを文字にするもの(1回の返答で、合わせて20分まで)。
 * 新しく文字にしたら、ベクトルを入れる仕事を入れる。保存したメッセージ(共有チャンネルの分)なら、
 * 文字にした内容で探せるようになる。返答を待たせないよう、ベクトルは別の仕事で入れる
 */
export function voiceReaderFor(
	env: Env,
	history: VoiceReaderDeps["history"],
): VoiceReader {
	return new VoiceReader({
		db: env.DB,
		history,
		transcribe: (audio) => transcribeAudio(env.AI, audio),
		download: downloadAudio,
		saved: async (location) => {
			await env.RESPOND_QUEUE.send({
				kind: "transcribe",
				...location,
			} satisfies QueueMessage);
		},
	});
}

/**
 * 音声のファイルを、DiscordのCDNから読む。読めないか、大きすぎればnull。
 * 大きさは、先に知らされた値でも確かめる(読み込む前に断るため)
 */
export async function downloadAudio(url: string): Promise<Uint8Array | null> {
	const response = await fetch(url);
	if (!response.ok) {
		return null;
	}
	const length = Number(response.headers.get("content-length") ?? 0);
	if (length > MAX_VOICE_BYTES) {
		await response.body?.cancel();
		return null;
	}
	const bytes = new Uint8Array(await response.arrayBuffer());
	return bytes.byteLength > MAX_VOICE_BYTES ? null : bytes;
}

function log(event: string, detail: Record<string, unknown>): void {
	logEvent("voice", event, detail);
}
