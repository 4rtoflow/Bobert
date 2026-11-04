/**
 * mainに入ったPRを、ラベルで「機能追加」と「軽微な修正」に分け、版の番号(1.{major}.{minor})を上げて、
 * DiscordのWebhookにWhat's Newを送る。送れたら、デプロイしたコミットに版のタグ(v1.3.0など)を付ける。
 * mainへのpushで、デプロイの後に scripts/whats-new.ts から呼ぶ(.github/workflows/deploy.yml)。
 * 版の上げ方とラベルの付け方: README「版とWhat's New」
 *
 * GitHubのAPIとDiscordへの送信には、引数で渡したfetchを使う(テストで差し替えるため)。
 * GitHub ActionsのNode.jsでも、テストのWorkersの実行環境でも読み込めるよう、node: のモジュールは使わない。
 */
import type {
	APIEmbedField,
	RESTPostAPIWebhookWithTokenJSONBody,
} from "discord-api-types/v10";

/** このラベルのPRは、What's Newの「機能追加」に載せ、majorを上げる。ラベルの名前を、そのまま項目の名前にする */
export const FEATURE_LABEL = "機能追加";
/** このラベルのPRは、What's Newの「軽微な修正」に載せ、minorを上げる。ラベルの名前を、そのまま項目の名前にする */
export const FIX_LABEL = "軽微な修正";

/** 版の番号 1.{major}.{minor}。1つ目の数は1で固定する */
export interface Version {
	major: number;
	minor: number;
}

/** 最初の版。版のタグがまだないときに、デプロイしたコミットに付ける */
export const FIRST_VERSION: Version = { major: 0, minor: 0 };

export function versionTag(version: Version): string {
	return `v1.${version.major}.${version.minor}`;
}

/** タグの名前(v1.3.0など)から版を読む。版のタグでなければnull */
export function parseVersionTag(name: string): Version | null {
	const match = /^v1\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(name);
	if (match === null) {
		return null;
	}
	return { major: Number(match[1]), minor: Number(match[2]) };
}

/** タグの名前の一覧から、いちばん新しい版を選ぶ。版のタグがなければnull */
export function latestVersion(tagNames: readonly string[]): Version | null {
	let latest: Version | null = null;
	for (const name of tagNames) {
		const version = parseVersionTag(name);
		if (version === null) {
			continue;
		}
		if (
			latest === null ||
			version.major > latest.major ||
			(version.major === latest.major && version.minor > latest.minor)
		) {
			latest = version;
		}
	}
	return latest;
}

/** mainに入ったPR */
export interface MergedPullRequest {
	number: number;
	title: string;
	labels: string[];
}

/** What's Newに載せるPR(それぞれ、マージした順) */
export interface Changes {
	features: MergedPullRequest[];
	fixes: MergedPullRequest[];
}

/**
 * PRをラベルで分ける。両方のラベルがあるPRは、機能追加として扱う。
 * どちらのラベルもないPR(文書やCIだけの変更など)は載せない
 */
export function classify(pulls: readonly MergedPullRequest[]): Changes {
	return {
		features: pulls.filter((pull) => pull.labels.includes(FEATURE_LABEL)),
		fixes: pulls.filter(
			(pull) =>
				!pull.labels.includes(FEATURE_LABEL) && pull.labels.includes(FIX_LABEL),
		),
	};
}

/**
 * 次の版。機能追加が1つでもあれば、majorを上げてminorを0に戻す。機能追加がなく、軽微な修正があれば、minorを上げる。
 * どちらもなければnull(版を上げない)。PRがいくつあっても、上げるのは1つだけ
 */
export function nextVersion(
	current: Version,
	changes: Changes,
): Version | null {
	if (changes.features.length > 0) {
		return { major: current.major + 1, minor: 0 };
	}
	if (changes.fixes.length > 0) {
		return { major: current.major, minor: current.minor + 1 };
	}
	return null;
}

/** Discordの埋め込みの上限(https://discord.com/developers/docs/resources/message#embed-object-embed-limits) */
const EMBED_LIMITS = { fieldValue: 1024, fields: 25, total: 6000 } as const;

/** 続きの項目の名前。項目の名前は空にできないので、見えない文字(ゼロ幅スペース)にする */
export const CONTINUED_FIELD_NAME = String.fromCodePoint(0x200b);

/**
 * What's Newのメッセージ。見出しは「What's New v1.3.0」で、「機能追加」と「軽微な修正」の項目に、
 * PRのタイトルを箇条書きにする。PRがない方の項目は出さない。最後に送った日時を付ける。
 * ふつうはメッセージ1つになる。Discordの上限を超える長さのときは、項目を続きに分け、
 * それでも1つの埋め込みに収まらなければ、メッセージを分ける(見出しは最初のメッセージだけに付ける)
 */
export function buildWhatsNewMessages(
	version: Version,
	changes: Changes,
	now: Date,
): RESTPostAPIWebhookWithTokenJSONBody[] {
	const title = `What's New ${versionTag(version)}`;
	const fields = [
		...sectionFields(FEATURE_LABEL, changes.features),
		...sectionFields(FIX_LABEL, changes.fixes),
	];
	const groups: APIEmbedField[][] = [];
	let group: APIEmbedField[] = [];
	let size = title.length;
	for (const field of fields) {
		const fieldSize = field.name.length + field.value.length;
		if (
			group.length > 0 &&
			(group.length >= EMBED_LIMITS.fields ||
				size + fieldSize > EMBED_LIMITS.total)
		) {
			groups.push(group);
			group = [];
			size = 0;
		}
		group.push(field);
		size += fieldSize;
	}
	groups.push(group);
	const timestamp = now.toISOString();
	return groups.map((fields, index) => ({
		embeds: [
			{
				...(index === 0 ? { title } : {}),
				fields,
				...(index === groups.length - 1 ? { timestamp } : {}),
			},
		],
		// PRのタイトルに @everyone などがあっても、通知しない
		allowed_mentions: { parse: [] },
	}));
}

/** 1つの項目(機能追加か軽微な修正)の箇条書き。項目の上限を超える分は、名前の見えない続きの項目にする */
function sectionFields(
	name: string,
	pulls: readonly MergedPullRequest[],
): APIEmbedField[] {
	const fields: APIEmbedField[] = [];
	let lines: string[] = [];
	const flush = () => {
		if (lines.length > 0) {
			fields.push({
				name: fields.length === 0 ? name : CONTINUED_FIELD_NAME,
				value: lines.join("\n"),
			});
			lines = [];
		}
	};
	for (const pull of pulls) {
		const line = bulletLine(pull.title);
		if ([...lines, line].join("\n").length > EMBED_LIMITS.fieldValue) {
			flush();
		}
		lines.push(line);
	}
	flush();
	return fields;
}

/**
 * PRのタイトルを、箇条書きの1行にする。1行で項目の上限を超えるときは、末尾を切って「…」を付ける
 * (GitHubのPRのタイトルは256文字までなので、ふつうは起きない)
 */
function bulletLine(title: string): string {
	const line = `- ${title.replace(/\s+/g, " ").trim()}`;
	if (line.length <= EMBED_LIMITS.fieldValue) {
		return line;
	}
	let cut = line.slice(0, EMBED_LIMITS.fieldValue - 1);
	// 絵文字などのサロゲートペアを、途中で切らない
	const last = cut.charCodeAt(cut.length - 1);
	if (last >= 0xd800 && last <= 0xdbff) {
		cut = cut.slice(0, -1);
	}
	return `${cut}…`;
}

/** GitHubのAPIの、次のページのURL(Linkヘッダーの rel="next")。次のページがなければnull */
export function nextPageUrl(link: string | null): string | null {
	if (link === null) {
		return null;
	}
	for (const part of link.split(",")) {
		const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
		if (match?.[1] !== undefined) {
			return match[1];
		}
	}
	return null;
}

/** fetchの返事のうち、ここで使う部分(Node.jsとWorkersの、どちらのResponseも当てはまる) */
export interface HttpResponse {
	readonly ok: boolean;
	readonly status: number;
	readonly headers: { get(name: string): string | null };
	json(): Promise<unknown>;
	text(): Promise<string>;
}

export type Fetch = (
	url: string,
	init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<HttpResponse>;

export interface ReleaseOptions {
	/** リポジトリ(owner/name) */
	repository: string;
	/** デプロイしたコミット */
	sha: string;
	/** PRのマージ先(main)。ほかのブランチへのPRは載せない */
	branch: string;
	githubApiUrl: string;
	githubToken: string;
	/** What's Newを送るDiscordのWebhookのURL。送る内容があるのに、これがなければエラーにする */
	webhookUrl: string | undefined;
	/** trueなら、Discordへの送信とタグの作成をせず、送る内容を表示するだけにする */
	dryRun: boolean;
	now: Date;
	fetch: Fetch;
	sleep: (ms: number) => Promise<void>;
	log: (line: string) => void;
}

/**
 * 前の版のタグからmainに入ったPRを調べ、版を上げてWhat's Newを送り、タグを付ける。
 * 送れてからタグを付けるので、送れなかったときは、やり直すと同じ内容を送り直せる。
 * 前の版より新しいコミットでなければ(古い実行のやり直しなど)、何もしない
 */
export async function releaseWhatsNew(options: ReleaseOptions): Promise<void> {
	const { log } = options;
	const github = gitHubApi(options);

	const current = latestVersion(await github.versionTagNames());
	if (current === null) {
		const tag = versionTag(FIRST_VERSION);
		log(
			`版のタグがまだないので、このコミットを最初の版 ${tag} として記録します(Discordには送りません)。`,
		);
		if (options.dryRun) {
			log("--dry-run のため、タグは作りません。");
			return;
		}
		await github.createTag(tag, options.sha);
		log(`タグ ${tag} を作りました。`);
		return;
	}

	const currentTag = versionTag(current);
	const compared = await github.commitsAfter(currentTag, options.sha);
	if (compared.status === "behind" || compared.status === "identical") {
		log(
			`このコミットは、前の版 ${currentTag} にもう含まれているので、何もしません。`,
		);
		return;
	}

	const pulls = await github.mergedPullRequests(compared.shas);
	for (const pull of pulls) {
		log(`#${pull.number}(${sectionOf(pull)}): ${pull.title}`);
	}
	const changes = classify(pulls);
	const next = nextVersion(current, changes);
	if (next === null) {
		log(
			`前の版 ${currentTag} の後に、「${FEATURE_LABEL}」か「${FIX_LABEL}」のラベルが付いたPRがないので、版を上げず、Discordにも送りません。`,
		);
		return;
	}

	const tag = versionTag(next);
	const messages = buildWhatsNewMessages(next, changes, options.now);
	log(
		`次の版は ${tag} です(前の版 ${currentTag}、機能追加 ${changes.features.length}件、軽微な修正 ${changes.fixes.length}件)。`,
	);
	if (options.dryRun) {
		log(JSON.stringify(messages, null, 2));
		log("--dry-run のため、Discordには送らず、タグも作りません。");
		return;
	}
	if (!options.webhookUrl) {
		throw new Error(
			"What's Newの送り先がありません。GitHubのシークレット WHATS_NEW_WEBHOOK_URL に、DiscordのWebhookのURLを入れてください。",
		);
	}
	for (const message of messages) {
		await postToDiscord(options, options.webhookUrl, message);
	}
	await github.createTag(tag, options.sha);
	log(`What's Newを送り、タグ ${tag} を作りました。`);
}

function sectionOf(pull: MergedPullRequest): string {
	if (pull.labels.includes(FEATURE_LABEL)) {
		return FEATURE_LABEL;
	}
	if (pull.labels.includes(FIX_LABEL)) {
		return FIX_LABEL;
	}
	return "ラベルなし、載せない";
}

interface RefResponse {
	ref: string;
}

interface CompareResponse {
	status: "ahead" | "behind" | "identical" | "diverged";
	commits: { sha: string }[];
}

interface PullResponse {
	number: number;
	title: string;
	merged_at: string | null;
	base: { ref: string };
	labels: { name: string }[];
}

function gitHubApi(options: ReleaseOptions) {
	const repo = `${options.githubApiUrl}/repos/${options.repository}`;

	async function request(
		url: string,
		method = "GET",
		body?: unknown,
	): Promise<HttpResponse> {
		const response = await options.fetch(url, {
			method,
			headers: {
				Accept: "application/vnd.github+json",
				Authorization: `Bearer ${options.githubToken}`,
				"User-Agent": "bobert-whats-new",
				"X-GitHub-Api-Version": "2022-11-28",
				...(body === undefined ? {} : { "Content-Type": "application/json" }),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		if (!response.ok) {
			throw new Error(
				`GitHubのAPIがエラーを返しました(${response.status}、${method} ${url}): ${oneLine(await response.text())}`,
			);
		}
		return response;
	}

	/** Linkヘッダーをたどって、すべてのページの本文を返す */
	async function pages<T>(url: string): Promise<T[]> {
		const bodies: T[] = [];
		let next: string | null = url;
		while (next !== null) {
			const response = await request(next);
			bodies.push((await response.json()) as T);
			next = nextPageUrl(response.headers.get("link"));
		}
		return bodies;
	}

	return {
		/** 「v1.」で始まるタグの名前 */
		async versionTagNames(): Promise<string[]> {
			const refs = await pages<RefResponse[]>(
				`${repo}/git/matching-refs/tags/v1.?per_page=100`,
			);
			return refs.flat().map((ref) => ref.ref.replace(/^refs\/tags\//, ""));
		},

		/** baseの後からheadまでのコミット(古い順)。headがbaseより古ければ、statusがbehindかidenticalになる */
		async commitsAfter(
			base: string,
			head: string,
		): Promise<{ status: CompareResponse["status"]; shas: string[] }> {
			const bodies = await pages<CompareResponse>(
				`${repo}/compare/${base}...${head}?per_page=100`,
			);
			const status = bodies[0]?.status ?? "identical";
			if (status === "diverged") {
				throw new Error(
					`前の版 ${base} のコミットが、mainの履歴にありません。mainの履歴を書き換えた場合は、タグを確かめてください。`,
				);
			}
			return {
				status,
				shas: bodies.flatMap((body) =>
					body.commits.map((commit) => commit.sha),
				),
			};
		},

		/** コミットをmainに入れたPR(マージした順)。PRを通さずにpushしたコミットは含めない */
		async mergedPullRequests(
			shas: readonly string[],
		): Promise<MergedPullRequest[]> {
			const pulls = new Map<number, MergedPullRequest>();
			for (const sha of shas) {
				const response = await request(`${repo}/commits/${sha}/pulls`);
				for (const pull of (await response.json()) as PullResponse[]) {
					if (
						pull.merged_at === null ||
						pull.base.ref !== options.branch ||
						pulls.has(pull.number)
					) {
						continue;
					}
					pulls.set(pull.number, {
						number: pull.number,
						title: pull.title,
						labels: pull.labels.map((label) => label.name),
					});
				}
			}
			return [...pulls.values()];
		},

		async createTag(tag: string, sha: string): Promise<void> {
			await request(`${repo}/git/refs`, "POST", {
				ref: `refs/tags/${tag}`,
				sha,
			});
		},
	};
}

/** Discordへ送るのを試す回数。混雑(429)や、Discord側の一時的な障害(5xx)のときに送り直す */
const DISCORD_ATTEMPTS = 3;

async function postToDiscord(
	options: ReleaseOptions,
	webhookUrl: string,
	message: RESTPostAPIWebhookWithTokenJSONBody,
): Promise<void> {
	let url: URL;
	try {
		url = new URL(webhookUrl);
	} catch {
		// WebhookのURLは秘密なので、エラーの文には入れない
		throw new Error("WHATS_NEW_WEBHOOK_URL が、URLの形になっていません。");
	}
	// wait=true にすると、メッセージを作れたかを返事で確かめられる。スレッドのIDなど、元のクエリは残す
	url.searchParams.set("wait", "true");
	for (let attempt = 1; attempt <= DISCORD_ATTEMPTS; attempt++) {
		const response = await options.fetch(url.toString(), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(message),
		});
		if (response.ok) {
			return;
		}
		const retryable = response.status === 429 || response.status >= 500;
		if (!retryable || attempt === DISCORD_ATTEMPTS) {
			throw new Error(
				`What's NewをDiscordに送れませんでした(${response.status}): ${oneLine(await response.text())}`,
			);
		}
		const wait =
			response.status === 429 ? await retryAfterMs(response) : 2000 * attempt;
		options.log(
			`Discordが ${response.status} を返したので、${wait}ミリ秒後に送り直します。`,
		);
		await options.sleep(wait);
	}
}

/** 429のときに待つ時間。Discordの返事の retry_after(秒)か、Retry-Afterヘッダーを使う。長くても1分にする */
async function retryAfterMs(response: HttpResponse): Promise<number> {
	const header = response.headers.get("retry-after");
	let seconds = header === null ? 1 : Number(header);
	try {
		const body = (await response.json()) as { retry_after?: unknown };
		if (typeof body.retry_after === "number") {
			seconds = body.retry_after;
		}
	} catch {
		// 本文がJSONでなければ、ヘッダーの値を使う
	}
	if (!Number.isFinite(seconds) || seconds < 0) {
		seconds = 1;
	}
	return Math.min(Math.ceil(seconds * 1000), 60_000);
}

/** エラーの文に入れる、返事の本文。GitHub Actionsの注釈で1行に収まるよう、改行をまとめて短くする */
function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim().slice(0, 500);
}
