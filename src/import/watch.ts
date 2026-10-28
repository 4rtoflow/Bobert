import { logEvent } from "../log";
import { firstImportJob } from "../queue/import";
import type { ImportJob } from "../queue/messages";
import {
	failStalledImports,
	finishImportRun,
	importRunProgress,
	loadImportRun,
	startQueuedImports,
} from "../store/imports";
import {
	completedText,
	isComplete,
	type ProgressSample,
	progressMeasure,
	progressText,
	type RunState,
} from "./progress";

/** 書き換える間隔 */
export const UPDATE_INTERVAL_MS = 5_000;
/**
 * Interactionのトークンで書き換える期間。トークンは15分で切れるので、少し前に、Botのトークンでの書き換えに切り替える
 */
export const INTERACTION_EDIT_WINDOW_MS = 14 * 60 * 1000;
/** ETAの計算のために残す、進みの記録の数(5秒おきで、1分と少し) */
const MAX_SAMPLES = 13;

/** 進み具合の表示(`/import`への返答のメッセージ。実行したチャンネルの全員に見える) */
export interface ProgressDisplay {
	runId: string;
	guildId: string;
	channelId: string;
	messageId: string;
	/** Interactionのトークン。実行から15分までは、これで書き換える */
	interactionToken: string;
	/** `/import`を実行した時刻(UNIX時間のミリ秒) */
	createdAt: number;
	/** 最後に書いた文 */
	content: string;
}

/** 見張っている表示と、回ごとの進みの記録 */
export interface WatchState {
	displays: ProgressDisplay[];
	samples: Record<string, ProgressSample[]>;
}

/** 表示の書き換えの結果。goneはメッセージが消えていた、failedはそのほかの失敗(次の回にやり直す) */
export type EditResult = "ok" | "gone" | "failed";

/** 見張るのに使うもの。テストでは偽物に差し替える */
export interface WatchDeps {
	db: D1Database;
	edit: (
		display: ProgressDisplay,
		content: string,
		now: number,
	) => Promise<EditResult>;
	/** 取り込みを始めたチャンネルの、最初の仕事を入れる */
	enqueueImports: (jobs: ImportJob[]) => Promise<void>;
}

/** 回の今の状態 */
export async function runState(
	db: D1Database,
	runId: string,
): Promise<RunState> {
	const [progress, run] = await Promise.all([
		importRunProgress(db, runId),
		loadImportRun(db, runId),
	]);
	return {
		channels: progress.channels,
		finished: progress.finished,
		imported: progress.imported,
		estimatedTotal: run?.estimatedTotal ?? null,
	};
}

/**
 * 進み具合の表示を、今の状態に書き換える(5秒おきに呼ぶ)。残った表示を返す。
 * - 途中で止まったチャンネルは取り込めなかったとし、空いた分だけ、順番待ちのチャンネルの取り込みを始める
 * - 回が終わったら、完了の表示にして、見張るのをやめる
 * - 文が変わらなければ、書き換えない。メッセージが消えていたら、その表示を見張るのをやめる
 */
export async function refreshDisplays(
	state: WatchState,
	deps: WatchDeps,
	now: number,
): Promise<WatchState> {
	const next: WatchState = { displays: [], samples: {} };
	for (const runId of new Set(state.displays.map((display) => display.runId))) {
		const stalled = await failStalledImports(deps.db, runId, now);
		if (stalled.length > 0) {
			logEvent("import", "import_stalled", { runId, channels: stalled.length });
		}
		const started = await startQueuedImports(deps.db, runId, now);
		if (started.length > 0) {
			await deps.enqueueImports(started.map(firstImportJob));
		}
		const run = await runState(deps.db, runId);
		const complete = isComplete(run);
		const samples = [
			...(state.samples[runId] ?? []),
			{ at: now, value: progressMeasure(run).value },
		].slice(-MAX_SAMPLES);
		const content = complete
			? completedText(run.imported)
			: progressText(run, samples, now);
		for (const display of state.displays) {
			if (display.runId !== runId) {
				continue;
			}
			const result =
				display.content === content
					? "ok"
					: await deps.edit(display, content, now);
			if (result === "gone" || (complete && result === "ok")) {
				continue;
			}
			// 書き換えに失敗したら、前の文のままにして、次の回にやり直す
			next.displays.push(result === "ok" ? { ...display, content } : display);
		}
		if (complete) {
			await finishImportRun(deps.db, runId, now);
			logEvent("import", "import_finished", {
				runId,
				channels: run.channels,
				imported: run.imported,
			});
		} else {
			next.samples[runId] = samples;
		}
	}
	return next;
}
