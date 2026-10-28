import { DurableObject } from "cloudflare:workers";
import { editProgress, enqueueImports } from "./start";
import {
	type ProgressDisplay,
	refreshDisplays,
	UPDATE_INTERVAL_MS,
	type WatchState,
} from "./watch";

/**
 * `/import`の進み具合を見張り、表示を5秒おきに書き換えるDurable Object(サーバーごとに1つ)。
 * 仕様: docs/spec/architecture.md「過去ログの取り込み」の進み具合の表示。
 * 取り込みが終わったら、完了の表示にして、見張るのをやめる
 */
export class ImportProgress extends DurableObject<Env> {
	/** 表示を見張り始める */
	async watch(display: ProgressDisplay): Promise<void> {
		const state = await this.load();
		state.displays.push(display);
		await this.ctx.storage.put("state", state);
		if ((await this.ctx.storage.getAlarm()) === null) {
			await this.ctx.storage.setAlarm(Date.now() + UPDATE_INTERVAL_MS);
		}
	}

	override async alarm(): Promise<void> {
		const now = Date.now();
		const next = await refreshDisplays(
			await this.load(),
			{
				db: this.env.DB,
				edit: (display, content, at) =>
					editProgress(this.env, display, content, at),
				enqueueImports: (jobs) => enqueueImports(this.env, jobs),
			},
			now,
		);
		if (next.displays.length === 0) {
			await this.ctx.storage.deleteAll();
			return;
		}
		await this.ctx.storage.put("state", next);
		await this.ctx.storage.setAlarm(now + UPDATE_INTERVAL_MS);
	}

	private async load(): Promise<WatchState> {
		return (
			(await this.ctx.storage.get<WatchState>("state")) ?? {
				displays: [],
				samples: {},
			}
		);
	}
}
