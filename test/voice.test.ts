import { env } from "cloudflare:workers";
import type { APIAttachment, APIMessage } from "discord-api-types/v10";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toIncomingMessage } from "../src/gateway/agents";
import { type GatewayMessage, toStoredMessage } from "../src/gateway/messages";
import type { ChatResult } from "../src/llm/types";
import { withVoiceText } from "../src/memory/update";
import {
	EAGER_TRANSCRIPTION_WINDOW_MS,
	embedMessages,
	ingestMessages,
} from "../src/queue/ingest";
import type { AttachmentInfo, StoredMessageInput } from "../src/queue/messages";
import { FileCatalog, fileKind } from "../src/respond/attachments";
import { toConversation } from "../src/respond/conversation";
import type { HistoryDeps } from "../src/respond/history";
import { formatReply, REFUSAL_TEXT } from "../src/respond/replies";
import { summaryRequest } from "../src/respond/summary";
import {
	deleteChannelMessages,
	deleteStoredMessages,
	saveMessages,
} from "../src/store/messages";
import {
	loadVoiceTranscripts,
	saveVoiceTranscript,
	storedVoiceTexts,
} from "../src/store/voice";
import { handleTranscribeJob } from "../src/voice/job";
import { VoiceReader, type VoiceReaderDeps } from "../src/voice/reader";
import { heardNote } from "../src/voice/texts";
import {
	formatVoiceDuration,
	isVoiceAttachment,
	normalizeTranscript,
	TRANSCRIPTION_MODEL,
	transcribeAudio,
	type VoiceText,
} from "../src/voice/voice";
import { ALICE, at, BOT, CHANNEL_ID, discordMessage } from "./fixtures";
import { fakeIngestDeps, mockFetch } from "./helpers";

afterEach(() => {
	vi.restoreAllMocks();
});

/** DiscordのURLの期限(exは16進数のUNIX時間の秒) */
function expiry(msFromNow: number): string {
	return Math.floor((Date.now() + msFromNow) / 1000).toString(16);
}

let nextId = 70_000;

/** 音声メッセージの音声。URLの期限は、既定で1日後 */
function voiceAttachment(
	options: { secs?: number; expiresIn?: number; id?: string } = {},
): AttachmentInfo {
	const { secs = 12, expiresIn = 24 * 60 * 60 * 1000, id = "1" } = options;
	return {
		filename: "voice-message.ogg",
		url: `https://cdn.discordapp.com/attachments/${CHANNEL_ID}/${id}/voice-message.ogg?ex=${expiry(expiresIn)}&is=0&hm=0`,
		contentType: "audio/ogg",
		size: Math.round(secs * 4000),
		voiceDurationSecs: secs,
	};
}

/** 保存の形の、Aliceの音声メッセージ */
function voiceMessage(
	overrides: Partial<StoredMessageInput> = {},
	attachment = voiceAttachment(),
): StoredMessageInput {
	return {
		messageId: String(nextId++),
		guildId: "900",
		channelId: CHANNEL_ID,
		authorId: ALICE.id,
		authorName: "Alice",
		authorIsBot: false,
		content: "",
		replyToId: null,
		mentions: [],
		attachments: [attachment],
		embeds: [],
		command: null,
		members: [],
		createdAt: Date.parse("2026-10-24T00:00:00.000Z"),
		editedAt: null,
		...overrides,
	};
}

/** Discordが送る、音声メッセージ(flagsのIS_VOICE_MESSAGEと、音声の長さ) */
function discordVoiceMessage(id: string, secs = 12.3): APIMessage {
	const attachment: APIAttachment = {
		id: "55",
		filename: "voice-message.ogg",
		size: 49_000,
		url: `https://cdn.discordapp.com/attachments/${CHANNEL_ID}/55/voice-message.ogg`,
		proxy_url: `https://media.discordapp.net/attachments/${CHANNEL_ID}/55/voice-message.ogg`,
		content_type: "audio/ogg",
		duration_secs: secs,
		waveform: "AAAA",
	};
	return discordMessage(id, ALICE, "", {
		flags: 1 << 13,
		attachments: [attachment],
	});
}

/** 過去のメッセージの読み先の偽物。Discordから読むと、freshを返す */
function fakeHistory(fresh: APIMessage | null = null) {
	const fetched: [string, string][] = [];
	const ingested: StoredMessageInput[] = [];
	const deps: Pick<HistoryDeps, "fetchMessage" | "ingest" | "guildId"> = {
		guildId: "900",
		fetchMessage: async (channelId, messageId) => {
			fetched.push([channelId, messageId]);
			return fresh;
		},
		ingest: async (messages) => {
			ingested.push(...messages);
		},
	};
	return { deps, fetched, ingested };
}

/** 文字にするものの偽物。transcribeは、呼ばれた順に、textsの文を返す */
function readerOf(
	texts: (string | Error)[] = ["明日の午後3時から部室で集まろう"],
	options: { budgetSecs?: number; fresh?: APIMessage | null } = {},
) {
	const history = fakeHistory(options.fresh ?? null);
	const transcribe = vi.fn(async () => {
		const next = texts.shift() ?? "";
		if (next instanceof Error) {
			throw next;
		}
		return { text: next, language: "ja" };
	});
	const downloaded: string[] = [];
	const saved = vi.fn(async () => {});
	const deps: VoiceReaderDeps = {
		db: env.DB,
		history: history.deps,
		transcribe,
		download: async (url) => {
			downloaded.push(url);
			return new Uint8Array([1, 2, 3]);
		},
		saved,
	};
	return {
		reader: new VoiceReader(deps, options.budgetSecs),
		transcribe,
		downloaded,
		saved,
		history,
	};
}

describe("音声メッセージの見分け方", () => {
	it("Discordのメッセージを保存の形にするときに、音声メッセージなら、音声の長さを入れる", () => {
		const voice = toStoredMessage({
			...discordVoiceMessage("1"),
			guild_id: "900",
		} as GatewayMessage);
		const normal = toStoredMessage({
			...discordMessage("2", ALICE, "", {
				attachments: [
					{
						id: "56",
						filename: "song.ogg",
						size: 100,
						url: "https://cdn.discordapp.com/attachments/800/56/song.ogg",
						proxy_url:
							"https://media.discordapp.net/attachments/800/56/song.ogg",
						content_type: "audio/ogg",
						duration_secs: 30,
					},
				],
			}),
			guild_id: "900",
		} as GatewayMessage);

		expect(voice.attachments[0]?.voiceDurationSecs).toBe(12.3);
		expect(normal.attachments[0]).not.toHaveProperty("voiceDurationSecs");
	});

	it("エージェントのチャンネルに渡すときも、音声メッセージなら、音声の長さを入れる", () => {
		const incoming = toIncomingMessage({
			...discordVoiceMessage("3"),
			guild_id: "900",
		} as GatewayMessage);

		expect(incoming.attachments[0]?.voiceDurationSecs).toBe(12.3);
	});

	it("前に保存したもの(長さがない)は、Discordが付ける名前と形式で見分ける", () => {
		const legacy: AttachmentInfo = {
			filename: "voice-message.ogg",
			url: "https://cdn.discordapp.com/attachments/800/1/voice-message.ogg",
			contentType: "audio/ogg",
			size: 48_000,
		};

		expect(isVoiceAttachment(legacy)).toBe(true);
		expect(isVoiceAttachment({ ...legacy, filename: "song.ogg" })).toBe(false);
		expect(fileKind(legacy)).toBe("voice");
		expect(
			fileKind({ ...legacy, filename: "song.mp3", contentType: "audio/mpeg" }),
		).toBeNull();
	});
});

describe("書き方", () => {
	it("音声の長さは、分と秒にする(1秒に満たない端数は切り上げる)", () => {
		expect(formatVoiceDuration(0)).toBe("0:00");
		expect(formatVoiceDuration(12)).toBe("0:12");
		expect(formatVoiceDuration(12.2)).toBe("0:13");
		expect(formatVoiceDuration(725)).toBe("12:05");
	});

	it("文字にした内容の、改行と続く空白は、1つの空白にする", () => {
		expect(normalizeTranscript(" 明日は。 \n それと、 来週も ")).toBe(
			"明日は。 それと、 来週も",
		);
	});

	it("聞き取った内容の行は、200文字を超える分を「…」で省き、書式になる文字はそのまま見えるようにする", () => {
		expect(heardNote("明日の午後3時から")).toBe(
			"-# 聞き取った内容: 「明日の午後3時から」",
		);
		expect(heardNote(`${"あ".repeat(200)}い`)).toBe(
			`-# 聞き取った内容: 「${"あ".repeat(200)}…」`,
		);
		expect(heardNote("snake_case と *強調*")).toBe(
			"-# 聞き取った内容: 「snake\\_case と \\*強調\\*」",
		);
	});
});

describe("Workers AIで文字にする", () => {
	it("音声をbase64で渡し、Bobertの名前をヒントにして、声のない部分を飛ばす", async () => {
		const run = vi.fn(async () => ({
			text: " ボバート、明日の午後3時から。 \n それと、議事録も ",
			transcription_info: { language: "ja" },
		}));

		const result = await transcribeAudio(
			{ run } as unknown as Ai,
			new Uint8Array([1, 2, 3]),
		);

		expect(run).toHaveBeenCalledWith(TRANSCRIPTION_MODEL, {
			audio: "AQID",
			initial_prompt: "Bobert(ボバート)",
			vad_filter: true,
		});
		expect(result).toEqual({
			text: "ボバート、明日の午後3時から。 それと、議事録も",
			language: "ja",
		});
	});
});

describe("AIに見せる形", () => {
	const options = { botUserId: BOT.id, includeImages: false, names: new Map() };

	function line(message: StoredMessageInput, voice?: VoiceText): string {
		const [first] = toConversation([message], {
			...options,
			voice:
				voice === undefined ? undefined : new Map([[message.messageId, voice]]),
		}).messages;
		const part = first?.parts[0];
		return part?.type === "text" ? part.text : "";
	}

	it("文字にした内容を、音声メッセージの本文として書く", () => {
		const message = voiceMessage();

		expect(line(message, { kind: "text", text: "明日の午後3時から" })).toBe(
			at("Alice: [音声メッセージ(0:12)] 明日の午後3時から"),
		);
		expect(line(message, { kind: "text", text: "" })).toBe(
			at("Alice: [音声メッセージ(0:12)](声が入っていませんでした)"),
		);
		expect(line(message, { kind: "failed" })).toBe(
			at("Alice: [音声メッセージ(0:12)](文字にできませんでした)"),
		);
		expect(line(message, { kind: "over_budget" })).toBe(
			at(
				"Alice: [音声メッセージ(0:12)](長いため、この返答では文字にしていません)",
			),
		);
	});

	it("文字にしていなければ、ファイルを読む道具を渡すときは番号を付け、渡さないときは音声メッセージであることだけを書く", () => {
		const message = voiceMessage();
		const files = new FileCatalog({ images: true, pdfs: true });
		const [numbered] = toConversation([message], {
			...options,
			files,
		}).messages;
		const [plain] = toConversation([message], options).messages;

		expect(numbered?.parts[0]).toEqual({
			type: "text",
			text: at("Alice: [ファイル1: voice-message.ogg(音声メッセージ、0:12)]"),
		});
		expect(files.find(1)?.kind).toBe("voice");
		expect(plain?.parts[0]).toEqual({
			type: "text",
			text: at("Alice: [音声メッセージ(0:12)]"),
		});
	});

	it("前に保存したもの(長さがない)は、長さを書かない", () => {
		const { voiceDurationSecs: _, ...legacy } = voiceAttachment();
		const message = voiceMessage({}, legacy);

		expect(line(message, { kind: "text", text: "了解" })).toBe(
			at("Alice: [音声メッセージ] 了解"),
		);
	});

	it("会話の要約にも、文字にした内容を書く", () => {
		const message = voiceMessage();
		const request = summaryRequest({
			modelId: "claude-haiku-5-5",
			effort: null,
			previous: null,
			messages: [message],
			botUserId: BOT.id,
			names: new Map(),
			voice: new Map([[message.messageId, { kind: "text", text: "了解" }]]),
		});

		expect(request.messages[0]?.parts[0]).toEqual({
			type: "text",
			text: at("Alice: [音声メッセージ(0:12)] 了解"),
		});
	});
});

describe("返答の注記", () => {
	function chatResult(
		text: string,
		stopReason: ChatResult["stopReason"] = "end",
	): ChatResult {
		const usage = {
			inputTokens: 1,
			outputTokens: 1,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			webSearchRequests: 0,
			costUsd: null,
		};
		return {
			text,
			stopReason,
			usage,
			requestUsages: [usage],
			sources: [],
			toolCalls: 0,
		};
	}

	it("聞き取った内容は、返答の後、利用量と寄付の行より上に書く", () => {
		const heard = heardNote("明日の午後3時から");
		const usage = "-# 入力 10トークン・出力 5トークン・約$0.0001";
		const donation = "-# 寄付されたクレジットで答えました(残り 約$1.00)";

		expect(
			formatReply(chatResult("了解!"), {
				heard,
				imagesSkipped: false,
				webSearchSkipped: false,
				usage,
				donation,
			}),
		).toBe(["了解!", heard, usage, donation].join("\n"));
		expect(
			formatReply(chatResult("", "refusal"), {
				heard,
				imagesSkipped: false,
				webSearchSkipped: false,
				usage,
			}),
		).toBe([REFUSAL_TEXT, heard, usage].join("\n"));
	});
});

describe("文字にする(返答の中)", () => {
	it("会話の音声メッセージを、新しいものから文字にし、保存して、ベクトルを入れる仕事を入れる", async () => {
		const older = voiceMessage();
		const newer = voiceMessage();
		const { reader, transcribe, saved } = readerOf(["新しい方", "古い方"]);

		const texts = await reader.prepare([older, newer]);

		expect(texts.get(newer.messageId)).toEqual({
			kind: "text",
			text: "新しい方",
		});
		expect(texts.get(older.messageId)).toEqual({
			kind: "text",
			text: "古い方",
		});
		expect(transcribe).toHaveBeenCalledTimes(2);
		const stored = await loadVoiceTranscripts(env.DB, [
			older.messageId,
			newer.messageId,
		]);
		expect(stored.get(newer.messageId)).toMatchObject({
			channelId: CHANNEL_ID,
			text: "新しい方",
			language: "ja",
			durationSecs: 12,
			model: TRANSCRIPTION_MODEL,
		});
		expect(saved).toHaveBeenCalledWith({
			channelId: CHANNEL_ID,
			messageId: newer.messageId,
		});
	});

	it("文字にした内容を保存してあれば、文字にし直さない", async () => {
		const message = voiceMessage();
		await saveVoiceTranscript(env.DB, {
			messageId: message.messageId,
			channelId: CHANNEL_ID,
			text: "前に文字にした内容",
			language: "ja",
			durationSecs: 12,
			model: TRANSCRIPTION_MODEL,
		});
		const { reader, transcribe } = readerOf();

		const texts = await reader.prepare([message]);

		expect(texts.get(message.messageId)).toEqual({
			kind: "text",
			text: "前に文字にした内容",
		});
		expect(transcribe).not.toHaveBeenCalled();
	});

	it("新しく文字にする長さが上限を超えるものは、文字にしない(新しいものから数える)", async () => {
		const older = voiceMessage({}, voiceAttachment({ secs: 15 * 60 }));
		const newer = voiceMessage({}, voiceAttachment({ secs: 15 * 60 }));
		const { reader, transcribe } = readerOf(["新しい方"]);

		const texts = await reader.prepare([older, newer]);

		expect(texts.get(newer.messageId)).toEqual({
			kind: "text",
			text: "新しい方",
		});
		expect(texts.get(older.messageId)).toEqual({ kind: "over_budget" });
		expect(transcribe).toHaveBeenCalledTimes(1);
	});

	it("20分を超える音声は文字にしない", async () => {
		const message = voiceMessage({}, voiceAttachment({ secs: 21 * 60 }));
		const { reader, transcribe } = readerOf([], { budgetSecs: 60 * 60 });

		expect(
			await reader.read(
				message,
				message.attachments[0] as AttachmentInfo,
				"read_file",
			),
		).toEqual({
			kind: "failed",
		});
		expect(transcribe).not.toHaveBeenCalled();
	});

	it("文字にできなければ失敗として返し、保存しない", async () => {
		const message = voiceMessage();
		const { reader, saved } = readerOf([new Error("3040: Out of capacity")]);

		const texts = await reader.prepare([message]);

		expect(texts.get(message.messageId)).toEqual({ kind: "failed" });
		expect(saved).not.toHaveBeenCalled();
		expect((await loadVoiceTranscripts(env.DB, [message.messageId])).size).toBe(
			0,
		);
	});

	it("同じ音声メッセージを同時に読んでも、文字にするのは1回だけ", async () => {
		const message = voiceMessage();
		const attachment = message.attachments[0] as AttachmentInfo;
		const { reader, transcribe } = readerOf(["一度だけ"]);

		const [first, second] = await Promise.all([
			reader.read(message, attachment, "read_file"),
			reader.read(message, attachment, "read_file"),
		]);

		expect(first).toEqual({ kind: "text", text: "一度だけ" });
		expect(second).toEqual(first);
		expect(transcribe).toHaveBeenCalledTimes(1);
	});

	it("URLの期限が近ければ、メッセージを読み直して、新しいURLで読む。消えていたら、文字にできない", async () => {
		const stale = voiceMessage(
			{ messageId: "70500" },
			voiceAttachment({ expiresIn: 60_000, id: "55" }),
		);
		const fresh = discordVoiceMessage("70500");
		const refreshed = readerOf(["読み直した"], { fresh });

		expect(await refreshed.reader.prepare([stale])).toEqual(
			new Map([["70500", { kind: "text", text: "読み直した" }]]),
		);
		expect(refreshed.history.fetched).toEqual([[CHANNEL_ID, "70500"]]);
		expect(refreshed.downloaded).toEqual([fresh.attachments[0]?.url]);
		expect(refreshed.history.ingested.map((m) => m.messageId)).toEqual([
			"70500",
		]);

		const gone = voiceMessage({}, voiceAttachment({ expiresIn: 60_000 }));
		const missing = readerOf(["使われない"]);
		expect((await missing.reader.prepare([gone])).get(gone.messageId)).toEqual({
			kind: "failed",
		});
		expect(missing.transcribe).not.toHaveBeenCalled();
	});
});

describe("文字にした内容の保存", () => {
	it("保存したメッセージなら、文字にした内容でベクトルを入れ直すため、入れた記録を消す", async () => {
		const message = voiceMessage();
		await saveMessages(env.DB, [message]);
		await env.DB.prepare(
			"UPDATE messages SET embedded_at = 1 WHERE message_id = ?",
		)
			.bind(message.messageId)
			.run();

		await saveVoiceTranscript(env.DB, {
			messageId: message.messageId,
			channelId: CHANNEL_ID,
			text: "了解",
			language: "ja",
			durationSecs: 12,
			model: TRANSCRIPTION_MODEL,
		});

		expect(
			await env.DB.prepare(
				"SELECT embedded_at FROM messages WHERE message_id = ?",
			)
				.bind(message.messageId)
				.first("embedded_at"),
		).toBeNull();
	});

	it("消されたメッセージの分は保存せず、メッセージやチャンネルを消したら、一緒に消す", async () => {
		const transcript = (messageId: string, channelId = CHANNEL_ID) => ({
			messageId,
			channelId,
			text: "了解",
			language: "ja",
			durationSecs: 12,
			model: TRANSCRIPTION_MODEL,
		});
		await deleteStoredMessages(env.DB, ["70601"]);
		await saveVoiceTranscript(env.DB, transcript("70601"));
		await saveVoiceTranscript(env.DB, transcript("70602"));
		await saveVoiceTranscript(env.DB, transcript("70603", "8100"));
		await saveVoiceTranscript(env.DB, transcript("70604", "8200"));

		await deleteStoredMessages(env.DB, ["70602"]);
		await deleteChannelMessages(env.DB, ["8100"]);

		const left = await loadVoiceTranscripts(env.DB, [
			"70601",
			"70602",
			"70603",
			"70604",
		]);
		expect([...left.keys()]).toEqual(["70604"]);
	});

	it("道具の結果などで使う、保存した内容は、音声メッセージの分だけ読む", async () => {
		const voice = voiceMessage();
		const text = voiceMessage({ content: "テキスト", attachments: [] });
		await saveVoiceTranscript(env.DB, {
			messageId: voice.messageId,
			channelId: CHANNEL_ID,
			text: "了解",
			language: "ja",
			durationSecs: 12,
			model: TRANSCRIPTION_MODEL,
		});

		expect(await storedVoiceTexts(env.DB, [voice, text])).toEqual(
			new Map([[voice.messageId, { kind: "text", text: "了解" }]]),
		);
	});

	it("記憶をまとめるときは、文字にした内容を本文にする", async () => {
		const voice = voiceMessage();
		const unread = voiceMessage();
		const text = voiceMessage({ content: "テキスト", attachments: [] });
		await saveVoiceTranscript(env.DB, {
			messageId: voice.messageId,
			channelId: CHANNEL_ID,
			text: "辛いものが苦手",
			language: "ja",
			durationSecs: 12,
			model: TRANSCRIPTION_MODEL,
		});

		const result = await withVoiceText(env.DB, [voice, unread, text]);

		expect(result.map((message) => message.content)).toEqual([
			"[音声メッセージ] 辛いものが苦手",
			"",
			"テキスト",
		]);
	});
});

describe("前もって文字にする", () => {
	it("届いたばかりの音声メッセージを保存したら、文字にする仕事を入れる。過去のものと、文字にしてあるものは除く", async () => {
		const { deps, transcribing } = fakeIngestDeps(BOT.id);
		const fresh = voiceMessage({ createdAt: Date.now() - 60_000 });
		const old = voiceMessage({
			createdAt: Date.now() - EAGER_TRANSCRIPTION_WINDOW_MS - 60_000,
		});
		const done = voiceMessage({ createdAt: Date.now() });
		const text = voiceMessage({
			content: "テキスト",
			attachments: [],
			createdAt: Date.now(),
		});
		await saveVoiceTranscript(env.DB, {
			messageId: done.messageId,
			channelId: CHANNEL_ID,
			text: "了解",
			language: "ja",
			durationSecs: 12,
			model: TRANSCRIPTION_MODEL,
		});

		await ingestMessages([fresh, old, done, text], deps);

		expect(transcribing).toEqual([
			{ channelId: CHANNEL_ID, messageId: fresh.messageId },
		]);
	});

	it("文字にした内容を保存したら、それでベクトルを入れる(文字にするまでは、本文が空なので入れない)", async () => {
		const { deps, embedded, upserted } = fakeIngestDeps(BOT.id);
		const message = voiceMessage();
		await ingestMessages([message], deps);
		expect(embedded).toEqual([]);

		await saveVoiceTranscript(env.DB, {
			messageId: message.messageId,
			channelId: CHANNEL_ID,
			text: "明日の午後3時から",
			language: "ja",
			durationSecs: 12,
			model: TRANSCRIPTION_MODEL,
		});
		await embedMessages([message.messageId], deps);

		expect(embedded).toEqual(["明日の午後3時から"]);
		expect(upserted.map((vector) => vector.id)).toEqual([message.messageId]);
	});
});

describe("文字にする仕事", () => {
	/** Workers AIの偽物。Whisperには文字にした内容を、埋め込みにはベクトルを返す */
	function fakeAi(transcript: string | Error) {
		const models: string[] = [];
		const ai = {
			run: async (model: string, input: { text?: string[] }) => {
				models.push(model);
				if (model === TRANSCRIPTION_MODEL) {
					if (transcript instanceof Error) {
						throw transcript;
					}
					return { text: transcript, transcription_info: { language: "ja" } };
				}
				return { data: (input.text ?? []).map(() => [0.1, 0.2]) };
			},
		} as unknown as Ai;
		return { ai, models };
	}

	function testEnv(ai: Ai) {
		const upserted: string[] = [];
		const vectors = {
			upsert: async (list: VectorizeVector[]) => {
				upserted.push(...list.map((vector) => vector.id));
				return { mutationId: "m" };
			},
			deleteByIds: async () => ({ mutationId: "m" }),
		};
		return {
			env: {
				...env,
				AI: ai,
				VECTORIZE: vectors as unknown as Env["VECTORIZE"],
			} as Env,
			upserted,
		};
	}

	function mockCdn() {
		return mockFetch((call) =>
			call.url.hostname === "cdn.discordapp.com"
				? new Response(new Uint8Array([1, 2, 3]))
				: new Response(null, { status: 500 }),
		);
	}

	it("保存した音声メッセージを文字にして保存し、文字にした内容でベクトルを入れる", async () => {
		const message = voiceMessage();
		await saveMessages(env.DB, [message]);
		const { ai, models } = fakeAi("明日の午後3時から");
		const test = testEnv(ai);
		mockCdn();

		await handleTranscribeJob(
			{
				kind: "transcribe",
				channelId: CHANNEL_ID,
				messageId: message.messageId,
			},
			test.env,
		);

		expect(models).toEqual([TRANSCRIPTION_MODEL, "@cf/baai/bge-m3"]);
		expect(
			(await loadVoiceTranscripts(env.DB, [message.messageId])).get(
				message.messageId,
			)?.text,
		).toBe("明日の午後3時から");
		expect(test.upserted).toEqual([message.messageId]);
	});

	it("保存していないメッセージ(共有しないチャンネルの分や、消されたもの)は、何もしない", async () => {
		const { ai, models } = fakeAi("使われない");

		await handleTranscribeJob(
			{ kind: "transcribe", channelId: CHANNEL_ID, messageId: "70999" },
			testEnv(ai).env,
		);

		expect(models).toEqual([]);
	});

	it("文字にできなければ、Queueでやり直す", async () => {
		const message = voiceMessage();
		await saveMessages(env.DB, [message]);
		const { ai } = fakeAi(new Error("3040: Out of capacity"));
		mockCdn();

		await expect(
			handleTranscribeJob(
				{
					kind: "transcribe",
					channelId: CHANNEL_ID,
					messageId: message.messageId,
				},
				testEnv(ai).env,
			),
		).rejects.toThrow();
	});
});
