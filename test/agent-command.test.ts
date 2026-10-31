import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	getAgentChannel,
	getAgentResources,
	insertAgentChannel,
	markAgentChannelEnded,
} from "../src/agent/store";
import { agentSessionStub } from "../src/agent/stubs";
import {
	ALREADY_ENDED,
	COMPACT_UNAVAILABLE,
	createdMessage,
	DELETE_AGENTS_NOTE,
	END_CONFIRM,
	ENDED,
	KEY_MISSING,
	NO_MANAGE_CHANNELS,
	NOT_AGENT_CHANNEL,
	OWNER_ONLY_BUTTON,
	OWNER_ONLY_END,
	tooManySessions,
} from "../src/agent/texts";
import {
	ApplicationCommandType,
	InteractionResponseType,
	InteractionType,
	MessageFlags,
	PermissionFlags,
} from "../src/discord/constants";
import { resolveSharedChannels } from "../src/queue/channels";
import {
	findSharedChannelsByName,
	replaceGuildRoles,
	saveBotRoles,
	saveChannels,
	sharedChannelsOf,
} from "../src/store/channels";
import { addSkill } from "../src/store/skills";
import { BOT, discordMessage } from "./fixtures";
import {
	type FetchCall,
	fakeIngestDeps,
	guildInteraction,
	mockFetch,
	sendInteraction,
	testGuildRoles,
	userFactory,
} from "./helpers";

const newUser = userFactory(61000);
const GUILD_ID = "900";

/** /agent に必要な権限(チャンネルの管理と、埋め込みリンク) */
const AGENT_PERMISSIONS = String(
	PermissionFlags.ManageChannels | PermissionFlags.EmbedLinks,
);

afterEach(() => {
	vi.restoreAllMocks();
});

function agentCommand(
	user: Awaited<ReturnType<typeof newUser>>,
	permissions = AGENT_PERMISSIONS,
) {
	return {
		...guildInteraction(
			InteractionType.ApplicationCommand,
			{ id: "61", name: "agent", type: ApplicationCommandType.ChatInput },
			user,
		),
		app_permissions: permissions,
	};
}

function inChannel(
	payload: ReturnType<typeof guildInteraction>,
	channelId: string,
) {
	return {
		...payload,
		channel_id: channelId,
		channel: { id: channelId, type: 0 },
	};
}

/** 偽物のDiscordが作るチャンネルのID。テストの間で重ならないよう、ファイルの中で数え続ける */
let channelNumber = 7000;

/** Managed AgentsとDiscordのAPIに応える偽物 */
function mockAgentApis(
	overrides: (call: FetchCall) => Response | null = () => null,
) {
	return mockFetch((call) => {
		const overridden = overrides(call);
		if (overridden !== null) {
			return overridden;
		}
		const path = call.url.pathname;
		if (call.url.hostname === "api.anthropic.com") {
			if (call.method === "POST" && path === "/v1/agents") {
				return Response.json({ id: "agent_1", version: 1, type: "agent" });
			}
			if (call.method === "POST" && path === "/v1/environments") {
				return Response.json({ id: "env_1", type: "environment" });
			}
			if (call.method === "POST" && path === "/v1/sessions") {
				return Response.json({ id: "sesn_1", type: "session", status: "idle" });
			}
			if (call.method === "GET" && path.startsWith("/v1/sessions/")) {
				return Response.json({ id: "sesn_1", type: "session", status: "idle" });
			}
			if (call.method === "DELETE" && path.startsWith("/v1/sessions/")) {
				return Response.json({ id: "sesn_1", type: "session_deleted" });
			}
		}
		if (
			call.method === "POST" &&
			path === `/api/v10/guilds/${GUILD_ID}/channels`
		) {
			channelNumber++;
			return Response.json({ id: String(channelNumber), type: 0 });
		}
		if (call.method === "POST" && /\/channels\/\d+\/messages$/.test(path)) {
			return Response.json(discordMessage("m1", BOT, ""));
		}
		if (call.method === "PUT" && path.includes("/messages/pins/")) {
			return new Response(null, { status: 204 });
		}
		if (call.method === "PATCH" || call.method === "DELETE") {
			return Response.json(discordMessage("m2", BOT, ""));
		}
		return new Response(null, { status: 404 });
	});
}

/** セッションを始めたリクエストの、エージェントの設定 */
function sessionAgent(calls: FetchCall[]): {
	system: string;
	tools: { name?: string; input_schema?: unknown }[];
} {
	const call = calls.find(
		(entry) => entry.method === "POST" && entry.url.pathname === "/v1/sessions",
	);
	if (call === undefined) {
		throw new Error("The session was not created");
	}
	return (
		call.body as {
			agent: {
				system: string;
				tools: { name?: string; input_schema?: unknown }[];
			};
		}
	).agent;
}

/** 編集した、保留の応答の本文 */
function editedContent(calls: FetchCall[]): string | undefined {
	const edit = calls.find(
		(call) =>
			call.method === "PATCH" && call.url.pathname.includes("/webhooks/"),
	);
	return (edit?.body as { content?: string } | undefined)?.content;
}

async function seedChannel(
	channelId: string,
	ownerId: string,
	sessionId: string | null = "sesn_1",
) {
	await insertAgentChannel(env.DB, {
		channelId,
		guildId: GUILD_ID,
		ownerId,
		number: 1,
		sessionId: "sesn_1",
		createdAt: Date.now(),
	});
	if (sessionId === null) {
		await markAgentChannelEnded(env.DB, channelId);
	}
}

describe("/agent", () => {
	it("Anthropicのキーがなければ、登録を案内する(OpenRouterだけの人も)", async () => {
		const user = await newUser("openrouter");
		const calls = mockAgentApis();

		await sendInteraction(agentCommand(user));

		expect(editedContent(calls)).toBe(KEY_MISSING);
	});

	it("Bobertに「チャンネルの管理」の権限がなければ、チャンネルを作らずに知らせる", async () => {
		const user = await newUser("anthropic");
		const calls = mockAgentApis();

		await sendInteraction(agentCommand(user, "0"));

		expect(editedContent(calls)).toBe(NO_MANAGE_CHANNELS);
		expect(
			calls.some((call) => call.url.hostname === "api.anthropic.com"),
		).toBe(false);
	});

	it("終えていないセッションが3つあれば、そのチャンネルを挙げて知らせる", async () => {
		const user = await newUser("anthropic");
		for (const channelId of ["61101", "61102", "61103"]) {
			await seedChannel(channelId, user.id);
		}
		const calls = mockAgentApis();

		await sendInteraction(agentCommand(user));

		expect(editedContent(calls)).toBe(
			tooManySessions(["61101", "61102", "61103"]),
		);
	});

	it("チャンネルを作り、セッションを始め、最初のメッセージを出す", async () => {
		const user = await newUser("anthropic");
		const calls = mockAgentApis();

		const response = await sendInteraction(agentCommand(user));

		expect(response.type).toBe(
			InteractionResponseType.DeferredChannelMessageWithSource,
		);
		expect(response.data.flags).toBe(MessageFlags.Ephemeral);
		const channelCall = calls.find((call) =>
			call.url.pathname.endsWith("/channels"),
		);
		const channelId = "7001";
		expect(channelCall?.body).toMatchObject({
			name: "agent-alice-1",
			type: 0,
			permission_overwrites: [
				{ id: GUILD_ID, type: 0, deny: String(PermissionFlags.ViewChannel) },
				{ id: user.id, type: 1 },
				{ id: BOT.id, type: 1 },
			],
		});
		const sessionCall = calls.find(
			(call) => call.method === "POST" && call.url.pathname === "/v1/sessions",
		);
		expect(sessionCall?.body).toMatchObject({
			agent: {
				type: "agent_with_overrides",
				id: "agent_1",
				model: { id: "claude-haiku-5-5", effort: "low" },
				tools: [
					{
						type: "agent_toolset_20260401",
						default_config: {
							enabled: true,
							permission_policy: { type: "auto" },
						},
					},
					{ type: "custom", name: "send_files" },
				],
				skills: [
					{ type: "anthropic", skill_id: "xlsx" },
					{ type: "anthropic", skill_id: "docx" },
					{ type: "anthropic", skill_id: "pptx" },
					{ type: "anthropic", skill_id: "pdf" },
				],
			},
			environment_id: "env_1",
			title: "#agent-alice-1",
		});
		// スキルのないサーバーでは、スキルの一覧も、スキルを読む道具も渡さない
		expect(sessionAgent(calls).system).not.toContain("スキル");
		const first = calls.find(
			(call) =>
				call.method === "POST" &&
				call.url.pathname === `/api/v10/channels/${channelId}/messages`,
		)?.body as {
			content: string;
			embeds: { title: string; description: string }[];
			components: { components: { custom_id: string }[] }[];
		};
		expect(first.content).toContain(`<@${user.id}> さん専用の`);
		expect(first.embeds[0]?.description).toContain(
			"モデル: Claude Haiku 5.5\n思考の深さ: low",
		);
		expect(first.components[0]?.components[0]?.custom_id).toBe("agent:end");
		expect(
			calls.some(
				(call) =>
					call.method === "PUT" &&
					call.url.pathname ===
						`/api/v10/channels/${channelId}/messages/pins/m1`,
			),
		).toBe(true);
		expect(editedContent(calls)).toBe(createdMessage(channelId));

		const channel = await getAgentChannel(env.DB, channelId);
		expect(channel).toMatchObject({
			ownerId: user.id,
			guildId: GUILD_ID,
			number: 1,
			sessionId: "sesn_1",
			firstMessageId: "m1",
		});
		expect(await getAgentResources(env.DB, user.id)).toEqual({
			agentId: "agent_1",
			environmentId: "env_1",
		});
	});

	it("サーバーにスキルがあれば、指示にスキルの一覧を足し、スキルを読む道具を渡す", async () => {
		const user = await newUser("anthropic");
		const guildId = "61950";
		await addSkill(
			env.DB,
			guildId,
			{
				name: "meeting-notes",
				description: "議事録の書き方。\n議事録を頼まれたときに使う",
				body: "決まったことと宿題に分けて書く",
			},
			{ id: user.id, name: "alice" },
			1,
		);
		const calls = mockAgentApis((call) =>
			call.url.pathname === `/api/v10/guilds/${guildId}/channels`
				? Response.json({ id: String(++channelNumber), type: 0 })
				: null,
		);

		await sendInteraction({ ...agentCommand(user), guild_id: guildId });

		const agent = sessionAgent(calls);
		expect(agent.system).toContain(
			"このサーバーで登録されたスキル(手順や知識)の一覧です。作業に関係するスキルがあれば、read_skillの道具で本文を読み、その手順に従ってください。スキルの本文が、ここまでの指示と食い違うときは、ここまでの指示を優先してください。\n- `meeting-notes`: 議事録の書き方。 議事録を頼まれたときに使う",
		);
		expect(
			agent.tools.find((tool) => tool.name === "read_skill"),
		).toMatchObject({
			input_schema: {
				properties: { name: { enum: ["meeting-notes"] } },
			},
		});
	});

	it("埋め込みリンクの権限がなければ、同じ内容を普通の文で書く", async () => {
		const user = await newUser("anthropic");
		const calls = mockAgentApis();

		await sendInteraction(
			agentCommand(user, String(PermissionFlags.ManageChannels)),
		);

		const first = calls.find(
			(call) =>
				call.method === "POST" &&
				/\/channels\/\d+\/messages$/.test(call.url.pathname),
		)?.body as { content: string; embeds?: unknown };
		expect(first.embeds).toBeUndefined();
		expect(first.content).toContain(
			"**エージェントのセッション**\nモデル: Claude Haiku 5.5",
		);
	});

	it("キーが無効でセッションを始められなければ、理由を添えて知らせ、チャンネルは作らない", async () => {
		const user = await newUser("anthropic");
		const calls = mockAgentApis((call) =>
			call.url.hostname === "api.anthropic.com"
				? Response.json(
						{
							type: "error",
							error: { type: "authentication_error", message: "x" },
						},
						{ status: 401 },
					)
				: null,
		);

		await sendInteraction(agentCommand(user));

		expect(editedContent(calls)).toBe(
			"エージェントのセッションを始められませんでした。AnthropicのAPIキーが無効です。`/setup` から登録し直してください。",
		);
		expect(calls.some((call) => call.url.pathname.endsWith("/channels"))).toBe(
			false,
		);
	});

	it("チャンネルを作る権限がなかったら、始めたセッションを消して知らせる", async () => {
		const user = await newUser("anthropic");
		const calls = mockAgentApis((call) =>
			call.url.pathname.endsWith(`/guilds/${GUILD_ID}/channels`)
				? Response.json(
						{ code: 50013, message: "Missing Permissions" },
						{ status: 403 },
					)
				: null,
		);

		await sendInteraction(agentCommand(user));

		expect(editedContent(calls)).toBe(NO_MANAGE_CHANNELS);
		expect(
			calls.some(
				(call) =>
					call.method === "DELETE" &&
					call.url.pathname === "/v1/sessions/sesn_1",
			),
		).toBe(true);
	});
});

describe("/endagent", () => {
	function endagent(
		user: Awaited<ReturnType<typeof newUser>>,
		channelId: string,
	) {
		return inChannel(
			guildInteraction(
				InteractionType.ApplicationCommand,
				{ id: "62", name: "endagent", type: ApplicationCommandType.ChatInput },
				user,
			),
			channelId,
		);
	}

	it("エージェントのチャンネルの外では、中で使うよう知らせる", async () => {
		const user = await newUser("anthropic");

		const response = await sendInteraction(endagent(user, "61200"));

		expect(response.data.content).toBe(NOT_AGENT_CHANNEL);
		expect(response.data.flags).toBe(MessageFlags.Ephemeral);
	});

	it("本人以外は終えられない", async () => {
		const owner = await newUser("anthropic");
		const other = await newUser("anthropic");
		await seedChannel("61201", owner.id);

		const response = await sendInteraction(endagent(other, "61201"));

		expect(response.data.content).toBe(OWNER_ONLY_END);
	});

	it("終えたあとは、もう終わっていると知らせる", async () => {
		const owner = await newUser("anthropic");
		await seedChannel("61202", owner.id, null);

		const response = await sendInteraction(endagent(owner, "61202"));

		expect(response.data.content).toBe(ALREADY_ENDED);
	});

	it("本人には、終える確認を出す", async () => {
		const owner = await newUser("anthropic");
		await seedChannel("61203", owner.id);

		const response = await sendInteraction(endagent(owner, "61203"));

		expect(response.data.content).toBe(END_CONFIRM);
		expect(response.data.components[0].components[0]).toMatchObject({
			custom_id: "agent:end_confirm",
			label: "終える",
		});
	});
});

describe("エージェントのボタン", () => {
	function button(
		user: Awaited<ReturnType<typeof newUser>>,
		channelId: string,
		customId: string,
	) {
		return inChannel(
			guildInteraction(
				InteractionType.MessageComponent,
				{ custom_id: customId, component_type: 2 },
				user,
			),
			channelId,
		);
	}

	it("本人以外が押したら、押した人にだけ知らせる", async () => {
		const owner = await newUser("anthropic");
		const other = await newUser("anthropic");
		await seedChannel("61301", owner.id);

		const response = await sendInteraction(
			button(other, "61301", "agent:stop"),
		);

		expect(response.data.content).toBe(OWNER_ONLY_BUTTON);
		expect(response.data.flags).toBe(MessageFlags.Ephemeral);
	});

	it("「セッションを終える」で、確認を出す", async () => {
		const owner = await newUser("anthropic");
		await seedChannel("61302", owner.id);

		const response = await sendInteraction(button(owner, "61302", "agent:end"));

		expect(response.data.content).toBe(END_CONFIRM);
	});

	it("終える確認のボタンで、セッションを消し、チャンネルは残して、削除ボタン付きで知らせる", async () => {
		const owner = await newUser("anthropic");
		const channelId = "61304";
		await seedChannel(channelId, owner.id);
		await agentSessionStub(env, channelId).setup({
			channelId,
			guildId: GUILD_ID,
			ownerId: owner.id,
			sessionId: "sesn_1",
			model: { id: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
		});
		const calls = mockAgentApis();

		const response = await sendInteraction(
			button(owner, channelId, "agent:end_confirm"),
		);

		expect(response.type).toBe(InteractionResponseType.DeferredMessageUpdate);
		expect(
			calls.some(
				(call) =>
					call.method === "DELETE" &&
					call.url.pathname === "/v1/sessions/sesn_1",
			),
		).toBe(true);
		const notice = calls.find(
			(call) =>
				call.method === "POST" &&
				call.url.pathname === `/api/v10/channels/${channelId}/messages`,
		)?.body as {
			content: string;
			components: { components: { custom_id: string }[] }[];
		};
		expect(notice.content).toBe(ENDED);
		expect(notice.components[0]?.components[0]?.custom_id).toBe("agent:delete");
		expect(editedContent(calls)).toBe(ENDED);
		expect((await getAgentChannel(env.DB, channelId))?.sessionId).toBeNull();
	});

	it("「チャンネルを削除」で、削除の確認を出す", async () => {
		const owner = await newUser("anthropic");
		await seedChannel("61303", owner.id, null);

		const response = await sendInteraction(
			button(owner, "61303", "agent:delete"),
		);

		expect(response.data.content).toBe("このチャンネルを削除しますか?");
		expect(response.data.components[0].components[0]).toMatchObject({
			custom_id: "agent:delete_confirm",
			label: "削除する",
		});
	});
});

describe("ほかの機能との関係", () => {
	it("エージェントのチャンネルでは、「会話を要約」を使えない", async () => {
		const owner = await newUser("anthropic");
		await seedChannel("61401", owner.id);
		const target = discordMessage("61499", owner, "要約して", {
			channel_id: "61401",
		});

		const response = await sendInteraction(
			inChannel(
				guildInteraction(
					InteractionType.ApplicationCommand,
					{
						id: "63",
						name: "会話を要約",
						type: ApplicationCommandType.Message,
						target_id: target.id,
						resolved: { messages: { [target.id]: target } },
					},
					owner,
				),
				"61401",
			),
		);

		expect(response.data.content).toBe(COMPACT_UNAVAILABLE);
		expect(response.data.flags).toBe(MessageFlags.Ephemeral);
	});

	it("/delete の確認で、エージェントのチャンネルとセッションも消すことを書く", async () => {
		const owner = await newUser("anthropic");
		await seedChannel("61402", owner.id);

		const response = await sendInteraction(
			guildInteraction(
				InteractionType.ApplicationCommand,
				{ id: "64", name: "delete", type: ApplicationCommandType.ChatInput },
				owner,
			),
		);

		expect(response.data.content).toBe(
			`登録したAPIキー(AnthropicとOpenRouter)と設定を、すべて削除します。${DELETE_AGENTS_NOTE}よろしいですか?`,
		);
	});

	it("エージェントのチャンネルは、共有の印があっても、保存の対象にも、チャンネルの一覧にも入れない", async () => {
		const owner = await newUser("anthropic");
		const guildId = "61900";
		const roles = testGuildRoles(guildId);
		await replaceGuildRoles(env.DB, guildId, roles.roles, 1);
		await saveBotRoles(env.DB, guildId, roles.botRoleIds, 1);
		await saveChannels(
			env.DB,
			[
				{
					channelId: "61901",
					guildId,
					parentId: null,
					name: "agent-alice-1",
					type: 0,
					nsfw: false,
					overwrites: [],
				},
				{
					channelId: "61902",
					guildId,
					parentId: null,
					name: "general",
					type: 0,
					nsfw: false,
					overwrites: [],
				},
			],
			1,
		);
		// チャンネルを作った通知で、先に共有の印が付いた状態にする
		await env.DB.prepare("UPDATE channels SET shared = 1 WHERE guild_id = ?")
			.bind(guildId)
			.run();
		await insertAgentChannel(env.DB, {
			channelId: "61901",
			guildId,
			ownerId: owner.id,
			number: 1,
			sessionId: "sesn_1",
			createdAt: 1,
		});
		// 記録した後に、共有の印を付け直された場合も除く
		await env.DB.prepare("UPDATE channels SET shared = 1 WHERE guild_id = ?")
			.bind(guildId)
			.run();

		const shared = await resolveSharedChannels(
			[
				{ channelId: "61901", guildId },
				{ channelId: "61902", guildId },
			],
			fakeIngestDeps(BOT.id).deps,
		);
		expect([...shared]).toEqual(["61902"]);
		expect(
			(await sharedChannelsOf(env.DB, guildId)).map(
				(record) => record.channelId,
			),
		).toEqual(["61902"]);
		expect(
			await findSharedChannelsByName(env.DB, guildId, "agent-alice-1"),
		).toEqual([]);
	});
});
