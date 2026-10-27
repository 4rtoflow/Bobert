import { DiscordApiError, getGuildMember } from "../discord/api";
import type { LlmError, TokenUsage } from "../llm/types";
import { logEvent } from "../log";
import {
	chargeDonation,
	donationTotal,
	endDonation,
	hasDonationHistory,
	MICROS_PER_USD,
	pauseDonation,
	usableDonations,
} from "../store/donations";
import {
	type Credential,
	getRegisteredProviders,
	loadCredential,
	type UserSettings,
} from "../store/users";
import {
	type ModelResolution,
	type ResolvedModel,
	resolveModel,
	selectedCandidate,
	usesCustomModel,
} from "./model";
import { DONATIONS_UNAVAILABLE, donationNote, setupGuidance } from "./replies";
import { chargeableCost } from "./usage";

/** 寄付した人のキーが無効か残高不足のときに、その寄付を止めておく時間 */
export const DONATION_PAUSE_MS = 60 * 60 * 1000;

/** Discordのエラーコード: サーバーのメンバーではない */
const UNKNOWN_MEMBER = 10007;

/** 返答の費用を払う人。本人のキーか、サーバーに寄付した人のキー */
export type Payer =
	| { kind: "self" }
	| { kind: "donation"; guildId: string; donorId: string };

/** 返答に使うモデルと、費用を払う人のキー */
export interface PaidModel {
	payer: Payer;
	model: ResolvedModel;
	credential: Credential;
}

export type PaidModelResolution =
	| ({ ok: true } & PaidModel)
	| {
			ok: false;
			/** 何が足りないか(ログ用) */
			missing: Extract<ModelResolution, { ok: false }>["missing"];
			/** 本人に見せる、登録方法の案内 */
			guidance: string;
	  };

/**
 * 返答に使うモデルと、費用を払う人を決める(仕様: docs/spec/llm-cost.md「クレジットの寄付」)。
 * サーバーに寄付があれば、古い順に、寄付した人のキーで本人の設定のモデルを呼べるか確かめて、先に使う。
 * 「その他」で入力したモデルには、寄付を使わない。使える寄付がなければ、本人のキーを使う。
 * checkMembershipなら、寄付した人がサーバーにいるか確かめ、抜けていたら寄付を終える。
 * Discordへの問い合わせが要るので、3秒以内に応答するInteractionでは確かめない。
 * skipDonorsの人の寄付は使わない(この返答で、キーが使えなかった人)
 */
export async function resolvePaidModel(
	env: Env,
	request: {
		userId: string;
		guildId: string | null;
		settings: UserSettings;
		checkMembership: boolean;
		skipDonors?: ReadonlySet<string>;
	},
): Promise<PaidModelResolution> {
	const { userId, guildId, settings } = request;
	if (guildId !== null && !usesCustomModel(settings)) {
		for (const donation of await usableDonations(env.DB, guildId, userId)) {
			if (request.skipDonors?.has(donation.donorId)) {
				continue;
			}
			const resolution = resolveModel(
				settings,
				await getRegisteredProviders(env.DB, donation.donorId),
			);
			if (
				!resolution.ok ||
				(request.checkMembership &&
					!(await isGuildMember(env, guildId, donation.donorId)))
			) {
				continue;
			}
			const credential = await loadCredential(
				env,
				donation.donorId,
				resolution.model.provider,
			);
			if (credential !== null) {
				return {
					ok: true,
					payer: { kind: "donation", guildId, donorId: donation.donorId },
					model: resolution.model,
					credential,
				};
			}
		}
	}

	const resolution = resolveModel(
		settings,
		await getRegisteredProviders(env.DB, userId),
	);
	if (!resolution.ok) {
		return {
			ok: false,
			missing: resolution.missing,
			guidance: await guidance(env, guildId, resolution),
		};
	}
	const credential = await loadCredential(
		env,
		userId,
		resolution.model.provider,
	);
	if (credential === null) {
		// 直前に /delete された
		const missing = { ok: false, missing: "credentials", label: "" } as const;
		return {
			ok: false,
			missing: missing.missing,
			guidance: await guidance(env, guildId, missing),
		};
	}
	return {
		ok: true,
		payer: { kind: "self" },
		model: resolution.model,
		credential,
	};
}

/**
 * 登録方法の案内。キーのない人には、寄付されたことがあるサーバーなら、いまは寄付を使えないことを先に書く
 * (いま使える寄付があれば、ここには来ない)
 */
async function guidance(
	env: Env,
	guildId: string | null,
	resolution: Extract<ModelResolution, { ok: false }>,
): Promise<string> {
	const text = setupGuidance(resolution);
	return resolution.missing === "credentials" &&
		guildId !== null &&
		(await hasDonationHistory(env.DB, guildId))
		? `${DONATIONS_UNAVAILABLE}${text}`
		: text;
}

/**
 * 寄付した人が、サーバーにいるか。抜けていたら、その寄付を終える。
 * 確かめられなかったとき(Discordの障害など)は、この返答では使わない
 */
async function isGuildMember(
	env: Env,
	guildId: string,
	donorId: string,
): Promise<boolean> {
	try {
		await getGuildMember(env.DISCORD_BOT_TOKEN, guildId, donorId);
		return true;
	} catch (error) {
		if (error instanceof DiscordApiError && error.code === UNKNOWN_MEMBER) {
			await endDonation(env.DB, guildId, donorId);
			log("donation_ended", { guildId, donorId, reason: "left_guild" });
			return false;
		}
		log("member_check_failed", {
			guildId,
			donorId,
			error: error instanceof Error ? error.message : "unknown",
		});
		return false;
	}
}

/**
 * 寄付で答えたときに、APIを呼んだ分の費用を、寄付から差し引く。
 * 差し引けなくても、返答は続ける(費用は、もうかかっているため)
 */
export async function chargeDonationFor(
	env: Env,
	payer: Extract<Payer, { kind: "donation" }>,
	requestUsages: readonly TokenUsage[],
	model: ResolvedModel,
	settings: UserSettings,
): Promise<void> {
	// 寄付は候補のモデルにしか使わないので、候補が必ずある
	const candidate = selectedCandidate(settings);
	if (candidate === null) {
		return;
	}
	try {
		const costMicros = Math.ceil(
			(await chargeableCost(requestUsages, model, candidate)) * MICROS_PER_USD,
		);
		await chargeDonation(env.DB, payer.guildId, payer.donorId, costMicros);
		log("donation_charged", {
			guildId: payer.guildId,
			donorId: payer.donorId,
			costMicros,
		});
	} catch (error) {
		log("donation_charge_failed", {
			guildId: payer.guildId,
			donorId: payer.donorId,
			error: error instanceof Error ? error.message : "unknown",
		});
	}
}

/**
 * 寄付した人のキーが無効か残高不足なら、その寄付を止める。
 * 止めたら、寄付した人のIDを返す(次の寄付か、本人のキーで答え直す)。止めなければnull
 */
export async function pauseIfDonorKeyFailed(
	env: Env,
	payer: Payer,
	error: LlmError,
): Promise<string | null> {
	if (
		payer.kind !== "donation" ||
		(error.kind !== "invalid_key" && error.kind !== "insufficient_credit")
	) {
		return null;
	}
	await pauseDonation(
		env.DB,
		payer.guildId,
		payer.donorId,
		Date.now() + DONATION_PAUSE_MS,
	);
	log("donation_paused", {
		guildId: payer.guildId,
		donorId: payer.donorId,
		kind: error.kind,
	});
	return payer.donorId;
}

/** 寄付で答えた返答に添える行。寄付で答えなかったらnull */
export async function paidNote(env: Env, payer: Payer): Promise<string | null> {
	return payer.kind === "donation"
		? donationNote(
				(await donationTotal(env.DB, payer.guildId)) / MICROS_PER_USD,
			)
		: null;
}

function log(event: string, detail: Record<string, unknown> = {}): void {
	logEvent("donation", event, detail);
}
