import { env } from "cloudflare:workers";
import Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sessionConfig, startSession } from "../src/agent/managed";
import {
	isValidSecretName,
	parseSecretUrl,
	vaultForSession,
} from "../src/agent/secrets";
import { getAgentVault, saveAgentVault } from "../src/agent/store";
import {
	ButtonStyle,
	ComponentType,
	InteractionResponseType,
	InteractionType,
	MessageFlags,
} from "../src/discord/constants";
import { COMMANDS } from "../src/interactions/commands";
import { DELETE_CONFIRM_ID } from "../src/interactions/delete";
import {
	type FetchCall,
	guildInteraction,
	mockFetch,
	sendInteraction,
	userFactory,
} from "./helpers";

const newUser = userFactory(64000);
type User = Awaited<ReturnType<typeof newUser>>;

afterEach(() => {
	vi.restoreAllMocks();
});

const NOTE =
	"-# 値はAnthropicに預け、Bobertにもエージェントのサンドボックスにも残しません。同じAnthropicのワークスペースの開発者は、この秘密を自分のセッションで使えます(値は見られません)。";
const KEY_MISSING =
	"秘密を登録するには、AnthropicのAPIキーの登録が必要です(OpenRouterでは使えません)。`/setup` から登録してください。";

interface FakeCredential {
	id: string;
	type: "vault_credential";
	archived_at: string | null;
	metadata: Record<string, string>;
	auth: {
		type: "environment_variable";
		secret_name: string;
		networking: { type: "limited"; allowed_hosts: string[] };
		injection_location: { header: boolean; body: boolean };
	};
}

/** Managed Agentsのvaultと、Discordの偽物。vaultの中身は、テストの間だけ覚えておく */
function mockVaultApis(options: { missingVault?: string } = {}) {
	const vaults = new Map<string, FakeCredential[]>();
	let next = 1;
	const calls = mockFetch((call) => {
		if (call.url.hostname !== "api.anthropic.com") {
			return Response.json({});
		}
		const path = call.url.pathname;
		if (call.method === "POST" && path === "/v1/vaults") {
			const id = `vlt_${next++}`;
			vaults.set(id, []);
			return Response.json({ id, type: "vault" });
		}
		const match =
			/^\/v1\/vaults\/([^/]+)(?:\/credentials(?:\/([^/]+))?)?$/.exec(path);
		const vaultId = match?.[1] ?? "";
		const credentials = vaults.get(vaultId);
		if (
			match === null ||
			credentials === undefined ||
			vaultId === options.missingVault
		) {
			return Response.json(
				{ type: "error", error: { type: "not_found_error", message: "x" } },
				{ status: 404 },
			);
		}
		const credentialId = match[2];
		if (call.method === "GET" && path.endsWith("/credentials")) {
			return Response.json({ data: credentials, next_page: null });
		}
		if (call.method === "POST" && path.endsWith("/credentials")) {
			const body = call.body as {
				metadata: Record<string, string>;
				auth: FakeCredential["auth"] & { secret_value: string };
			};
			const { secret_value: _value, ...auth } = body.auth;
			const credential: FakeCredential = {
				id: `vcrd_${next++}`,
				type: "vault_credential",
				archived_at: null,
				metadata: body.metadata,
				auth: { ...auth, injection_location: { header: true, body: false } },
			};
			credentials.push(credential);
			return Response.json(credential);
		}
		if (call.method === "DELETE" && credentialId !== undefined) {
			vaults.set(
				vaultId,
				credentials.filter((item) => item.id !== credentialId),
			);
			return Response.json({
				id: credentialId,
				type: "vault_credential_deleted",
			});
		}
		if (call.method === "DELETE") {
			vaults.delete(vaultId);
			return Response.json({ id: vaultId, type: "vault_deleted" });
		}
		return new Response(null, { status: 404 });
	});
	return { calls, vaults };
}

function command(user: User) {
	return guildInteraction(
		InteractionType.ApplicationCommand,
		{ id: "64", name: "agentsecrets", type: 1 },
		user,
	);
}

function press(user: User, customId: string, values?: string[]) {
	return guildInteraction(
		InteractionType.MessageComponent,
		values === undefined
			? { custom_id: customId, component_type: ComponentType.Button }
			: {
					custom_id: customId,
					component_type: ComponentType.StringSelect,
					values,
				},
		user,
	);
}

function submit(user: User, customId: string, fields: Record<string, string>) {
	return guildInteraction(
		InteractionType.ModalSubmit,
		{
			custom_id: customId,
			components: Object.entries(fields).map(([id, value]) => ({
				type: ComponentType.Label,
				component: { type: ComponentType.TextInput, custom_id: id, value },
			})),
		},
		user,
	);
}

/** 保留にした応答の書き換え(PATCH @original)の本文 */
function edits(calls: FetchCall[]) {
	return calls
		.filter(
			(call) =>
				call.method === "PATCH" &&
				call.url.pathname.endsWith("/interaction-token/messages/@original"),
		)
		.map((call) => call.body as { content: string; components?: unknown[] });
}

function credentialRequests(calls: FetchCall[]) {
	return calls.filter(
		(call) =>
			call.method === "POST" && call.url.pathname.endsWith("/credentials"),
	);
}

describe("/agentsecrets", () => {
	it("コマンドの一覧に出る", () => {
		expect(COMMANDS).toContainEqual(
			expect.objectContaining({
				name: "agentsecrets",
				description:
					"エージェントに渡す秘密(ログインの情報やAPIキー)の登録と一覧",
			}),
		);
	});

	it("Anthropicのキーがなければ、登録を案内する(OpenRouterだけの人も)", async () => {
		const user = await newUser("openrouter");
		const { calls } = mockVaultApis();

		expect(await sendInteraction(command(user))).toEqual({
			type: InteractionResponseType.ChannelMessageWithSource,
			data: { flags: MessageFlags.Ephemeral, content: KEY_MISSING },
		});
		expect(calls).toHaveLength(0);
	});

	it("秘密がなければ「なし」と注意を書き、追加のボタンだけを付ける(vaultは作らない)", async () => {
		const user = await newUser("anthropic");
		const { calls } = mockVaultApis();

		const response = await sendInteraction(command(user));

		expect(response.type).toBe(
			InteractionResponseType.DeferredChannelMessageWithSource,
		);
		expect(edits(calls)).toEqual([
			{
				content: `**エージェントに渡す秘密**: なし\n${NOTE}`,
				components: [
					{
						type: ComponentType.ActionRow,
						components: [
							{
								type: ComponentType.Button,
								style: ButtonStyle.Primary,
								custom_id: "agentsecrets:add",
								label: "追加",
							},
						],
					},
				],
			},
		]);
		expect(await getAgentVault(env.DB, user.id)).toBe(null);
	});

	it("「追加」を押すと、名前・値・送り先の入力画面を開く(Basic認証の入力画面はない)", async () => {
		const user = await newUser("anthropic");

		const add = await sendInteraction(press(user, "agentsecrets:add"));

		expect(add.type).toBe(InteractionResponseType.Modal);
		expect(add.data.title).toBe("秘密を追加する");
		expect(
			add.data.components.map((field: { label: string }) => field.label),
		).toEqual(["名前", "値", "送り先"]);
	});

	it("追加すると、vaultを作って、送り先のホストのヘッダーにだけ差し替わる秘密として預け、一覧に出す", async () => {
		const user = await newUser("anthropic");
		const { calls } = mockVaultApis();

		await sendInteraction(
			submit(user, "agentsecrets:add-modal", {
				name: "weather_api_key",
				value: "sk-weather",
				url: "https://api.example.com/v1",
			}),
		);
		await sendInteraction(command(user));

		expect(credentialRequests(calls)[0]?.body).toEqual({
			display_name: "WEATHER_API_KEY",
			metadata: { url: "https://api.example.com" },
			auth: {
				type: "environment_variable",
				secret_name: "WEATHER_API_KEY",
				secret_value: "sk-weather",
				networking: { type: "limited", allowed_hosts: ["api.example.com"] },
				injection_location: { header: true },
			},
		});
		expect(await getAgentVault(env.DB, user.id)).toBe("vlt_1");
		const [added, listed] = edits(calls);
		expect(added?.content).toBe(
			"秘密「WEATHER_API_KEY」を追加しました。次に始めるエージェントのセッションから使えます。",
		);
		expect(listed?.content).toBe(
			`**エージェントに渡す秘密**\n- \`WEATHER_API_KEY\`: https://api.example.com に送るときだけ使う\n${NOTE}`,
		);
		expect(listed?.components?.[1]).toEqual({
			type: ComponentType.ActionRow,
			components: [
				{
					type: ComponentType.StringSelect,
					custom_id: "agentsecrets:select",
					placeholder: "削除する秘密を選ぶ",
					options: [
						{
							label: "WEATHER_API_KEY",
							value: "vcrd_2:WEATHER_API_KEY",
							description: "https://api.example.com",
						},
					],
				},
			],
		});
	});

	it("同じ名前と、20個を超える秘密は預けない", async () => {
		const user = await newUser("anthropic");
		const { calls, vaults } = mockVaultApis();
		const add = (name: string) =>
			sendInteraction(
				submit(user, "agentsecrets:add-modal", {
					name,
					value: "x",
					url: "https://api.example.com",
				}),
			);

		await add("FIRST");
		await add("FIRST");
		for (let index = 1; index < 20; index++) {
			await add(`S${index}`);
		}
		await add("OVER");

		expect(edits(calls)[1]?.content).toBe(
			"「FIRST」という名前の秘密は、すでにあります。置き換えるときは、削除してから追加してください。",
		);
		expect(edits(calls).at(-1)?.content).toBe(
			"秘密は20個までです。使っていない秘密を削除してから追加してください。",
		);
		expect(vaults.get("vlt_1")).toHaveLength(20);
	});

	it("名前と送り先の形が違えば、預けずに理由を見せる", async () => {
		const user = await newUser("anthropic");
		const { calls } = mockVaultApis();

		const badName = await sendInteraction(
			submit(user, "agentsecrets:add-modal", {
				name: "1KEY",
				value: "x",
				url: "https://api.example.com",
			}),
		);
		const badUrl = await sendInteraction(
			submit(user, "agentsecrets:add-modal", {
				name: "KEY",
				value: "x",
				url: "http://api.example.com",
			}),
		);

		expect(badName.data.content).toBe(
			"名前は、英大文字、数字、_ だけで、先頭は英大文字にしてください。例: `WEATHER_API_KEY`",
		);
		expect(badUrl.data.content).toBe(
			"送り先は、https:// で始まるURLにしてください。",
		);
		expect(
			calls.some((call) => call.url.hostname === "api.anthropic.com"),
		).toBe(false);
	});

	it("記録したvaultが見つからなければ(ワークスペースを替えたなど)、作り直して預ける", async () => {
		const user = await newUser("anthropic");
		await saveAgentVault(env.DB, user.id, "vlt_gone");
		const { calls } = mockVaultApis();

		await sendInteraction(
			submit(user, "agentsecrets:add-modal", {
				name: "KEY",
				value: "x",
				url: "https://api.example.com",
			}),
		);

		expect(await getAgentVault(env.DB, user.id)).toBe("vlt_1");
		expect(edits(calls)[0]?.content).toContain("秘密「KEY」を追加しました。");
	});

	it("選ぶと削除を確かめ、「削除する」で消す", async () => {
		const user = await newUser("anthropic");
		const { calls, vaults } = mockVaultApis();
		await sendInteraction(
			submit(user, "agentsecrets:add-modal", {
				name: "KEY",
				value: "x",
				url: "https://api.example.com",
			}),
		);

		const question = await sendInteraction(
			press(user, "agentsecrets:select", ["vcrd_2:KEY"]),
		);
		const deleted = await sendInteraction(
			press(user, "agentsecrets:delete:vcrd_2:KEY"),
		);

		expect(question.data).toEqual({
			flags: MessageFlags.Ephemeral,
			content: "秘密「KEY」を削除します。よろしいですか?",
			components: [
				{
					type: ComponentType.ActionRow,
					components: [
						{
							type: ComponentType.Button,
							style: ButtonStyle.Danger,
							custom_id: "agentsecrets:delete:vcrd_2:KEY",
							label: "削除する",
						},
					],
				},
			],
		});
		expect(deleted.type).toBe(InteractionResponseType.DeferredMessageUpdate);
		expect(edits(calls).at(-1)).toEqual({
			content: "秘密「KEY」を削除しました。",
			components: [],
		});
		expect(vaults.get("vlt_1")).toEqual([]);
	});

	it("Anthropicとのやり取りに失敗したら、/agent と同じ理由の文を添えて知らせる", async () => {
		const user = await newUser("anthropic");
		const calls = mockFetch((call) =>
			call.url.hostname === "api.anthropic.com"
				? Response.json(
						{
							type: "error",
							error: { type: "authentication_error", message: "x" },
						},
						{ status: 401 },
					)
				: Response.json({}),
		);

		await sendInteraction(
			submit(user, "agentsecrets:add-modal", {
				name: "KEY",
				value: "x",
				url: "https://api.example.com",
			}),
		);

		expect(edits(calls)[0]?.content).toMatch(/^秘密を保存できませんでした。.+/);
	});
});

describe("秘密の決まり", () => {
	it("名前は英大文字、数字、_ で、先頭は英大文字(40文字まで)", () => {
		expect(isValidSecretName("WEATHER_API_KEY")).toBe(true);
		expect(isValidSecretName("A1")).toBe(true);
		for (const name of ["", "_A", "1A", "a", "A-B", "A".repeat(41)]) {
			expect(isValidSecretName(name)).toBe(false);
		}
	});

	it("送り先は、ポートのないhttpsのURL。頭(https://ホスト)とホストを返す", () => {
		expect(parseSecretUrl(" https://api.example.com/path?q=1 ")).toEqual({
			url: "https://api.example.com",
			host: "api.example.com",
		});
		for (const url of [
			"http://a.example.com",
			"https://a.example.com:8443",
			"admin",
		]) {
			expect(parseSecretUrl(url)).toBe(null);
		}
	});
});

describe("セッションに渡す", () => {
	it("秘密があれば、共通の指示の後ろに、名前と送り先を書き足す(値は書かない)", () => {
		const { system } = sessionConfig([], null, [
			{
				id: "vcrd_1",
				name: "WEATHER_API_KEY",
				url: "https://api.example.com",
			},
		]);

		expect(system).toContain(
			"\n\n次の環境変数に、利用者が登録した秘密が入っています。値はダミーの文字列で、書かれたホストへ送るリクエストのヘッダーに入れたときだけ、本物に差し替わります。値を表示したり、ほかの場所へ送ったりしないでください。\n- `WEATHER_API_KEY`: https://api.example.com",
		);
		expect(sessionConfig([], null, []).system).not.toContain("秘密");
	});
});

describe("セッションと /delete", () => {
	it("秘密があれば、セッションを作るときにvaultをつなぎ、指示に名前と送り先を書く", async () => {
		const user = await newUser("anthropic");
		const { calls } = mockVaultApis();
		await sendInteraction(
			submit(user, "agentsecrets:add-modal", {
				name: "WEATHER_API_KEY",
				value: "sk-weather",
				url: "https://api.example.com",
			}),
		);
		const client = new Anthropic({ apiKey: "key-anthropic" });
		mockFetch((call) => {
			const path = call.url.pathname;
			if (path === "/v1/agents") {
				return Response.json({ id: "agent_1", type: "agent" });
			}
			if (path === "/v1/environments") {
				return Response.json({ id: "env_1", type: "environment" });
			}
			if (path === "/v1/sessions") {
				return Response.json({ id: "sesn_1", type: "session", resources: [] });
			}
			if (path.startsWith("/v1/vaults/")) {
				return Response.json({
					data: [
						{
							id: "vcrd_2",
							type: "vault_credential",
							archived_at: null,
							metadata: { url: "https://api.example.com" },
							auth: {
								type: "environment_variable",
								secret_name: "WEATHER_API_KEY",
								networking: {
									type: "limited",
									allowed_hosts: ["api.example.com"],
								},
								injection_location: { header: true, body: false },
							},
						},
					],
					next_page: null,
				});
			}
			return new Response(null, { status: 404 });
		});
		expect(credentialRequests(calls)).toHaveLength(1);

		const vault = await vaultForSession(env.DB, user.id, client);
		const sessionCalls = mockFetch((call) =>
			call.url.pathname === "/v1/sessions"
				? Response.json({ id: "sesn_1", type: "session", resources: [] })
				: Response.json({ id: "x", type: "agent" }),
		);
		await startSession(env.DB, user.id, client, {
			model: { id: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
			effort: "low",
			title: "#agent-alice-1",
			skills: [],
			repository: null,
			vault,
		});

		const body = sessionCalls.find(
			(call) => call.url.pathname === "/v1/sessions",
		)?.body as { vault_ids: string[]; agent: { system: string } };
		expect(body.vault_ids).toEqual(["vlt_1"]);
		expect(body.agent.system).toContain(
			"- `WEATHER_API_KEY`: https://api.example.com",
		);
		expect(JSON.stringify(body)).not.toContain("sk-weather");
	});

	it("秘密がなければ、vaultをつながない", async () => {
		const user = await newUser("anthropic");
		mockVaultApis();
		await saveAgentVault(env.DB, user.id, "vlt_empty");

		expect(
			await vaultForSession(
				env.DB,
				user.id,
				new Anthropic({ apiKey: "key-anthropic" }),
			),
		).toBe(null);
	});

	it("/delete で、vaultごと消し、記録も消す", async () => {
		const user = await newUser("anthropic");
		const { calls } = mockVaultApis();
		await sendInteraction(
			submit(user, "agentsecrets:add-modal", {
				name: "KEY",
				value: "x",
				url: "https://api.example.com",
			}),
		);

		await sendInteraction(
			guildInteraction(
				InteractionType.MessageComponent,
				{ custom_id: DELETE_CONFIRM_ID, component_type: ComponentType.Button },
				user,
			),
		);

		expect(
			calls.some(
				(call) =>
					call.method === "DELETE" && call.url.pathname === "/v1/vaults/vlt_1",
			),
		).toBe(true);
		expect(await getAgentVault(env.DB, user.id)).toBe(null);
	});
});
