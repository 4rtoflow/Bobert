/**
 * `/import`の進み具合の表示(仕様: docs/spec/architecture.md「過去ログの取り込み」の進み具合の表示)。
 * 表示する文は、承認をもらったもの(issue #46「文言」)
 */

/** `/import`のコマンドの名前 */
export const IMPORT_COMMAND_NAME = "import";

/** 公開チャンネルがないときの表示 */
export const NO_PUBLIC_CHANNELS =
	"公開チャンネル(@everyoneが見られるチャンネル)がないため、取り込むものはありません。";

/** 取り込みを始められなかったときの表示 */
export const IMPORT_START_FAILED =
	"取り込みを始められませんでした。少し待ってから、もう一度試してください。";

/** ETAの計算に使う、直近の進みの期間 */
const ETA_WINDOW_MS = 60_000;

/** 回の状態 */
export interface RunState {
	/** 回に入れたチャンネルの数 */
	channels: number;
	/** 取り込み済みか、取り込めなかったチャンネルの数 */
	finished: number;
	/** この回で取り込んだメッセージの数 */
	imported: number;
	/** 取り込む件数の見積もり。取れなければnull */
	estimatedTotal: number | null;
}

/** ある時点の進み。ETAの計算に使う */
export interface ProgressSample {
	at: number;
	/** 進みの値(progressMeasureのvalue) */
	value: number;
}

/** 回が終わったか(すべてのチャンネルが、取り込み済みか、取り込めなかった) */
export function isComplete(state: RunState): boolean {
	return state.finished >= state.channels;
}

/**
 * 進みの値と、終わるときの値。見積もりがあれば、取り込んだ件数で測る。
 * なければ(サーバーの検索の準備がまだのときなど)、終わったチャンネルの数で測る
 */
export function progressMeasure(state: RunState): {
	value: number;
	target: number;
} {
	if (state.estimatedTotal !== null && state.estimatedTotal > 0) {
		return {
			value: state.imported,
			target: Math.max(state.estimatedTotal, state.imported),
		};
	}
	return { value: state.finished, target: state.channels };
}

/**
 * 取り込み中の表示。例: 「取り込み中: 42% (ETA: 3:05)」。
 * 見積もりは正確ではないので、完了するまでは99%で止める
 */
export function progressText(
	state: RunState,
	samples: readonly ProgressSample[],
	now: number,
): string {
	const { value, target } = progressMeasure(state);
	const percent =
		target > 0 ? Math.min(99, Math.floor((value / target) * 100)) : 0;
	const eta = remainingMs(samples, target - value, now);
	return `取り込み中: ${percent}% (ETA: ${formatEta(eta)})`;
}

/** 完了の表示。件数は3桁ごとにカンマを入れる。例: 「取り込み完了: 9,123件」 */
export function completedText(imported: number): string {
	return `取り込み完了: ${imported.toLocaleString("en-US")}件`;
}

/** 残りにかかる時間(ミリ秒)。直近の進みの速さから計算する。計算できなければ(進んでいなければ)null */
export function remainingMs(
	samples: readonly ProgressSample[],
	remaining: number,
	now: number,
): number | null {
	const recent = samples.filter((sample) => sample.at >= now - ETA_WINDOW_MS);
	const first = recent[0];
	const last = recent.at(-1);
	if (first === undefined || last === undefined || last.at <= first.at) {
		return null;
	}
	const rate = (last.value - first.value) / (last.at - first.at);
	return rate > 0 ? Math.max(0, remaining) / rate : null;
}

/** ETAの書き方。分:秒(秒は2桁)。1時間を超えても、分で続ける(例: 75:30)。分からなければ「--:--」 */
export function formatEta(ms: number | null): string {
	if (ms === null) {
		return "--:--";
	}
	const seconds = Math.ceil(ms / 1000);
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
