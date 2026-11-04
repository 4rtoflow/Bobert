import { env } from "cloudflare:workers";
import { describe, expect, it, type Mock, vi } from "vitest";
import { ChannelType } from "../src/discord/constants";
import { type JobHandlers, processBatch } from "../src/queue/consumer";
import { deleteMessages, ingestMessages } from "../src/queue/ingest";
import type { QueueMessage, StoredMessageInput } from "../src/queue/messages";
import { deleteStoredMessages } from "../src/store/messages";
import {
	fakeIngestDeps,
	hiddenFromEveryone,
	recordChannels,
	shownToBotRole,
} from "./helpers";

const BOT_ID = "1000";
const CREATED_AT = Date.parse("2026-10-27T00:00:00.000Z");

let nextId = 9000;

/** 保存用のメッセージ。IDはテストごとに変える */
function storedMessage(
	overrides: Partial<StoredMessageInput> = {},
): StoredMessageInput {
	return {
		messageId: String(nextId++),
		guildId: "4000",
		channelId: "3000",
		authorId: "5000",
		authorName: "ありす",
		authorIsBot: false,
		content: "明日は10時から集まろう",
		replyToId: null,
		mentions: [],
		attachments: [],
		embeds: [],
		command: null,
		members: [{ id: "5000", name: "ありす" }],
		createdAt: CREATED_AT,
		editedAt: null,
		...overrides,
	};
}

function fakeDeps() {
	return fakeIngestDeps(BOT_ID);
}

function storedRow(messageId: string) {
	return env.DB.prepare("SELECT * FROM messages WHERE message_id = ?")
		.bind(messageId)
		.first<Record<string, unknown>>();
}

function memberName(userId: string) {
	return env.DB.prepare(
		"SELECT name FROM guild_members WHERE guild_id = ? AND user_id = ?",
	)
		.bind("4000", userId)
		.first<string>("name");
}

describe("メッセージの保存とベクトル化", () => {
	it("D1に保存して、ベクトルを入れる", async () => {
		const { deps, upserted, embedded } = fakeDeps();
		const message = storedMessage({
			replyToId: "8999",
			attachments: [
				{
					filename: "cat.png",
					url: "https://cdn.example/cat.png",
					contentType: "image/png",
					size: 1234,
				},
			],
		});

		await ingestMessages([message], deps);

		const row = await storedRow(message.messageId);
		expect(row).toMatchObject({
			guild_id: "4000",
			channel_id: "3000",
			author_id: "5000",
			author_name: "ありす",
			author_is_bot: 0,
			content: "明日は10時から集まろう",
			reply_to_id: "8999",
			created_at: CREATED_AT,
			edited_at: null,
		});
		expect(JSON.parse(row?.attachments as string)).toEqual(message.attachments);
		expect(row?.embedded_at).not.toBeNull();
		expect(embedded).toEqual(["明日は10時から集まろう"]);
		// ベクトルのIDはメッセージID、名前空間はチャンネルID。サーバー全体を探せるよう、サーバーIDも付ける
		expect(upserted).toEqual([
			{
				id: message.messageId,
				namespace: "3000",
				values: [0.1, 0.2],
				metadata: {
					author_id: "5000",
					created_at: CREATED_AT,
					guild_id: "4000",
				},
			},
		]);
	});

	it("保存するのは、共有チャンネル(Botが見られて、年齢制限がないチャンネル)のメッセージだけ。年齢制限のチャンネルと非公開スレッドの分は保存しない", async () => {
		const { deps, embedded } = fakeDeps();
		const guildId = "4100";
		await recordChannels(guildId, [
			{ channelId: "3101" },
			// @everyoneは見られないが、Botのロールは見られる
			{ channelId: "3102", overwrites: shownToBotRole(guildId) },
			// Botも見られない(このようなメッセージは、ふつうは届かない)
			{ channelId: "3103", overwrites: hiddenFromEveryone(guildId) },
			{ channelId: "3104", nsfw: true },
			{
				channelId: "3105",
				type: ChannelType.PrivateThread,
				parentId: "3101",
			},
		]);
		const messages = ["3101", "3102", "3103", "3104", "3105"].map((channelId) =>
			storedMessage({ guildId, channelId }),
		);

		const saved = await ingestMessages(messages, deps);

		expect(saved).toBe(2);
		const rows = await Promise.all(
			messages.map((message) => storedRow(message.messageId)),
		);
		expect(rows.map((row) => row !== null)).toEqual([
			true,
			true,
			false,
			false,
			false,
		]);
		expect(embedded).toEqual([
			"明日は10時から集まろう",
			"明日は10時から集まろう",
		]);
	});

	it("記録にないチャンネルは、DiscordのAPIで確かめる。Botが見られなければ、保存しない", async () => {
		const { deps } = fakeDeps();
		const asked: string[] = [];
		const message = storedMessage({ guildId: "4200", channelId: "3201" });

		const saved = await ingestMessages([message], {
			...deps,
			fetchChannel: async (channelId) => {
				asked.push(channelId);
				return null;
			},
		});

		expect(saved).toBe(0);
		expect(asked).toEqual(["3201"]);
		expect(await storedRow(message.messageId)).toBeNull();
	});

	it("`/import`の進み具合のメッセージは、保存しない", async () => {
		const { deps } = fakeDeps();
		const progress = storedMessage({
			authorId: BOT_ID,
			authorName: "Bobert",
			authorIsBot: true,
			content: "取り込み中: 42% (ETA: 3:05)",
			command: {
				name: "import",
				contextMenu: false,
				userId: "5000",
				userName: "ありす",
			},
		});

		await ingestMessages([progress], deps);

		expect(await storedRow(progress.messageId)).toBeNull();
	});

	it("メンションは名前に置き換え、Bobertの返答は末尾の注記を外してベクトルにする", async () => {
		const { deps, embedded } = fakeDeps();

		await ingestMessages(
			[
				storedMessage({
					content: "<@6000> 了解!",
					mentions: [{ id: "6000", name: "ぼぶ" }],
				}),
				storedMessage({
					authorId: BOT_ID,
					authorName: "Bobert",
					authorIsBot: true,
					content: "10時からだよ!\n-# 入力 10トークン",
				}),
			],
			deps,
		);

		expect([...embedded].sort()).toEqual(["10時からだよ!", "@ぼぶ 了解!"]);
	});

	it("Embedの中身もベクトルにする(本文が空でも)", async () => {
		const { deps, embedded } = fakeDeps();

		await ingestMessages(
			[
				storedMessage({
					content: "",
					embeds: [
						{
							title: "✅ 店舗を追加しました",
							fields: [{ name: "店舗名", value: "aaa" }],
						},
					],
				}),
			],
			deps,
		);

		expect(embedded).toEqual([
			["✅ 店舗を追加しました", "店舗名: aaa"].join("\n"),
		]);
	});

	it("本文が同じでも、Embedが変わったら(リンクのプレビューが届いたら)、ベクトルを入れ直す", async () => {
		const { deps, embedded } = fakeDeps();
		const message = storedMessage({
			content: "これ見て https://x.com/bob/status/1",
		});

		await ingestMessages([message], deps);
		await ingestMessages(
			[{ ...message, embeds: [{ provider: "X", description: "投稿の本文" }] }],
			deps,
		);

		expect(embedded).toEqual([
			"これ見て https://x.com/bob/status/1",
			["これ見て https://x.com/bob/status/1", "X", "投稿の本文"].join("\n"),
		]);
		const row = await storedRow(message.messageId);
		expect(JSON.parse(row?.embeds as string)).toEqual([
			{ provider: "X", description: "投稿の本文" },
		]);
	});

	it("編集されたら、保存し直して、ベクトルを入れ直す", async () => {
		const { deps, embedded } = fakeDeps();
		const message = storedMessage();

		await ingestMessages([message], deps);
		await ingestMessages(
			[
				{
					...message,
					content: "明日は11時からにしよう",
					editedAt: CREATED_AT + 60_000,
				},
			],
			deps,
		);

		expect(await storedRow(message.messageId)).toMatchObject({
			content: "明日は11時からにしよう",
			edited_at: CREATED_AT + 60_000,
		});
		expect(embedded).toEqual([
			"明日は10時から集まろう",
			"明日は11時からにしよう",
		]);
	});

	it("編集が作成より先に処理されても、古い版では上書きしない", async () => {
		const { deps, embedded } = fakeDeps();
		const message = storedMessage();
		const edited = {
			...message,
			content: "明日は11時からにしよう",
			editedAt: CREATED_AT + 60_000,
		};

		await ingestMessages([edited], deps);
		await ingestMessages([message], deps);

		expect(await storedRow(message.messageId)).toMatchObject({
			content: "明日は11時からにしよう",
			edited_at: CREATED_AT + 60_000,
		});
		expect(embedded).toEqual(["明日は11時からにしよう"]);
	});

	it("同じメッセージが何度届いても、ベクトルは1回だけ入れる", async () => {
		const { deps, embedded } = fakeDeps();
		const message = storedMessage();

		// 同じまとまりの中で重なったときと、後からもう一度届いたとき
		await ingestMessages([message, message], deps);
		await ingestMessages([message], deps);

		expect(embedded).toEqual(["明日は10時から集まろう"]);
	});

	it("本文が変わらない編集では、ベクトルを入れ直さない", async () => {
		const { deps, embedded } = fakeDeps();
		const message = storedMessage();

		await ingestMessages([message], deps);
		await ingestMessages([{ ...message, editedAt: CREATED_AT + 1000 }], deps);

		expect(embedded).toHaveLength(1);
	});

	it("本文が空のメッセージ(添付だけなど)は、保存するが、ベクトルにしない", async () => {
		const { deps, upserted, embedded } = fakeDeps();
		const message = storedMessage({
			content: "",
			attachments: [
				{
					filename: "cat.png",
					url: "https://cdn.example/cat.png",
					contentType: "image/png",
					size: 1234,
				},
			],
		});

		await ingestMessages([message], deps);

		expect(await storedRow(message.messageId)).not.toBeNull();
		expect(embedded).toEqual([]);
		expect(upserted).toEqual([]);
	});

	it("編集で本文が空になったら、前のベクトルを消す", async () => {
		const { deps, deleted } = fakeDeps();
		const message = storedMessage();

		await ingestMessages([message], deps);
		await ingestMessages(
			[{ ...message, content: "", editedAt: CREATED_AT + 1000 }],
			deps,
		);

		expect(deleted).toEqual([message.messageId]);
	});

	it("Discordから読み直したメッセージ(ニックネームが分からない)では、発言者の名前を書き換えない", async () => {
		const { deps } = fakeDeps();
		const message = storedMessage();

		await ingestMessages([message], deps);
		await ingestMessages(
			[{ ...message, authorName: "Alice", members: [] }],
			deps,
		);

		expect((await storedRow(message.messageId))?.author_name).toBe("ありす");
	});

	it("サーバーで見えている名前を、人ごとに記録する。古いメッセージの名前では書き換えない", async () => {
		const { deps } = fakeDeps();
		const named = (name: string, createdAt: number) =>
			storedMessage({
				authorId: "7100",
				authorName: name,
				members: [
					{ id: "7100", name },
					// メンションされた人の名前も記録する
					{ id: "7200", name: "ぼぶ" },
				],
				createdAt,
			});

		await ingestMessages([named("新しい名前", CREATED_AT + 1000)], deps);
		await ingestMessages([named("古い名前", CREATED_AT)], deps);
		expect(await memberName("7100")).toBe("新しい名前");

		await ingestMessages([named("もっと新しい名前", CREATED_AT + 2000)], deps);
		expect(await memberName("7100")).toBe("もっと新しい名前");
		expect(await memberName("7200")).toBe("ぼぶ");
	});
});

describe("メッセージの削除", () => {
	it("D1とVectorizeから消す", async () => {
		const { deps, deleted } = fakeDeps();
		const message = storedMessage();

		await ingestMessages([message], deps);
		await deleteMessages([message.messageId], deps);

		expect(await storedRow(message.messageId)).toBeNull();
		expect(deleted).toEqual([message.messageId]);
	});

	it("削除が保存より先に処理されても、保存し直さない", async () => {
		const { deps, embedded } = fakeDeps();
		const message = storedMessage();

		await deleteMessages([message.messageId], deps);
		await ingestMessages([message], deps);

		expect(await storedRow(message.messageId)).toBeNull();
		expect(embedded).toEqual([]);
	});

	it("1日たった削除の記録は消す", async () => {
		const old = storedMessage();
		const now = Date.now();

		await deleteStoredMessages(env.DB, [old.messageId], now - 25 * 3600_000);
		await deleteStoredMessages(env.DB, [storedMessage().messageId], now);

		const remaining = await env.DB.prepare(
			"SELECT COUNT(*) AS count FROM deleted_messages WHERE message_id = ?",
		)
			.bind(old.messageId)
			.first<number>("count");
		expect(remaining).toBe(0);
	});
});

describe("Queueの仕事の振り分け", () => {
	type FakeMessage<T extends QueueMessage> = Message<T> & {
		ack: Mock;
		retry: Mock;
	};

	function queueMessage<T extends QueueMessage>(body: T): FakeMessage<T> {
		return {
			id: String(nextId++),
			timestamp: new Date(),
			body,
			attempts: 1,
			ack: vi.fn(),
			retry: vi.fn(),
		};
	}

	function handlers(overrides: Partial<JobHandlers> = {}): JobHandlers {
		return {
			channels: vi.fn(async () => {}),
			respond: vi.fn(async () => {}),
			explain: vi.fn(async () => {}),
			compact: vi.fn(async () => {}),
			importCommand: vi.fn(async () => {}),
			memory: vi.fn(async () => {}),
			ingest: vi.fn(async () => {}),
			delete: vi.fn(async () => {}),
			import: vi.fn(async () => {}),
			reindex: vi.fn(async () => {}),
			reaction: vi.fn(async () => {}),
			...overrides,
		};
	}

	it("チャンネルの記録は、保存より先に、受け取った順に反映する", async () => {
		const order: string[] = [];
		const later = queueMessage({
			kind: "channels",
			guildId: "4000",
			syncedAt: 2,
			deleted: ["b"],
		});
		const earlier = queueMessage({
			kind: "channels",
			guildId: "4000",
			syncedAt: 1,
			deleted: ["a"],
		});
		const ingest = queueMessage({ kind: "ingest", message: storedMessage() });

		await processBatch(
			[ingest, later, earlier],
			handlers({
				channels: vi.fn(async (job) => {
					order.push(job.deleted?.[0] ?? "");
				}),
				ingest: vi.fn(async () => {
					order.push("ingest");
				}),
			}),
		);

		expect(order).toEqual(["a", "b", "ingest"]);
	});

	it("リアクションの付け外しは、まとめて処理し、成功したら完了にする", async () => {
		const batches: number[] = [];
		const messages = ["8000", "8001"].map((messageId, index) =>
			queueMessage({
				kind: "reaction",
				action: "remove_all",
				guildId: "4000",
				channelId: "3000",
				messageId,
				at: index,
			}),
		);

		await processBatch(
			messages,
			handlers({
				reaction: async (jobs) => {
					batches.push(jobs.length);
				},
			}),
		);

		expect(batches).toEqual([2]);
		for (const message of messages) {
			expect(message.ack).toHaveBeenCalled();
		}
	});

	it("保存と削除は、種類ごとにまとめて処理し、成功したら完了にする", async () => {
		const first = storedMessage();
		const second = storedMessage();
		const messages = [
			queueMessage({ kind: "ingest", message: first }),
			queueMessage({
				kind: "delete",
				channelId: "3000",
				messageIds: ["8000"],
			}),
			queueMessage({ kind: "ingest", message: second }),
		];
		const jobs = handlers();

		await processBatch(messages, jobs);

		expect(jobs.ingest).toHaveBeenCalledTimes(1);
		expect(jobs.ingest).toHaveBeenCalledWith([first, second]);
		expect(jobs.delete).toHaveBeenCalledTimes(1);
		for (const message of messages) {
			expect(message.ack).toHaveBeenCalled();
			expect(message.retry).not.toHaveBeenCalled();
		}
	});

	it("まとめた処理が失敗したら1件ずつ処理し直し、失敗した仕事だけをやり直しに回す", async () => {
		const good = queueMessage({ kind: "ingest", message: storedMessage() });
		const bad = queueMessage({
			kind: "ingest",
			message: storedMessage({ content: "壊れた" }),
		});
		const jobs = handlers({
			ingest: vi.fn(async (messages: StoredMessageInput[]) => {
				if (messages.some((message) => message.content === "壊れた")) {
					throw new Error("broken");
				}
			}),
		});

		await processBatch([good, bad], jobs);

		expect(good.ack).toHaveBeenCalled();
		expect(good.retry).not.toHaveBeenCalled();
		expect(bad.retry).toHaveBeenCalled();
		expect(bad.ack).not.toHaveBeenCalled();
	});

	it("デプロイの前に入った、項目が足りない仕事も保存できる", async () => {
		const { deps } = fakeDeps();
		const current = storedMessage({
			attachments: [
				{
					filename: "cat.png",
					url: "https://cdn.example/cat.png",
					contentType: "image/png",
					size: 1234,
				},
			],
		});
		const old = {
			...current,
			mentions: undefined,
			members: undefined,
			attachments: current.attachments.map((attachment) => ({
				...attachment,
				filename: undefined,
			})),
		} as unknown as StoredMessageInput;
		const message = queueMessage({ kind: "ingest", message: old });

		await processBatch(
			[message],
			handlers({
				ingest: async (messages) => {
					await ingestMessages(messages, deps);
				},
			}),
		);

		expect(message.ack).toHaveBeenCalled();
		const row = await storedRow(old.messageId);
		expect(JSON.parse(row?.mentions as string)).toEqual([]);
		expect(JSON.parse(row?.attachments as string)).toEqual([
			{
				filename: "",
				url: "https://cdn.example/cat.png",
				contentType: "image/png",
				size: 1234,
			},
		]);
	});
});
