import type {
	APIActionRowComponent,
	APIComponentInMessageActionRow,
	APIInteractionResponse,
	APIModalSubmitInteraction,
} from "discord-api-types/v10";
import {
	ButtonStyle,
	ComponentType,
	InteractionResponseType,
	MessageFlags,
	TextInputStyle,
} from "../discord/constants";
import { logEvent } from "../log";
import { formatCost } from "../respond/usage";
import {
	addDonation,
	type Donation,
	donationTotal,
	endDonation,
	listDonations,
	MICROS_PER_USD,
} from "../store/donations";
import { loadMemberNames } from "../store/messages";
import { getRegisteredProviders } from "../store/users";
import { normalizeInput, readTextInput } from "./input";

/** /donate の画面のボタンと、金額を入力するモーダルのID */
export const DONATE_GIVE_ID = "donate:give";
export const DONATE_STOP_ID = "donate:stop";
export const DONATE_MODAL_ID = "donate:amount";
const AMOUNT_INPUT_ID = "amount";

/** 1回に寄付できる額(ドル)。打ち間違いで大きな額を寄付しないよう、上限を付ける */
export const MIN_DONATION_USD = 1;
export const MAX_DONATION_USD = 100;

/** 寄付する人への説明。費用が概算であることと、会話が寄付した人のアカウントに送られることを書く */
const EXPLANATION = [
	"寄付すると、指定した額を使い切るまで、このサーバーのほかの人への返答に、あなたのキーを使います。キーを登録している人の返答にも、先に寄付を使います。",
	"-# 費用は概算です。使い切る直前の返答の分だけ、少し超えることがあります。",
	"-# 寄付で答えた会話は、あなたのアカウント(AnthropicかOpenRouter)に送られます。その利用には、あなたのアカウントの規約が適用されます。",
];

const NO_KEY =
	"寄付するには、AIのキーの登録が必要です。`/setup` から登録してください。";

const INVALID_AMOUNT = `金額は、${MIN_DONATION_USD}から${MAX_DONATION_USD}までの数で入力してください(小数点以下2桁まで)。`;

/** 操作した人。名前は、サーバーで見えている名前 */
export interface Donor {
	id: string;
	name: string;
}

/**
 * /donate: このサーバーに寄付されたクレジットと、寄付のボタンを、本人にだけ見せる
 * (仕様: docs/spec/llm-cost.md「クレジットの寄付」)
 */
export async function donateCommand(
	env: Env,
	guildId: string,
	user: Donor,
): Promise<APIInteractionResponse> {
	return {
		type: InteractionResponseType.ChannelMessageWithSource,
		data: {
			flags: MessageFlags.Ephemeral,
			...(await panel(env, guildId, user)),
		},
	};
}

/** 「寄付する」ボタン: 金額を入力するモーダルを開く。キーを登録していなければ、登録方法を見せる */
export async function donationModal(
	env: Env,
	userId: string,
): Promise<APIInteractionResponse> {
	if ((await getRegisteredProviders(env.DB, userId)).size === 0) {
		return ephemeral(NO_KEY);
	}
	return {
		type: InteractionResponseType.Modal,
		data: {
			custom_id: DONATE_MODAL_ID,
			title: "クレジットを寄付する",
			components: [
				{
					type: ComponentType.Label,
					label: "金額(ドル)",
					component: {
						type: ComponentType.TextInput,
						custom_id: AMOUNT_INPUT_ID,
						style: TextInputStyle.Short,
						placeholder: `${MIN_DONATION_USD}〜${MAX_DONATION_USD}。例: 5`,
						required: true,
						max_length: 10,
					},
				},
			],
		},
	};
}

/**
 * モーダルの送信: 寄付を足し、画面を結果に書き換える。
 * 金額が正しくなければ、画面はそのままにして、理由を本人にだけ見せる
 */
export async function submitDonation(
	interaction: APIModalSubmitInteraction,
	env: Env,
	guildId: string,
	user: Donor,
): Promise<APIInteractionResponse> {
	const amountMicros = parseDonationAmount(
		readTextInput(interaction, AMOUNT_INPUT_ID) ?? "",
	);
	if (amountMicros === null) {
		return ephemeral(INVALID_AMOUNT);
	}
	// 画面を開いた後に、キーを消していることがある
	if ((await getRegisteredProviders(env.DB, user.id)).size === 0) {
		return ephemeral(NO_KEY);
	}
	await addDonation(env.DB, {
		guildId,
		donorId: user.id,
		donorName: user.name,
		amountMicros,
	});
	log("donated", { guildId, donorId: user.id, amountMicros });
	const total = await donationTotal(env.DB, guildId);
	return {
		type: InteractionResponseType.UpdateMessage,
		data: {
			content: `$${formatAmount(amountMicros)}を寄付しました。このサーバーの残りは、約$${formatMicros(total)}です。`,
			components: [],
		},
	};
}

/** 「寄付をやめる」ボタン: 寄付をやめ、画面を結果に書き換える */
export async function stopDonation(
	env: Env,
	guildId: string,
	user: Donor,
): Promise<APIInteractionResponse> {
	const remaining = await endDonation(env.DB, guildId, user.id);
	if (remaining === null) {
		// もうやめていた(画面を開いたまま、2回押したときなど)。今の状態を見せ直す
		return {
			type: InteractionResponseType.UpdateMessage,
			data: await panel(env, guildId, user),
		};
	}
	log("donation_stopped", { guildId, donorId: user.id, remaining });
	return {
		type: InteractionResponseType.UpdateMessage,
		data: {
			content: `寄付をやめました。残りの約$${formatMicros(Math.max(remaining, 0))}は使われません。`,
			components: [],
		},
	};
}

/**
 * 入力された金額を、100万分の1ドルの単位にする。
 * 1〜100ドルで、小数点以下2桁までの数でなければnull。全角の数字や、先頭の「$」も受け付ける
 */
export function parseDonationAmount(input: string): number | null {
	const text = normalizeInput(input).replace(/^\$/, "");
	if (!/^\d+(\.\d{1,2})?$/.test(text)) {
		return null;
	}
	const cents = Math.round(Number(text) * 100);
	if (cents < MIN_DONATION_USD * 100 || cents > MAX_DONATION_USD * 100) {
		return null;
	}
	return cents * (MICROS_PER_USD / 100);
}

/** /donate の画面。寄付の一覧と、寄付のボタン(寄付している人には、やめるボタンも) */
async function panel(
	env: Env,
	guildId: string,
	user: Donor,
): Promise<{
	content: string;
	components: APIActionRowComponent<APIComponentInMessageActionRow>[];
}> {
	const donations = await listDonations(env.DB, guildId);
	const names = await loadMemberNames(
		env.DB,
		guildId,
		donations.map((donation) => donation.donorId),
	);
	// 操作した人の名前は、Interactionで分かった、いちばん新しいもの
	names.set(user.id, user.name);
	return {
		content: panelText(donations, names, user.id, Date.now()),
		components: [
			{
				type: ComponentType.ActionRow,
				components: [
					{
						type: ComponentType.Button,
						style: ButtonStyle.Primary,
						custom_id: DONATE_GIVE_ID,
						label: "寄付する",
					},
					...(donations.some((donation) => donation.donorId === user.id)
						? [
								{
									type: ComponentType.Button,
									style: ButtonStyle.Secondary,
									custom_id: DONATE_STOP_ID,
									label: "寄付をやめる",
								} as const,
							]
						: []),
				],
			},
		],
	};
}

/** 画面の本文。寄付は、使う順(古い順)に並べる */
function panelText(
	donations: readonly Donation[],
	names: ReadonlyMap<string, string>,
	userId: string,
	now: number,
): string {
	const total = donations.reduce(
		(sum, donation) => sum + donation.remainingMicros,
		0,
	);
	const header =
		donations.length === 0
			? "**このサーバーに寄付されたクレジット**: なし"
			: `**このサーバーに寄付されたクレジット**: 残り 約$${formatMicros(total)}`;
	const lines = donations.map((donation) => {
		const name = escapeMarkdown(
			names.get(donation.donorId) ?? donation.donorName,
		);
		const you = donation.donorId === userId ? "(あなた)" : "";
		const paused =
			donation.pausedUntil !== null && donation.pausedUntil > now
				? "(キーが無効か残高が足りないため、いまは使えません)"
				: "";
		return `- ${name}${you}: 約$${formatMicros(donation.remainingMicros)}${paused}`;
	});
	return [header, ...lines, "", ...EXPLANATION].join("\n");
}

/** 寄付した額の書き方。整数ならそのまま(5)、端数があれば小数点以下2桁(2.50) */
function formatAmount(micros: number): string {
	const usd = micros / MICROS_PER_USD;
	return Number.isInteger(usd) ? String(usd) : usd.toFixed(2);
}

/** 残りの書き方(利用量の表示の費用と同じ) */
function formatMicros(micros: number): string {
	return formatCost(micros / MICROS_PER_USD);
}

/** 名前に含まれる、Discordの書式になる文字を、そのまま見えるようにする */
function escapeMarkdown(text: string): string {
	return text.replace(/[\\*_~`|>]/g, "\\$&");
}

function ephemeral(content: string): APIInteractionResponse {
	return {
		type: InteractionResponseType.ChannelMessageWithSource,
		data: { flags: MessageFlags.Ephemeral, content },
	};
}

function log(event: string, detail: Record<string, unknown>): void {
	logEvent("interactions", event, detail);
}
