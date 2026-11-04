import { describeError, type KeyCheckResult } from "../llm/types";

/**
 * TypeSafeのAPI(Jev)。仕様: docs/spec/architecture.md「Jevに聞く」。
 * APIの形: https://docs.typesafe.ai/api/system-one 、エラー: https://docs.typesafe.ai/api/errors
 */

const TYPESAFE_API_BASE = "https://api.typesafe.ai/v1";

/** 使うJevのモデル。いつも最新の正式版を指す別名(数値の境目を決めて使うことはないので、版を固定しない) */
export const JEV_MODEL = "jev-latest";

/** Jevへの質問。instructionsとcriteriaは、Jevに渡す文 */
export type JevQuestion =
	| {
			type: "noul";
			instructions: string;
			criteria: { true: string; false: string };
	  }
	| {
			type: "choice";
			instructions: string;
			/** 選択肢の名前と、その説明 */
			criteria: Record<string, string>;
	  }
	| {
			type: "score";
			instructions: string;
			/** 段階の説明。低い段階から順に並べる(並びの番号が、段階の番号になる) */
			criteria: string[];
	  };

/** Jevへのリクエスト。questionsの名前は、答えの名前になる */
export interface JevRequest {
	/** 質問が判断する対象の内容 */
	state: Record<string, unknown>;
	questions: Record<string, JevQuestion>;
}

/** Jevの答え */
export type JevAnswer =
	/** noulは、「はい」の確率(0〜1) */
	| { type: "noul"; noul: number }
	| {
			type: "choice";
			/** 選んだ選択肢の名前 */
			choice: string;
			confidence: number;
			/** 選択肢の名前ごとの確率 */
			probabilities: Record<string, number>;
	  }
	| {
			type: "score";
			/** 確率で重み付けした位置(小数になる) */
			score: number;
			confidence: number;
			/** 段階の番号("0"から)ごとの確率 */
			probabilities: Record<string, number>;
	  };

export interface JevResponse {
	/** 答えたモデルの版(例: jev-1.14.0) */
	model: string;
	/** 質問の名前ごとの答え */
	answers: Record<string, JevAnswer>;
	usage: { inputTokens: number; outputTokens: number };
}

/** Jevの呼び出しの失敗の種類。本人に見せる理由と、AIに直させるかを、これで決める */
export type JevErrorKind =
	| "invalid_key"
	| "rate_limited"
	/** リクエストの形や内容が正しくない(400、422)。AIに直させる */
	| "bad_request"
	/** リクエストが大きすぎる(413)。AIに短くさせる */
	| "too_large"
	| "unavailable"
	| "unknown";

/** Jevの呼び出しの失敗 */
export class JevError extends Error {
	constructor(
		readonly kind: JevErrorKind,
		/** HTTPのステータス。通信の失敗などで分からなければnull */
		readonly status: number | null,
		message: string,
		/**
		 * TypeSafeが返した、失敗の説明(400と422)。リクエストの中身を含みうるので、ログには残さず、AIにだけ渡す。
		 * 通信の失敗のときは、原因の説明(describeErrorで作る。ログに残せる)
		 */
		readonly detail: string | null = null,
	) {
		super(message);
		this.name = "JevError";
	}
}

/** 本人のTypeSafeのキーで、Jevに質問する */
export async function askJev(
	apiKey: string,
	request: JevRequest,
): Promise<JevResponse> {
	let response: Response;
	try {
		response = await fetch(`${TYPESAFE_API_BASE}/systemone`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: JEV_MODEL,
				state: request.state,
				questions: request.questions,
			}),
		});
	} catch (error) {
		throw new JevError(
			"unavailable",
			null,
			"connection failed",
			describeError(error),
		);
	}
	const data: unknown = await response.json().catch(() => null);
	if (!response.ok) {
		const kind = kindFromStatus(response.status);
		throw new JevError(
			kind,
			response.status,
			`TypeSafe error ${response.status}`,
			kind === "bad_request" ? errorDetail(data) : null,
		);
	}
	const parsed = parseResponse(data, request);
	if (parsed === null) {
		throw new JevError(
			"unknown",
			response.status,
			"TypeSafe returned unexpected answers",
		);
	}
	return parsed;
}

/**
 * 登録するときに、TypeSafeのキーが使えるか確かめる。料金のかからない、モデルの一覧のAPIを呼ぶ
 * (https://docs.typesafe.ai/api/list-models)
 */
export async function checkTypeSafeKey(
	apiKey: string,
): Promise<KeyCheckResult> {
	let response: Response;
	try {
		response = await fetch(`${TYPESAFE_API_BASE}/models`, {
			headers: { Authorization: `Bearer ${apiKey}` },
		});
	} catch (error) {
		return { status: "unavailable", detail: describeError(error) };
	}
	if (response.ok) {
		return { status: "valid" };
	}
	if (response.status === 401 || response.status === 403) {
		return { status: "invalid" };
	}
	return {
		status: "unavailable",
		detail: `TypeSafe error ${response.status}`,
	};
}

/** TypeSafeのエラーのステータスを、失敗の種類に分ける */
function kindFromStatus(status: number): JevErrorKind {
	switch (status) {
		case 400:
		case 422:
			return "bad_request";
		case 401:
		case 403:
			return "invalid_key";
		case 413:
			return "too_large";
		case 429:
			return "rate_limited";
		default:
			// 529は、TypeSafeが混み合っている
			return status >= 500 ? "unavailable" : "unknown";
	}
}

/** 失敗の説明(detail)。文ならそのまま、検証の失敗(422)なら、項目ごとの説明をつなげる */
function errorDetail(data: unknown): string | null {
	if (!isRecord(data)) {
		return null;
	}
	const { detail } = data;
	if (typeof detail === "string") {
		return detail.slice(0, 1000);
	}
	if (Array.isArray(detail)) {
		return detail
			.flatMap((item) =>
				isRecord(item) && typeof item.msg === "string"
					? [
							Array.isArray(item.loc)
								? `${item.loc.join(".")}: ${item.msg}`
								: item.msg,
						]
					: [],
			)
			.join("\n")
			.slice(0, 1000);
	}
	return detail === undefined ? null : JSON.stringify(detail).slice(0, 1000);
}

/**
 * 応答を読む。どの質問にも、質問と同じ種類の答えがあることを確かめる。
 * 形が違えば(知らない種類の答えなど)、null
 */
function parseResponse(data: unknown, request: JevRequest): JevResponse | null {
	if (!isRecord(data) || !isRecord(data.answers)) {
		return null;
	}
	const answers: Record<string, JevAnswer> = {};
	for (const [name, question] of Object.entries(request.questions)) {
		const answer = parseAnswer(data.answers[name], question.type);
		if (answer === null) {
			return null;
		}
		answers[name] = answer;
	}
	const usage = isRecord(data.usage) ? data.usage : {};
	return {
		model: typeof data.model === "string" ? data.model : JEV_MODEL,
		answers,
		usage: {
			inputTokens: numberOr(usage.input_tokens, 0),
			outputTokens: numberOr(usage.output_tokens, 0),
		},
	};
}

function parseAnswer(
	value: unknown,
	type: JevQuestion["type"],
): JevAnswer | null {
	if (!isRecord(value) || value.type !== type) {
		return null;
	}
	switch (type) {
		case "noul":
			return isProbability(value.noul)
				? { type: "noul", noul: value.noul }
				: null;
		case "choice":
			return typeof value.choice === "string" &&
				isProbabilities(value.probabilities)
				? {
						type: "choice",
						choice: value.choice,
						confidence: numberOr(value.confidence, 0),
						probabilities: value.probabilities,
					}
				: null;
		case "score":
			return typeof value.score === "number" &&
				Number.isFinite(value.score) &&
				isProbabilities(value.probabilities)
				? {
						type: "score",
						score: value.score,
						confidence: numberOr(value.confidence, 0),
						probabilities: value.probabilities,
					}
				: null;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProbability(value: unknown): value is number {
	return typeof value === "number" && value >= 0 && value <= 1;
}

function isProbabilities(value: unknown): value is Record<string, number> {
	return isRecord(value) && Object.values(value).every(isProbability);
}

function numberOr(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
