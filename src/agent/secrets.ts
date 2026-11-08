import Anthropic from "@anthropic-ai/sdk";
import { logEvent } from "../log";
import { getAgentVault, saveAgentVault } from "./store";

/**
 * エージェントに渡す秘密(#99。仕様: docs/spec/architecture.md「エージェント(Bobert Agent)」)。
 * 本人のAnthropicのアカウントにvaultを1つ作り、秘密を環境変数(environment_variable)として預ける。
 * サンドボックスの中ではダミーの文字列になり、送り先のホストへのリクエストのヘッダーの中でだけ、Anthropic側で本物に差し替わる。
 * 値はBobertに残さない。名前と送り先も、そのつどvaultから読む
 */

/** 預けた秘密(値は読めない) */
export interface AgentSecret {
	/** vaultの資格情報のID(vcrd_...) */
	id: string;
	/** 環境変数の名前 */
	name: string;
	/** 送り先のURL(https://ホスト) */
	url: string;
}

/** 1つのvaultに置ける数(Managed Agentsの上限) */
export const MAX_AGENT_SECRETS = 20;
/** 名前の長さの上限。ボタンのIDに入れるので、Discordの上限(100文字)に収める */
export const MAX_SECRET_NAME_LENGTH = 40;
const NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/** vaultとその資格情報の、Claude Consoleで見える名前 */
const VAULT_NAME = "Bobert Agent";
/** 資格情報に残す、送り先のURL(表示用) */
const URL_METADATA = "url";

/** 名前が、環境変数の名前の決まり(英大文字、数字、_。先頭は英大文字)に合っているか */
export function isValidSecretName(name: string): boolean {
	return name.length <= MAX_SECRET_NAME_LENGTH && NAME_PATTERN.test(name);
}

/** 送り先のURLを読む。https://で始まらなければnull。返すのは、URLの頭(https://ホスト)とホスト */
export function parseSecretUrl(
	input: string,
): { url: string; host: string } | null {
	let url: URL;
	try {
		url = new URL(input.trim());
	} catch {
		return null;
	}
	if (url.protocol !== "https:" || url.hostname === "" || url.port !== "") {
		return null;
	}
	return { url: url.origin, host: url.hostname };
}

/** Basic認証の、Authorizationヘッダーの値(「Basic」に続けて、「ユーザー名:パスワード」をbase64にしたもの) */
export function basicAuthorization(username: string, password: string): string {
	const bytes = new TextEncoder().encode(`${username}:${password}`);
	return `Basic ${btoa(String.fromCharCode(...bytes))}`;
}

/** 預けた秘密の一覧(名前の順)。vaultがまだなければ空 */
export async function listAgentSecrets(
	db: D1Database,
	userId: string,
	client: Anthropic,
): Promise<AgentSecret[]> {
	const vaultId = await getAgentVault(db, userId);
	if (vaultId === null) {
		return [];
	}
	try {
		return await secretsIn(client, vaultId);
	} catch (error) {
		// 別のワークスペースのキーに替えたときなど。秘密は、そのワークスペースには無い
		if (error instanceof Anthropic.NotFoundError) {
			return [];
		}
		throw error;
	}
}

/**
 * セッションにつなぐvaultと、そこにある秘密。秘密がなければnull(vaultはつながない)。
 * 読めなくても、セッションは秘密なしで始められるので、記録を残してnullを返す
 */
export async function vaultForSession(
	db: D1Database,
	userId: string,
	client: Anthropic,
): Promise<{ vaultId: string; secrets: AgentSecret[] } | null> {
	const vaultId = await getAgentVault(db, userId);
	if (vaultId === null) {
		return null;
	}
	try {
		const secrets = await secretsIn(client, vaultId);
		return secrets.length === 0 ? null : { vaultId, secrets };
	} catch (error) {
		logEvent("agent", "vault_read_failed", {
			userId,
			error: error instanceof Error ? error.name : "unknown",
		});
		return null;
	}
}

/** 秘密を足した結果。duplicateは同じ名前がある、limitは数が上限に達している */
export type AddSecretResult = "added" | "duplicate" | "limit";

/**
 * 秘密を預ける。vaultがなければ作る。記録したvaultが見つからなければ(別のワークスペースのキーに替えたときなど)、作り直す。
 * 値はヘッダーの中だけで、送り先のホストへのリクエストにだけ差し替わるようにする
 */
export async function addAgentSecret(
	db: D1Database,
	userId: string,
	client: Anthropic,
	secret: { name: string; value: string; url: string; host: string },
): Promise<AddSecretResult> {
	let vaultId = await getAgentVault(db, userId);
	for (let attempt = 0; ; attempt++) {
		if (vaultId === null) {
			vaultId = (await client.beta.vaults.create({ display_name: VAULT_NAME }))
				.id;
			await saveAgentVault(db, userId, vaultId);
		}
		try {
			const existing = await secretsIn(client, vaultId);
			if (existing.some((item) => item.name === secret.name)) {
				return "duplicate";
			}
			if (existing.length >= MAX_AGENT_SECRETS) {
				return "limit";
			}
			await client.beta.vaults.credentials.create(vaultId, {
				display_name: secret.name,
				metadata: { [URL_METADATA]: secret.url },
				auth: {
					type: "environment_variable",
					secret_name: secret.name,
					secret_value: secret.value,
					networking: { type: "limited", allowed_hosts: [secret.host] },
					injection_location: { header: true },
				},
			});
			logEvent("agent", "secret_added", { userId, secret: secret.name });
			return "added";
		} catch (error) {
			if (attempt === 0 && error instanceof Anthropic.NotFoundError) {
				logEvent("agent", "vault_recreated", { userId });
				vaultId = null;
				continue;
			}
			throw error;
		}
	}
}

/** 秘密を消す。もう無ければ(ほかの画面で消した、ワークスペースを替えた)、消せたことにする */
export async function deleteAgentSecret(
	db: D1Database,
	userId: string,
	client: Anthropic,
	credentialId: string,
): Promise<void> {
	const vaultId = await getAgentVault(db, userId);
	if (vaultId === null) {
		return;
	}
	try {
		await client.beta.vaults.credentials.delete(credentialId, {
			vault_id: vaultId,
		});
		logEvent("agent", "secret_deleted", { userId });
	} catch (error) {
		if (!(error instanceof Anthropic.NotFoundError)) {
			throw error;
		}
	}
}

/** /delete で、vaultごと消す(中の秘密も消える)。もう無ければ何もしない */
export async function deleteAgentVault(
	client: Anthropic,
	vaultId: string,
): Promise<void> {
	try {
		await client.beta.vaults.delete(vaultId);
	} catch (error) {
		if (!(error instanceof Anthropic.NotFoundError)) {
			throw error;
		}
	}
}

/** vaultの中の、環境変数の秘密(名前の順。アーカイブしたものは除く) */
async function secretsIn(
	client: Anthropic,
	vaultId: string,
): Promise<AgentSecret[]> {
	const secrets: AgentSecret[] = [];
	for await (const credential of client.beta.vaults.credentials.list(vaultId)) {
		const { auth } = credential;
		if (
			credential.archived_at !== null ||
			auth.type !== "environment_variable"
		) {
			continue;
		}
		const host =
			auth.networking.type === "limited"
				? auth.networking.allowed_hosts[0]
				: undefined;
		secrets.push({
			id: credential.id,
			name: auth.secret_name,
			url:
				credential.metadata[URL_METADATA] ??
				(host === undefined ? "" : `https://${host}`),
		});
	}
	return secrets.sort((a, b) => (a.name < b.name ? -1 : 1));
}
