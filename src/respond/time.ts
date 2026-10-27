/**
 * AIに渡す時刻の書き方と、AIが指定した日時の読み方(仕様: docs/spec/architecture.md「会話の文脈と過去の発言の保存」の時刻の表し方)。
 * 日本時間で扱う。日本には夏時間がないので、UTCに9時間を足して書く。
 */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

/** 日本時間で、曜日を付けて書く。例: 2026-10-27(火) 14:05 */
export function formatJst(ms: number): string {
	const date = jstDate(ms);
	return `${ymd(date)}(${WEEKDAYS[date.getUTCDay()]}) ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

/** AIに日時を指定してもらうときの形。秒まで書く。例: 2026-10-27 14:05:09 */
export function formatJstInput(ms: number): string {
	const date = jstDate(ms);
	return `${ymd(date)} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

/**
 * AIが指定した日時を読む。日本時間として扱う。例: 2026-10-01、2026-10-01 09:00、2026-10-01 09:00:30。
 * 曜日の書き添え(「(火)」)は無視する。時差(+09:00やZ)が付いていれば、それに従う。読めなければnull
 */
export function parseJst(text: string): number | null {
	const trimmed = text.trim().replace(/\([日月火水木金土]\)/, "");
	const match =
		/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(
			trimmed,
		);
	if (match) {
		const [year, month, day, hour, minute, second] = match
			.slice(1)
			.map((part) => Number(part ?? 0));
		if (
			hour === undefined ||
			minute === undefined ||
			second === undefined ||
			hour > 23 ||
			minute > 59 ||
			second > 59
		) {
			return null;
		}
		const ms =
			Date.UTC(year ?? 0, (month ?? 0) - 1, day ?? 0, hour, minute, second) -
			JST_OFFSET_MS;
		// 2月30日のように、ない日付は読まない(Date.UTCは翌月にずらしてしまう)
		const check = jstDate(ms);
		return check.getUTCMonth() + 1 === month && check.getUTCDate() === day
			? ms
			: null;
	}
	if (/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(trimmed)) {
		const ms = Date.parse(trimmed);
		return Number.isNaN(ms) ? null : ms;
	}
	return null;
}

/** 日本時間の時刻を、UTCの各部分として読めるDateにする */
function jstDate(ms: number): Date {
	return new Date(ms + JST_OFFSET_MS);
}

function ymd(date: Date): string {
	return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function pad(value: number): string {
	return String(value).padStart(2, "0");
}
