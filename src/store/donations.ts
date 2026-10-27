/**
 * クレジットの寄付(仕様: docs/spec/llm-cost.md「クレジットの寄付」)。
 * 寄付はサーバーと寄付した人ごとに1行で、残りを数える。金額は、100万分の1ドルを単位にした整数で持つ
 */

/** 1ドルあたりの、金額の単位の数 */
export const MICROS_PER_USD = 1_000_000;

/** 寄付 */
export interface Donation {
	guildId: string;
	donorId: string;
	/** 寄付した人の、サーバーで見えている名前(最後に寄付したときのもの) */
	donorName: string;
	/** 残り。使い切る直前の返答の分だけ、負になることがある */
	remainingMicros: number;
	donatedAt: number;
	/** キーが無効か残高不足で、この日時まで使わない。止まっていなければnull */
	pausedUntil: number | null;
}

interface DonationRow {
	guild_id: string;
	donor_id: string;
	donor_name: string;
	remaining_micros: number;
	donated_at: number;
	paused_until: number | null;
}

const DONATION_COLUMNS =
	"guild_id, donor_id, donor_name, remaining_micros, donated_at, paused_until";

/**
 * 寄付を足す。寄付していなければ(やめていたら)、新しく寄付する。
 * 寄付を足すと、止まっていた寄付も再開する(キーを直してから寄付し直すことがあるため)。
 * 使い切って負になっていた分は、足す額から引かない
 */
export async function addDonation(
	db: D1Database,
	donation: {
		guildId: string;
		donorId: string;
		donorName: string;
		amountMicros: number;
	},
	now = Date.now(),
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO donations
			(guild_id, donor_id, donor_name, remaining_micros, donated_at, ended_at, paused_until, updated_at)
			VALUES (?1, ?2, ?3, ?4, ?5, NULL, NULL, ?5)
			ON CONFLICT (guild_id, donor_id) DO UPDATE SET
				donor_name = excluded.donor_name,
				remaining_micros = CASE WHEN donations.ended_at IS NULL
					THEN MAX(donations.remaining_micros, 0) + excluded.remaining_micros
					ELSE excluded.remaining_micros END,
				donated_at = CASE WHEN donations.ended_at IS NULL
					THEN donations.donated_at ELSE excluded.donated_at END,
				ended_at = NULL,
				paused_until = NULL,
				updated_at = excluded.updated_at`,
		)
		.bind(
			donation.guildId,
			donation.donorId,
			donation.donorName,
			donation.amountMicros,
			now,
		)
		.run();
}

/** サーバーの、残りのある寄付(やめたものを除く)。使う順(古い順)に並べる */
export async function listDonations(
	db: D1Database,
	guildId: string,
): Promise<Donation[]> {
	const { results } = await db
		.prepare(
			`SELECT ${DONATION_COLUMNS} FROM donations
			WHERE guild_id = ? AND ended_at IS NULL AND remaining_micros > 0
			ORDER BY donated_at, donor_id`,
		)
		.bind(guildId)
		.all<DonationRow>();
	return results.map(fromRow);
}

/**
 * 返答に使える寄付。使う順(古い順)に並べる。
 * 止まっているものと、返答を頼んだ本人の寄付は除く(本人のキーなので、寄付が減るだけのため)
 */
export async function usableDonations(
	db: D1Database,
	guildId: string,
	requesterId: string,
	now = Date.now(),
): Promise<Donation[]> {
	const { results } = await db
		.prepare(
			`SELECT ${DONATION_COLUMNS} FROM donations
			WHERE guild_id = ? AND ended_at IS NULL AND remaining_micros > 0
				AND (paused_until IS NULL OR paused_until <= ?) AND donor_id <> ?
			ORDER BY donated_at, donor_id`,
		)
		.bind(guildId, now, requesterId)
		.all<DonationRow>();
	return results.map(fromRow);
}

/** サーバーの寄付の残りの合計(やめたものを除く。止まっているものも数える) */
export async function donationTotal(
	db: D1Database,
	guildId: string,
): Promise<number> {
	const total = await db
		.prepare(
			`SELECT COALESCE(SUM(remaining_micros), 0) AS total FROM donations
			WHERE guild_id = ? AND ended_at IS NULL AND remaining_micros > 0`,
		)
		.bind(guildId)
		.first<number>("total");
	return total ?? 0;
}

/** 寄付から、使った分を差し引く。やめた後でも差し引く(費用は、もうかかっているため) */
export async function chargeDonation(
	db: D1Database,
	guildId: string,
	donorId: string,
	micros: number,
	now = Date.now(),
): Promise<void> {
	await db
		.prepare(
			`UPDATE donations SET remaining_micros = remaining_micros - ?, updated_at = ?
			WHERE guild_id = ? AND donor_id = ?`,
		)
		.bind(micros, now, guildId, donorId)
		.run();
}

/** 寄付をやめる。やめた寄付の残りを返す。寄付していなければnull */
export async function endDonation(
	db: D1Database,
	guildId: string,
	donorId: string,
	now = Date.now(),
): Promise<number | null> {
	return db
		.prepare(
			`UPDATE donations SET ended_at = ?1, updated_at = ?1
			WHERE guild_id = ?2 AND donor_id = ?3 AND ended_at IS NULL
			RETURNING remaining_micros`,
		)
		.bind(now, guildId, donorId)
		.first<number>("remaining_micros");
}

/** 寄付を、untilまで止める(キーが無効か残高不足のとき) */
export async function pauseDonation(
	db: D1Database,
	guildId: string,
	donorId: string,
	until: number,
	now = Date.now(),
): Promise<void> {
	await db
		.prepare(
			"UPDATE donations SET paused_until = ?, updated_at = ? WHERE guild_id = ? AND donor_id = ?",
		)
		.bind(until, now, guildId, donorId)
		.run();
}

/** そのサーバーで、寄付されたことがあるか(やめた寄付や、使い切った寄付を含む) */
export async function hasDonationHistory(
	db: D1Database,
	guildId: string,
): Promise<boolean> {
	const row = await db
		.prepare("SELECT 1 AS found FROM donations WHERE guild_id = ? LIMIT 1")
		.bind(guildId)
		.first<number>("found");
	return row !== null;
}

/** その人が、どこかのサーバーで寄付しているか(残りのある寄付があるか) */
export async function isDonating(
	db: D1Database,
	donorId: string,
): Promise<boolean> {
	const row = await db
		.prepare(
			`SELECT 1 AS found FROM donations
			WHERE donor_id = ? AND ended_at IS NULL AND remaining_micros > 0 LIMIT 1`,
		)
		.bind(donorId)
		.first<number>("found");
	return row !== null;
}

function fromRow(row: DonationRow): Donation {
	return {
		guildId: row.guild_id,
		donorId: row.donor_id,
		donorName: row.donor_name,
		remainingMicros: row.remaining_micros,
		donatedAt: row.donated_at,
		pausedUntil: row.paused_until,
	};
}
